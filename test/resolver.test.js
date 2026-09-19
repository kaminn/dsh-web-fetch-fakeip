/**
 * Offline unit tests: destination policy, fake-ip range handling, and config
 * validation. No network access and no DNS — the resolver is injected.
 *
 * Run with `npm test`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  compileFakeIpRanges,
  createFakeIpResolver,
  isFakeIpAddress,
  isPublicIpAddress,
  stripIpv6Brackets,
} from '../src/resolver.js'
import {
  Config,
  DEFAULT_FAKE_IP_RANGES,
  assertValidConfig,
  toLimits,
} from '../src/config.js'

/** A resolver stub returning one fixed answer set. */
function answers(list) {
  return async () => list
}

/** A resolver stub that fails, to prove the error path is not taken. */
function exploding() {
  return async () => {
    throw new Error('resolver must not be consulted for an IP literal')
  }
}

const RANGES = compileFakeIpRanges(DEFAULT_FAKE_IP_RANGES)

// ── classification ─────────────────────────────────────────────────────────

test('isPublicIpAddress accepts public unicast and rejects reserved ranges', () => {
  // Public.
  assert.equal(isPublicIpAddress('1.1.1.1'), true)
  assert.equal(isPublicIpAddress('93.184.216.34'), true)
  assert.equal(isPublicIpAddress('2606:4700:4700::1111'), true)

  // The block this plugin exists for: RFC 2544 benchmarking, where fake-ip lives.
  assert.equal(isPublicIpAddress('198.18.0.100'), false)
  assert.equal(isPublicIpAddress('198.18.0.1'), false)
  assert.equal(isPublicIpAddress('198.19.255.254'), false)

  // Other non-public destinations must stay rejected.
  assert.equal(isPublicIpAddress('127.0.0.1'), false)
  assert.equal(isPublicIpAddress('10.0.0.1'), false)
  assert.equal(isPublicIpAddress('192.168.1.1'), false)
  assert.equal(isPublicIpAddress('172.16.0.1'), false)
  assert.equal(isPublicIpAddress('169.254.169.254'), false)
  assert.equal(isPublicIpAddress('0.0.0.0'), false)
  assert.equal(isPublicIpAddress('::1'), false)
  assert.equal(isPublicIpAddress('fe80::1'), false)
  assert.equal(isPublicIpAddress('not-an-address'), false)
})

test('an IPv4-mapped IPv6 address is classified by its embedded IPv4 address', () => {
  assert.equal(isPublicIpAddress('::ffff:1.1.1.1'), true)
  assert.equal(isPublicIpAddress('::ffff:198.18.0.100'), false)
  assert.equal(isPublicIpAddress('::ffff:127.0.0.1'), false)
})

test('isFakeIpAddress matches only the configured placeholder block', () => {
  assert.equal(isFakeIpAddress('198.18.0.100', RANGES), true)
  assert.equal(isFakeIpAddress('198.19.0.1', RANGES), true)

  // Just outside the /15 block.
  assert.equal(isFakeIpAddress('198.20.0.1', RANGES), false)
  assert.equal(isFakeIpAddress('198.17.255.255', RANGES), false)

  // A public address is never a placeholder, even when it looks similar.
  assert.equal(isFakeIpAddress('1.1.1.1', RANGES), false)
  assert.equal(isFakeIpAddress('127.0.0.1', RANGES), false)
  assert.equal(isFakeIpAddress('garbage', RANGES), false)
})

test('stripIpv6Brackets removes brackets only when both are present', () => {
  assert.equal(stripIpv6Brackets('[::1]'), '::1')
  assert.equal(stripIpv6Brackets('::1'), '::1')
  assert.equal(stripIpv6Brackets('[::1'), '[::1')
  assert.equal(stripIpv6Brackets('example.com'), 'example.com')
})

test('compileFakeIpRanges rejects a malformed CIDR loudly', () => {
  assert.throws(
    () => compileFakeIpRanges(['not-a-cidr']),
    /is not a valid CIDR block/,
  )
  assert.throws(() => compileFakeIpRanges(['198.18.0.0']), /is not a valid CIDR block/)
})

test('a custom range is honoured', () => {
  const custom = compileFakeIpRanges(['10.18.0.0/16'])
  assert.equal(isFakeIpAddress('10.18.1.1', custom), true)
  assert.equal(isFakeIpAddress('198.18.0.100', custom), false)
})

// ── the resolver decision ──────────────────────────────────────────────────

test('an all-fake-ip answer set is accepted and passed through unchanged', async () => {
  const resolve = createFakeIpResolver(RANGES, answers([
    { address: '198.18.0.100', family: 4 },
  ]))
  assert.deepEqual(await resolve('example.com', undefined), [
    { address: '198.18.0.100', family: 4 },
  ])
})

test('an all-fake-ip answer set is accepted for IPv6 placeholders too', async () => {
  const v6 = compileFakeIpRanges(['fc00::/7'])
  const resolve = createFakeIpResolver(v6, answers([
    { address: 'fc00::1', family: 6 },
  ]))
  assert.deepEqual(await resolve('example.com', undefined), [
    { address: 'fc00::1', family: 6 },
  ])
})

test('a public answer set is accepted unchanged', async () => {
  const resolve = createFakeIpResolver(RANGES, answers([
    { address: '93.184.216.34', family: 4 },
  ]))
  assert.deepEqual(await resolve('example.com', undefined), [
    { address: '93.184.216.34', family: 4 },
  ])
})

