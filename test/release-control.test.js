/**
 * Unit tests for the release-control helpers: the tag/version gate, the
 * idempotency check, and CHANGELOG section extraction.
 *
 * The publish workflow's safety rests on these, and they run offline — no
 * registry, no `gh`, no network. The registry and `gh` calls are injected.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  extractChangelogSection,
  readPublishedVersion,
  syncGithubRelease,
  waitForPublication,
} from '../scripts/release-control.mjs'

/** A fetch stub returning one canned response. */
function stubFetch(status, body) {
  return async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  })
}

const EXPECTED = { name: 'dsh-web-fetch-fakeip', version: '0.1.0' }

// ── registry lookup ────────────────────────────────────────────────────────

test('a 404 means the version is not published', async () => {
  assert.equal(await readPublishedVersion(EXPECTED, stubFetch(404)), null)
})

test('a matching document is returned', async () => {
  const doc = { name: EXPECTED.name, version: EXPECTED.version }
  assert.deepEqual(await readPublishedVersion(EXPECTED, stubFetch(200, doc)), doc)
})

test('any non-404 failure is surfaced, never read as "not published"', async () => {
  // A registry outage must not look like a green field, or the workflow would
  // attempt a duplicate publish.
  await assert.rejects(readPublishedVersion(EXPECTED, stubFetch(500)), /HTTP 500/)
  await assert.rejects(readPublishedVersion(EXPECTED, stubFetch(429)), /HTTP 429/)
})

test('a name or version mismatch is rejected', async () => {
  await assert.rejects(
    readPublishedVersion(EXPECTED, stubFetch(200, { name: 'something-else', version: '0.1.0' })),
    /different name or version/,
  )
  await assert.rejects(
    readPublishedVersion(EXPECTED, stubFetch(200, { name: EXPECTED.name, version: '9.9.9' })),
    /different name or version/,
  )
})

test('waitForPublication returns as soon as the version appears', async () => {
  let calls = 0
  const fetcher = async () => {
    calls += 1
    if (calls < 3) return { status: 404, ok: false, json: async () => ({}) }
    return { status: 200, ok: true, json: async () => ({ name: EXPECTED.name, version: EXPECTED.version }) }
  }
  const doc = await waitForPublication(EXPECTED, { fetcher, timeoutMs: 5_000, sleep: async () => {} })
  assert.equal(doc.version, '0.1.0')
  assert.equal(calls, 3)
})

test('waitForPublication fails once the deadline passes', async () => {
  await assert.rejects(
    waitForPublication(EXPECTED, { fetcher: stubFetch(404), timeoutMs: 50, sleep: async () => {} }),
    /never became queryable/,
  )
})

// ── CHANGELOG extraction ───────────────────────────────────────────────────

const CHANGELOG = `# Changelog

Intro prose.

## [Unreleased]

- something pending

## [1.0.0] - 2026-09-19

### Added

- the first release

### Fixed

- a bug

## [0.9.0] - 2026-09-01

- older

[Unreleased]: https://example.invalid/compare/v1.0.0...HEAD
[1.0.0]: https://example.invalid/releases/tag/v1.0.0
`

test('extractChangelogSection returns exactly one version section', () => {
  const section = extractChangelogSection(CHANGELOG, '1.0.0')
  assert.match(section, /the first release/)
  assert.match(section, /a bug/)
  // Must not bleed into the neighbouring version, the Unreleased section, or
  // the trailing link definitions.
  assert.doesNotMatch(section, /older/)
  assert.doesNotMatch(section, /pending/)
  assert.doesNotMatch(section, /example\.invalid/)
})

test('extractChangelogSection matches a heading without brackets', () => {
  const plain = '## 2.0.0\n\n- released\n\n## 1.0.0\n\n- old\n'
  assert.match(extractChangelogSection(plain, '2.0.0'), /released/)
})

test('extractChangelogSection returns undefined for a version with no section', () => {
  assert.equal(extractChangelogSection(CHANGELOG, '3.0.0'), undefined)
})

test('extractChangelogSection does not treat 1.0.0 as a prefix of 1.0.01', () => {
  const tricky = '## [1.0.01]\n\n- not this one\n\n## [1.0.0]\n\n- this one\n'
  assert.match(extractChangelogSection(tricky, '1.0.0'), /this one/)
})

test('extractChangelogSection handles an empty section as absent', () => {
  assert.equal(extractChangelogSection('## [1.0.0]\n\n## [0.9.0]\n\n- x\n', '1.0.0'), undefined)
})

// ── GitHub Release reconciliation ──────────────────────────────────────────

/** A `gh` stub that records the arguments it was called with. */
function stubGh(pages) {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    if (args[0] === 'api') return JSON.stringify(pages)
    return ''
  }
  return { run, calls }
}

test('syncGithubRelease creates a Release that does not exist yet', async () => {
  const { run, calls } = stubGh([[]])
  const action = await syncGithubRelease('kaminn/dsh-web-fetch-fakeip', 'v1.0.0', '/tmp/notes.md', run)
  assert.equal(action, 'created')
  const create = calls.find((args) => args[0] === 'release')
  assert.equal(create[1], 'create')
  assert.ok(create.includes('--verify-tag'))
  assert.ok(create.includes('--latest'))
})

test('syncGithubRelease edits an existing Release instead of failing', async () => {
  // This is what makes a re-run after a partial failure converge.
  const { run, calls } = stubGh([[{ tag_name: 'v1.0.0' }]])
  const action = await syncGithubRelease('kaminn/dsh-web-fetch-fakeip', 'v1.0.0', '/tmp/notes.md', run)
  assert.equal(action, 'updated')
  const edit = calls.find((args) => args[0] === 'release')
  assert.equal(edit[1], 'edit')
  assert.ok(!edit.includes('--verify-tag'))
})

test('syncGithubRelease finds a Release on a later page', async () => {
  const { run } = stubGh([[{ tag_name: 'v0.9.0' }], [{ tag_name: 'v1.0.0' }]])
  assert.equal(await syncGithubRelease('kaminn/dsh-web-fetch-fakeip', 'v1.0.0', '/tmp/notes.md', run), 'updated')
})

test('syncGithubRelease rejects an unexpected API shape', async () => {
  const run = async (args) => (args[0] === 'api' ? JSON.stringify({ message: 'Not Found' }) : '')
  await assert.rejects(
    syncGithubRelease('kaminn/dsh-web-fetch-fakeip', 'v1.0.0', '/tmp/notes.md', run),
    /unexpected GitHub Releases response shape/,
  )
})
