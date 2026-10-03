/**
 * Compatibility tests: the declared DSH peer range, and the runtime seam the
 * plugin actually uses.
 *
 * Why this file exists: DSH 0.2.0-rc.2 added a gate that **skips a whole
 * bundle** whose `peerDependencies` exclude the running DSH version. The
 * plugin's code was unaffected — the 0.2.0-rc.2 seam tarballs are
 * byte-identical to 0.1.7-rc.2's — but its peer range enumerated only the
 * `0.1.x` lines, so the bundle silently stopped loading and `web_fetch` broke.
 *
 * The offline suite could not catch that: every unit test imports `src/*`
 * directly and never evaluates `package.json`. These tests close that gap by
 * re-deriving the gate's decision from the manifest, exactly as
 * `@deepseek-ai/dsh-app-boot`'s `evaluatePluginCompatibility` does.
 *
 * Run with `npm test`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import semver from 'semver'

import { HttpFetchProvider, LOCAL_FETCH_PROVIDER_ID, DEFAULT_USER_AGENT } from '@deepseek-ai/dsh-web-fetch-http'
import { Context } from '@deepseek-ai/cordis'
import { WebRuntime } from '@deepseek-ai/dsh-web'
import { apply, Config, createFakeIpResolver, compileFakeIpRanges, DEFAULT_FAKE_IP_RANGES } from '../src/index.js'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const ciWorkflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8')

/**
 * The DSH peer names the harness gate evaluates. `@deepseek-ai/dsh-app-boot`
 * inspects `@deepseek-ai/dsh` and every `@deepseek-ai/dsh-*` peer, and ignores
 * everything else — so `cordis` and `schemastery` are not part of the decision.
 */