test('a private answer set is still refused with WEB_BLOCKED_URL', async () => {
  const resolve = createFakeIpResolver(RANGES, answers([
    { address: '10.0.0.1', family: 4 },
  ]))
  await assert.rejects(resolve('internal.example', undefined), (error) => {
    assert.equal(error.code, 'WEB_BLOCKED_URL')
    assert.match(error.message, /resolves to a non-public IP address/)
    return true
  })
})

test('a mixed placeholder + private answer set is refused, not partly accepted', async () => {
  const resolve = createFakeIpResolver(RANGES, answers([
    { address: '198.18.0.100', family: 4 },
    { address: '10.0.0.1', family: 4 },
  ]))
  await assert.rejects(resolve('example.com', undefined), (error) => {
    assert.equal(error.code, 'WEB_BLOCKED_URL')
    return true
  })
})

test('a mixed placeholder + public answer set is refused', async () => {
  const resolve = createFakeIpResolver(RANGES, answers([
    { address: '198.18.0.100', family: 4 },
    { address: '93.184.216.34', family: 4 },
  ]))
  await assert.rejects(resolve('example.com', undefined), (error) => {
    assert.equal(error.code, 'WEB_BLOCKED_URL')
    return true
  })
})

test('an empty answer set is a provider error, not a block', async () => {
  const resolve = createFakeIpResolver(RANGES, answers([]))
  await assert.rejects(resolve('example.com', undefined), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_ERROR')
    assert.match(error.message, /resolved to no addresses/)
    return true
  })
})

test('a malformed answer entry is a provider error', async () => {
  const resolve = createFakeIpResolver(RANGES, answers([
    { address: '198.18.0.100', family: 6 },
  ]))
  await assert.rejects(resolve('example.com', undefined), (error) => {
    assert.equal(error.code, 'WEB_PROVIDER_ERROR')
    return true
  })
})

// ── the SSRF guarantee: literals never take the fake-ip path ───────────────

test('an IP literal in the placeholder block is refused and never resolved', async () => {
  const resolve = createFakeIpResolver(RANGES, exploding())
  await assert.rejects(resolve('198.18.0.100', undefined), (error) => {
    assert.equal(error.code, 'WEB_BLOCKED_URL')
    return true
  })
})

test('private and loopback literals are refused without consulting DNS', async () => {
  const resolve = createFakeIpResolver(RANGES, exploding())
  for (const host of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '[::1]']) {
    await assert.rejects(resolve(host, undefined), (error) => {
      assert.equal(error.code, 'WEB_BLOCKED_URL', `expected ${host} to be blocked`)
      return true
    })
  }
})

test('a public IP literal is accepted without consulting DNS', async () => {
  const resolve = createFakeIpResolver(RANGES, exploding())
  assert.deepEqual(await resolve('1.1.1.1', undefined), [
    { address: '1.1.1.1', family: 4 },
  ])
})

// ── cancellation ───────────────────────────────────────────────────────────

test('an already-aborted signal rejects instead of resolving', async () => {
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  const resolve = createFakeIpResolver(RANGES, answers([
    { address: '198.18.0.100', family: 4 },
  ]))
  await assert.rejects(resolve('example.com', controller.signal), /aborted/)
})

// ── configuration ──────────────────────────────────────────────────────────

test('the schema defaults mirror the stock provider', () => {
  const config = Config({})
  assert.deepEqual(config.fakeIpRanges, DEFAULT_FAKE_IP_RANGES)
  assert.equal(config.maxResponseBytes, 5_000_000)
  assert.equal(config.maxBodyChars, 100_000)
  assert.equal(config.timeoutMs, 30_000)
  assert.equal(config.maxRedirects, 5)
  assert.match(config.userAgent, /deepseek-harness/)
})

test('a partial configuration keeps the other defaults', () => {
  const config = Config({ timeoutMs: 1234 })
  assert.equal(config.timeoutMs, 1234)
  assert.equal(config.maxRedirects, 5)
})

test('the schema rejects a wrongly typed field', () => {
  assert.throws(() => Config({ timeoutMs: 'nope' }), /expected number/)
})

test('assertValidConfig rejects out-of-range limits', () => {
  assert.throws(() => assertValidConfig(Config({ maxResponseBytes: 0 })), /positive finite/)
  assert.throws(() => assertValidConfig(Config({ maxBodyChars: -1 })), /positive finite/)
  assert.throws(() => assertValidConfig(Config({ timeoutMs: Number.POSITIVE_INFINITY })), /positive finite/)
  assert.throws(() => assertValidConfig(Config({ maxRedirects: 1.5 })), /non-negative integer/)
  assert.throws(() => assertValidConfig(Config({ maxRedirects: -1 })), /non-negative integer/)
  assert.throws(() => assertValidConfig({ ...Config({}), fakeIpRanges: [] }), /at least one CIDR/)
  assert.doesNotThrow(() => assertValidConfig(Config({})))
})

test('toLimits projects only the transport limit fields', () => {
  const limits = toLimits(Config({ timeoutMs: 500 }))
  assert.deepEqual(Object.keys(limits).sort(), [
    'maxBodyChars',
    'maxRedirects',
    'maxResponseBytes',
    'timeoutMs',
    'userAgent',
  ])
  assert.equal(limits.timeoutMs, 500)
})
