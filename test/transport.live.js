/**
 * Opt-in live tests: exercise the real transport against the network.
 *
 * These are excluded from `npm test` (they need working DNS and egress) and
 * run with `npm run test:live`.
 *
 * They assert two things at once, which is the whole point of the plugin:
 *
 * 1. a real hostname fetches successfully **even though** it resolves to a
 *    fake-ip placeholder — i.e. the plugin fixed the reported failure;
 * 2. every private, loopback and link-local destination is **still** refused —
 *    i.e. the SSRF protection was not traded away for the fix.
 *
 * The first group is skipped automatically when the machine is not running
 * fake-ip DNS, so the suite is meaningful on any host.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lookup } from 'node:dns/promises'

import { Config } from '../src/config.js'
import { compileFakeIpRanges, createFakeIpResolver } from '../src/resolver.js'
import { HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'

/** Build the provider exactly as `apply()` does, without a Cordis context. */
function buildProvider(config = Config({})) {
  const ranges = compileFakeIpRanges(config.fakeIpRanges)
  const inner = new HttpFetchProvider(
    {
      maxResponseBytes: config.maxResponseBytes,
      maxBodyChars: config.maxBodyChars,
      timeoutMs: config.timeoutMs,
      maxRedirects: config.maxRedirects,
      userAgent: config.userAgent,
    },
    createFakeIpResolver(ranges),
  )
  return {
    id: 'http',
    available: () => true,
    fetch: (request, signal) => inner.fetch(request, signal),
  }
}

/** Whether this machine's DNS is currently answering with fake-ip placeholders. */
async function isFakeIpEnvironment() {
  try {
    const answers = await lookup('example.com', { all: true, order: 'verbatim' })
    const ranges = compileFakeIpRanges(Config({}).fakeIpRanges)
    const { isFakeIpAddress } = await import('../src/resolver.js')
    return answers.length > 0 && answers.every((entry) => isFakeIpAddress(entry.address, ranges))
  } catch {
    return false
  }
}

const provider = buildProvider()
const live = await isFakeIpEnvironment()

test('environment probe: fake-ip DNS detected', { skip: !live ? 'not a fake-ip environment; live fetch assertions skipped' : false }, async () => {
  const answers = await lookup('example.com', { all: true, order: 'verbatim' })
  console.log(`    example.com -> ${answers.map((entry) => entry.address).join(', ')}`)
  assert.ok(answers.length > 0)
})

test('a real hostname fetches successfully under fake-ip DNS', { skip: !live ? 'not a fake-ip environment' : false }, async () => {
  const result = await provider.fetch({ url: 'https://example.com/' }, AbortSignal.timeout(30_000))
  assert.equal(result.statusCode, 200)
  assert.equal(result.body.kind, 'html')
  assert.match(result.body.content, /Example Domain/)
})

test('a JSON endpoint is classified as text and decoded', { skip: !live ? 'not a fake-ip environment' : false }, async () => {
  const result = await provider.fetch(
    { url: 'https://api.github.com/repos/microsoft/vscode' },
    AbortSignal.timeout(30_000),
  )
  // `application/json` must classify as `text` whatever the status: the
  // classification is what this test owns, not the origin's rate limiting.
  assert.equal(result.body.kind, 'text')
  assert.ok(result.body.content.length > 0)
  if (result.statusCode === 200) assert.match(result.body.content, /"full_name"/)
  else assert.ok(result.statusCode >= 400, `unexpected status ${result.statusCode}`)
})

test('a non-2xx response resolves as a result, not an error', { skip: !live ? 'not a fake-ip environment' : false }, async () => {
  // The contract under test is "a non-2xx response is a result, not a throw".
  // The exact status is the origin's business and must not be asserted: GitHub
  // answers 404 for an unknown repo but 403 once the unauthenticated rate limit
  // trips, and either proves the contract. Assert the shape instead.
  const result = await provider.fetch(
    { url: 'https://api.github.com/repos/microsoft/definitely-not-a-real-repo-xyz' },
    AbortSignal.timeout(30_000),
  )
  assert.ok(result.statusCode >= 400, `expected a 4xx/5xx result, got ${result.statusCode}`)
  assert.equal(typeof result.body.content, 'string')
  assert.equal(typeof result.truncated, 'boolean')
  assert.equal(typeof result.url, 'string')
})

// ── the guarantee, verified against the live transport ─────────────────────

test('private, loopback and link-local destinations stay blocked', async () => {
  const blocked = [
    'http://127.0.0.1:8080/',
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://localhost:8080/',
  ]
  for (const url of blocked) {
    await assert.rejects(
      provider.fetch({ url }, AbortSignal.timeout(10_000)),
      (error) => {
        assert.match(String(error.message), /non-public IP address/, `expected ${url} to be blocked`)
        return true
      },
    )
  }
})

test('a literal inside the placeholder block is blocked too', async () => {
  await assert.rejects(
    provider.fetch({ url: 'http://198.18.0.100/' }, AbortSignal.timeout(10_000)),
    /non-public IP address/,
  )
})

test('a non-http scheme is rejected before any network use', async () => {
  await assert.rejects(
    provider.fetch({ url: 'ftp://example.com/' }, AbortSignal.timeout(10_000)),
    /unsupported URL scheme/,
  )
})

test('a URL carrying credentials is rejected', async () => {
  await assert.rejects(
    provider.fetch({ url: 'https://user:pass@example.com/' }, AbortSignal.timeout(10_000)),
    /credentials in URLs are not allowed/,
  )
})

test('a cross-origin redirect is not followed automatically', { skip: !live ? 'not a fake-ip environment' : false }, async () => {
  await assert.rejects(
    provider.fetch({ url: 'https://1.1.1.1/' }, AbortSignal.timeout(20_000)),
    /cross-origin redirect/,
  )
})