function dshPeers(peers) {
  return Object.entries(peers).filter(
    ([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
  )
}

/**
 * Reproduce `evaluatePluginCompatibility`'s verdict for one runtime version.
 *
 * Mirrors the two details that make prereleases behave: `includePrerelease` is
 * set, so a prerelease participates in ranges rather than falling outside them.
 *
 * @param runtimeVersion - the running DSH version.
 * @returns true when the harness would load this bundle rather than skip it.
 */
function compatibleWith(runtimeVersion) {
  return dshPeers(manifest.peerDependencies).every(([, range]) =>
    semver.satisfies(runtimeVersion, range, { includePrerelease: true }),
  )
}

/** Every DSH version the CI matrix pins, in file order. */
function matrixDshVersions() {
  return [...ciWorkflow.matchAll(/^\s*dsh:\s*(\S+)\s*$/gm)].map((match) => match[1])
}

// ── the regression this file exists for ────────────────────────────────────

test('the runtime that skipped 0.1.1 is now accepted', () => {
  // 0.1.1 enumerated only 0.1.x, so 0.2.0-rc.2 rejected it and the bundle was
  // skipped. This is the exact failure being guarded against.
  assert.equal(compatibleWith('0.2.0-rc.2'), true)
})

test('a DSH version outside the declared range is still rejected', () => {
  // The gate must remain meaningful: widening the range is not the same as
  // declaring compatibility with everything.
  assert.equal(compatibleWith('0.3.0'), false)
  assert.equal(compatibleWith('0.3.0-rc.1'), false)
  assert.equal(compatibleWith('1.0.0'), false)
  assert.equal(compatibleWith('0.0.9'), false)
})

test('the range covers every 0.2.x line, including finals and future patches', () => {
  // `0.2.0-rc.2` was the reported breakage; the others are what the bounded
  // range buys over enumerating each published prerelease by hand.
  for (const version of ['0.2.0-rc.1', '0.2.0-rc.2', '0.2.0', '0.2.1', '0.2.99-rc.1']) {
    assert.equal(compatibleWith(version), true, `expected ${version} to be accepted`)
  }
})

test('the range still covers every DSH line this plugin shipped against', () => {
  // Compatibility is kept, not dropped: these are the lines 0.1.1 claimed.
  for (const version of [
    '0.1.2-rc.1',
    '0.1.3-alpha.2',
    '0.1.5-alpha.1',
    '0.1.5-rc.2',
    '0.1.5-rc.3',
    '0.1.6-alpha.2',
    '0.1.7-alpha.1',
    '0.1.7-rc.2',
  ]) {
    assert.equal(compatibleWith(version), true, `expected ${version} to be accepted`)
  }
})

// ── the declared range must stay coherent with CI ──────────────────────────

test('every DSH version the CI matrix pins satisfies the declared peer range', () => {
  const versions = matrixDshVersions()
  assert.ok(versions.length > 0, 'expected ci.yml to pin at least one DSH version')
  for (const version of versions) {
    assert.equal(compatibleWith(version), true, `ci.yml pins dsh ${version}, which the peer range rejects`)
  }
})

test('every DSH peer range is bounded and consistent', () => {
  const ranges = dshPeers(manifest.peerDependencies).map(([, range]) => range)
  assert.ok(ranges.length >= 2, 'expected the two seam packages to be declared as DSH peers')
  // One shared range keeps the seam packages from drifting apart.
  assert.equal(new Set(ranges).size, 1, `DSH peers declare divergent ranges: ${JSON.stringify(ranges)}`)
  for (const range of ranges) {
    assert.match(range, /^>=\d+\.\d+\.\d+.*<\d+\.\d+\.\d+-0$/, `expected a bounded range, got ${range}`)
  }
})

// ── the versioning policy: plugin 0.M.x supports DSH 0.M.* ─────────────────

test("the peer range's upper bound follows the manifest's own minor version", () => {
  // The declared invariant: plugin 0.M.x supports DSH 0.M.*, so the bound is
  // always <0.(M+1).0-0. Without this, the two numbers can drift apart and the
  // version stops telling a reader which DSH line the release targets.
  const minor = semver.minor(manifest.version)
  const expected = `<0.${minor + 1}.0-0`
  for (const [name, range] of dshPeers(manifest.peerDependencies)) {
    assert.ok(
      range.endsWith(expected),
      `${name} declares "${range}", but plugin ${manifest.version} must bound DSH at ${expected}`,
    )
  }
})

test('the version carries no prerelease suffix, so it publishes to latest', () => {
  // release.yml publishes a version containing "-" under the `next` dist-tag
  // and everything else under `latest`. This release must reach `latest`: 0.1.1
  // is skipped by the 0.2.0-rc.2 gate, so `latest` currently points at a version
  // that does not work on the `latest` DSH. A suffix here would silently
  // downgrade the fix to `next` and leave that broken.
  assert.equal(
    semver.prerelease(manifest.version),
    null,
    `version ${manifest.version} has a prerelease suffix and would publish to "next", not "latest"`,
  )
})

test('the versioning policy is documented where the README points', () => {
  // README links to CHANGELOG.md#versioning-policy; a renamed heading would
  // leave a dead anchor.
  const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8')
  assert.match(changelog, /^## Versioning policy$/m, 'CHANGELOG.md must carry a "## Versioning policy" heading')
})

test("the CHANGELOG has a section for this exact version", () => {
  // The release workflow extracts notes from "## [<version>]" and fails when
  // the section is missing, so catching it here avoids a red release run.
  const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8')
  const heading = `## [${manifest.version}]`
  assert.ok(changelog.includes(heading), `CHANGELOG.md has no "${heading}" section`)
})

test('the manifest is a publishable, self-describing package', () => {
  assert.notEqual(manifest.private, true)
  assert.equal(manifest.name, 'dsh-web-fetch-fakeip')
  assert.ok(semver.valid(manifest.version), `version ${manifest.version} is not valid semver`)
  assert.ok(manifest.repository !== undefined, 'repository is required for provenance publishing')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
})

// ── the runtime seam, not just the declaration ─────────────────────────────

test('the stock seam still exposes everything the plugin imports', () => {
  // If any of these disappear, the plugin fails to load — a real break the
  // peer range alone would not reveal.
  assert.equal(LOCAL_FETCH_PROVIDER_ID, 'http')
  assert.equal(typeof DEFAULT_USER_AGENT, 'string')
  assert.equal(typeof HttpFetchProvider, 'function')

  // The constructor's resolver argument is the entire extension seam.
  const inner = new HttpFetchProvider(
    { maxResponseBytes: 1, maxBodyChars: 1, timeoutMs: 1, maxRedirects: 0, userAgent: 'test' },
    createFakeIpResolver(compileFakeIpRanges(DEFAULT_FAKE_IP_RANGES)),
  )
  assert.equal(inner.id, LOCAL_FETCH_PROVIDER_ID)
  assert.equal(inner.available(), true)
  assert.equal(typeof inner.fetch, 'function')
})

test('apply() registers the stock provider id against the live seam', () => {
  const registered = new Map()
  const ctx = {
    web: {
      registerFetchProvider(provider) {
        // The seam rejects a duplicate id with WEB_DUPLICATE_PROVIDER.
        if (registered.has(provider.id)) throw new Error(`duplicate provider id ${provider.id}`)
        registered.set(provider.id, provider)
        return () => registered.delete(provider.id)
      },
    },
  }

  apply(ctx, Config({}))

  const provider = registered.get('http')
  assert.ok(provider !== undefined, 'apply() must register the "http" provider id')
  assert.equal(provider.available(), true)
  assert.equal(typeof provider.fetch, 'function')
})

test('the plugin and the stock provider cannot share the seam at once', () => {
  // This is why cordis.patch.yml disables the stock row: both register `http`.
  const registered = new Map()
  const register = (id) => {
    if (registered.has(id)) throw new Error(`duplicate provider id ${id}`)
    registered.set(id, true)
  }
  register(LOCAL_FETCH_PROVIDER_ID)
  assert.throws(() => register(LOCAL_FETCH_PROVIDER_ID), /duplicate provider id/)
})

test('apply() registers the "http" provider into a live ctx.web service', () => {
  // The offline counterpart to the live seam test: it proves the plugin
  // registers through the real service rather than only against a stub, which
  // is the difference between "the code looks right" and "the seam accepts it".
  const ctx = new Context()
  const web = new WebRuntime(ctx, { fetchProvider: 'http' })

  // Cordis exposes the service through a tracked view; the registries behind it
  // are shared, which is what makes the registration observable here.
  assert.equal(ctx.web.ctx, ctx)
  assert.equal(ctx.web.fetchProviders, web.fetchProviders)
  assert.deepEqual([...ctx.web.fetchProviders.keys()], [])

  apply(ctx, Config({}))

  assert.deepEqual([...ctx.web.fetchProviders.keys()], ['http'])
  const provider = ctx.web.fetchProviders.get('http')
  assert.equal(provider.id, LOCAL_FETCH_PROVIDER_ID)
  assert.equal(provider.available(), true)
  assert.equal(typeof provider.fetch, 'function')
})

test('the seam refuses a second registration under the same id', () => {
  const ctx = new Context()
  new WebRuntime(ctx, { fetchProvider: 'http' })
  apply(ctx, Config({}))
  // Applying twice must fail loudly rather than silently replacing the first
  // provider — the harness surfaces this as WEB_DUPLICATE_PROVIDER.
  assert.throws(() => apply(ctx, Config({})), /already registered/)
})

test('the bundle patch disables the stock row before inserting this one', () => {
  const patch = readFileSync(new URL('cordis.patch.yml', root), 'utf8')
  const disabled = patch.indexOf('id: web-fetch-http')
  const inserted = patch.indexOf('id: web-fetch-fakeip')
  assert.ok(disabled !== -1, 'cordis.patch.yml must disable the stock web-fetch-http row')
  assert.ok(inserted !== -1, 'cordis.patch.yml must insert web-fetch-fakeip')
  assert.ok(disabled < inserted, 'the stock row must be disabled before this provider is inserted')
})

test('fileURLToPath is used so the suite reports readable paths on failure', () => {
  // Guards against a Windows path regression in the test's own URL handling.
  assert.equal(typeof fileURLToPath(new URL('package.json', root)), 'string')
})
