#!/usr/bin/env node
/**
 * Release control for the tag-driven publish workflow.
 *
 * Split into subcommands so the workflow can gate each step on the previous
 * one, and so a failed run can be re-run safely:
 *
 *   validate <tag>          tag format and package.json version agree
 *   check <tag>             is this exact version already on npm? (idempotency)
 *   notes <tag> <outfile>   write this version's CHANGELOG section to a file
 *   release <tag> <notes>   create or update the matching GitHub Release
 *
 * `check` is what makes the workflow re-runnable: a tag whose version already
 * exists on npm is treated as success, so re-running a partially failed
 * release never attempts a duplicate publish (which npm would reject with a
 * 403, leaving the workflow red for no real reason).
 *
 * The GitHub Release is deliberately created only AFTER npm confirms the
 * version is live, so a Release page never announces a version that cannot
 * be installed yet.
 *
 * @module dsh-web-fetch-fakeip/release-control
 */

import { appendFile, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'

const exec = promisify(execFile)
const REGISTRY = 'https://registry.npmjs.org'

/** A release tag is exactly `v` followed by a semver triple. */
const TAG_PATTERN = /^v\d+\.\d+\.\d+$/

/**
 * Read one exact version from the registry.
 *
 * Only a 404 means "not published"; every other failure is surfaced rather
 * than swallowed, so a registry outage cannot be mistaken for a green field
 * and cause a duplicate publish attempt.
 *
 * @param expected - `{ name, version }` to look up.
 * @param fetcher - fetch implementation (injected by tests).
 * @param signal - request timeout.
 * @returns the registry document, or `null` when the version does not exist.
 */
export async function readPublishedVersion(expected, fetcher = fetch, signal = AbortSignal.timeout(15_000)) {
  const response = await fetcher(
    `${REGISTRY}/${encodeURIComponent(expected.name)}/${encodeURIComponent(expected.version)}`,
    { signal },
  )
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`npm registry lookup failed: HTTP ${response.status}`)
  const value = await response.json()
  if (value?.name !== expected.name || value?.version !== expected.version) {
    throw new Error('npm returned a different name or version than requested')
  }
  return value
}

/** Poll until `check` returns non-null, or the deadline passes. */
async function waitFor(check, message, { timeoutMs = 120_000, now = Date.now, sleep = pause } = {}) {
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    const remaining = deadline - now()
    if (remaining <= 0) break
    const signal = AbortSignal.timeout(Math.min(15_000, remaining))
    const value = await check(signal)
    if (value !== null) return value
    const rest = deadline - now()
    if (rest > 0) await sleep(Math.min(5_000, rest))
  }
  throw new Error(message)
}

/**
 * Wait for a just-published version to become visible.
 *
 * The registry is eventually consistent across its CDN, so an immediate read
 * after `npm publish` can still 404.
 *
 * @param expected - `{ name, version }` to wait for.
 * @param options - timing overrides and an injected fetcher.
 * @returns the registry document once visible.
 */
export function waitForPublication(expected, { fetcher = fetch, ...timing } = {}) {
  return waitFor(
    (signal) => readPublishedVersion(expected, fetcher, signal),
    'the published version never became queryable on npm',
    timing,
  )
}

/**
 * Extract one version's section from CHANGELOG.md.
 *
 * Stops at the next same-level heading or at the trailing link-definition
 * block, so the reference links at the bottom of the file do not leak into
 * release notes.
 *
 * @param markdown - the full CHANGELOG text.
 * @param version - the bare version, e.g. `0.1.0`.
 * @returns the section body, or `undefined` when the version has no section.
 */
export function extractChangelogSection(markdown, version) {
  const lines = markdown.split(/\r?\n/)
  const heading = new RegExp(`^##\\s+\\[?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`)
  const start = lines.findIndex((line) => heading.test(line))
  if (start === -1) return undefined
  const body = []
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]
    if (/^##\s/.test(line)) break
    if (/^\[[^\]]+\]:\s/.test(line)) break
    body.push(line)
  }
  const section = body.join('\n').trim()
  return section.length > 0 ? section : undefined
}

/** Run a `gh` command, returning stdout. */
async function gh(args) {
  const { stdout } = await exec('gh', args, { maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

/**
 * Create or update the GitHub Release for a tag.
 *
 * Idempotent by design: an existing Release for the tag is edited rather than
 * created, so a re-run after a partial failure converges instead of erroring.
 *
 * @param repo - `owner/name`.
 * @param tag - the release tag.
 * @param notesFile - path to the markdown notes.
 * @param run - command runner (injected by tests).
 */
export async function syncGithubRelease(repo, tag, notesFile, run = gh) {
  const pages = JSON.parse(await run(['api', `repos/${repo}/releases?per_page=100`, '--paginate', '--slurp']))
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('unexpected GitHub Releases response shape')
  const exists = pages.flat().some((release) => release.tag_name === tag)
  const args = ['release', exists ? 'edit' : 'create', tag, '--repo', repo, '--title', tag, '--notes-file', notesFile]
  if (!exists) args.push('--verify-tag', '--latest')
  await run(args)
  return exists ? 'updated' : 'created'
}

/** The entry point used by the workflow. */
async function main() {
  const [mode, tag, extra] = process.argv.slice(2)
  if (!['validate', 'check', 'notes', 'release'].includes(mode)) {
    throw new Error('usage: release-control.mjs <validate|check|notes|release> <tag> [path]')
  }

  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
  const expectedTag = `v${manifest.version}`

  if (!TAG_PATTERN.test(tag ?? '')) throw new Error(`tag ${JSON.stringify(tag)} is not of the form vX.Y.Z`)
  if (tag !== expectedTag) {
    throw new Error(`tag ${tag} does not match package.json version ${manifest.version} (expected ${expectedTag})`)
  }

  if (mode === 'validate') {
    // Provenance publishing is rejected with E422 without a repository field,
    // so fail here rather than mid-publish.
    if (manifest.repository === undefined) throw new Error('package.json has no "repository" field; provenance publishing would fail with E422')
    if (manifest.private === true) throw new Error('package.json sets "private": true; npm would refuse to publish it')
    console.log(`validate: ${tag} matches package.json ${manifest.version}`)
    return
  }

  const expected = { name: manifest.name, version: manifest.version }

  if (mode === 'check') {
    const published = (await readPublishedVersion(expected)) !== null
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `published=${published}\n`)
    console.log(`published=${published}`)
    return
  }

  if (mode === 'notes') {
    if (extra === undefined) throw new Error('notes requires an output path')
    const section = extractChangelogSection(await readFile('CHANGELOG.md', 'utf8'), manifest.version)
    if (section === undefined) {
      throw new Error(`CHANGELOG.md has no "## [${manifest.version}]" section; add one before releasing`)
    }
    const { writeFile } = await import('node:fs/promises')
    await writeFile(extra, `${section}\n`, 'utf8')
    console.log(`notes: wrote ${section.split('\n').length} lines to ${extra}`)
    return
  }

  // mode === 'release'
  if (extra === undefined) throw new Error('release requires a notes path')
  if (!process.env.GITHUB_REPOSITORY) throw new Error('GITHUB_REPOSITORY is not set')
  await waitForPublication(expected)
  const action = await syncGithubRelease(process.env.GITHUB_REPOSITORY, tag, extra)
  console.log(`release: ${action} GitHub Release ${tag}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
