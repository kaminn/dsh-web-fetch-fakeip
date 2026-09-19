/**
 * Configuration schema and validation for `dsh-web-fetch-fakeip`.
 *
 * The defaults deliberately mirror `@deepseek-ai/dsh-web-fetch-http`, so
 * enabling this plugin changes exactly one thing: how a destination is judged.
 *
 * @module dsh-web-fetch-fakeip/config
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_USER_AGENT } from '@deepseek-ai/dsh-web-fetch-http'

/**
 * Placeholder block mihomo/Clash write for `dns.fake-ip-range` by default.
 * `198.18.0.0/15` is the RFC 2544 benchmarking range; the stock default is
 * `198.18.0.1/16`, and the wider `/15` covers the neighbouring block too.
 */
export const DEFAULT_FAKE_IP_RANGES = ['198.18.0.0/15']

/** Upper bound on a timer delay, matching Node's `setTimeout` coercion limit. */
const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647

/** Fixed URL length ceiling enforced by the underlying transport policy. */
export const WEB_FETCH_MAX_URL_LENGTH = 2048

/**
 * The plugin's configuration schema.
 *
 * Every field defaults to the stock provider's value, so a deployment that
 * mounts this plugin with no config at all gets identical transport behaviour.
 */
export const Config = z.object({
  /**
   * Placeholder address blocks to accept as a fake-ip answer set. Set this to
   * the proxy's `dns.fake-ip-range` when it is not the `198.18.0.0/15` default.
   */
  fakeIpRanges: z.array(z.string()).default([...DEFAULT_FAKE_IP_RANGES]),

  /** Maximum response body size in bytes. */
  maxResponseBytes: z.number().default(5_000_000),

  /** Maximum decoded body length in characters. */
  maxBodyChars: z.number().default(100_000),

  /** Fetch timeout in milliseconds — a resource backstop, not the tool budget. */
  timeoutMs: z.number().default(30_000),

  /** Maximum same-origin redirect hops (`0` follows none). */
  maxRedirects: z.number().default(5),

  /** `User-Agent` header sent on every request. */
  userAgent: z.string().default(DEFAULT_USER_AGENT),
})

/** A resource limit must be a positive finite number. */
function assertPositiveFinite(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`web-fetch-fakeip: ${name} must be a positive finite number`)
  }
}

/** Node coerces larger timer delays to 1 ms, so reject them at configuration time. */
function assertTimeoutMs(value) {
  assertPositiveFinite('timeoutMs', value)
  if (value > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(`web-fetch-fakeip: timeoutMs must be no greater than ${MAX_NODE_TIMER_DELAY_MS}`)
  }
}

/** The redirect hop cap must be a non-negative integer. */
function assertNonNegativeInteger(name, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`web-fetch-fakeip: ${name} must be a non-negative integer`)
  }
}

/**
 * Validate the resolved configuration beyond what the schema expresses.
 *
 * The stock provider validates its limits the same way, so an invalid value
 * fails loudly at plugin construction rather than building a provider with
 * nonsensical caps.
 *
 * @param config - the schema-resolved configuration.
 * @throws when a limit is out of range.
 */
export function assertValidConfig(config) {
  assertPositiveFinite('maxResponseBytes', config.maxResponseBytes)
  assertPositiveFinite('maxBodyChars', config.maxBodyChars)
  assertTimeoutMs(config.timeoutMs)
  assertNonNegativeInteger('maxRedirects', config.maxRedirects)
  if (config.fakeIpRanges.length === 0) {
    throw new Error('web-fetch-fakeip: fakeIpRanges must contain at least one CIDR block')
  }
}

/**
 * Project the configuration onto the transport limit shape the stock provider
 * expects.
 *
 * @param config - the validated configuration.
 * @returns the resolved limits.
 */
export function toLimits(config) {
  return {
    maxResponseBytes: config.maxResponseBytes,
    maxBodyChars: config.maxBodyChars,
    timeoutMs: config.timeoutMs,
    maxRedirects: config.maxRedirects,
    userAgent: config.userAgent,
  }
}
