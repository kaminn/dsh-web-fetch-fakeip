/**
 * Destination policy for fake-ip DNS: decide which resolved addresses the
 * transport may connect to.
 *
 * This is the only behaviour that differs from
 * `@deepseek-ai/dsh-web-fetch-http`. The stock policy requires every DNS
 * answer to be public unicast, which a fake-ip placeholder can never be; this
 * policy accepts an all-placeholder answer set and keeps the stock check for
 * everything else.
 *
 * @module dsh-web-fetch-fakeip/resolver
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { WebError } from '@deepseek-ai/dsh-web'

/** WHATWG URL keeps brackets around IPv6 hostnames; IP parsers do not. */
export function stripIpv6Brackets(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/**
 * Parse one textual address, unwrapping an IPv4-mapped IPv6 spelling so the
 * embedded IPv4 address decides the classification.
 *
 * @param input - textual IPv4 or IPv6 address.
 * @returns the parsed address.
 */
function parseAddress(input) {
  const parsed = ipaddr.parse(stripIpv6Brackets(String(input)))
  if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) return parsed.toIPv4Address()
  return parsed
}

/**
 * Whether an address is globally reachable unicast.
 *
 * Mirrors the stock provider's classifier exactly: this is the behaviour being
 * preserved for every destination that is not a fake-ip placeholder. The
 * RFC 2544 benchmarking block is `reserved`, which is precisely why a
 * placeholder can never pass.
 *
 * @param input - textual IPv4 or IPv6 address.
 * @returns true only for a public unicast destination.
 */
export function isPublicIpAddress(input) {
  let parsed
  try {
    parsed = parseAddress(input)
  } catch {
    return false
  }
  return parsed.range() === 'unicast'
}

/**
 * Compile configured placeholder ranges once, failing loudly on a bad CIDR.
 *
 * @param ranges - CIDR strings from the configuration.
 * @returns compiled `{ network, prefix, cidr }` records.
 * @throws when a value is not a valid CIDR block.
 */
export function compileFakeIpRanges(ranges) {
  return ranges.map((cidr) => {
    let parsed
    try {
      parsed = ipaddr.parseCIDR(String(cidr))
    } catch (error) {
      throw new Error(`web-fetch-fakeip: fakeIpRanges entry ${JSON.stringify(String(cidr))} is not a valid CIDR block`, { cause: error })
    }
    const [network, prefix] = parsed
    return { network, prefix, cidr: String(cidr) }
  })
}

/**
 * Whether one address falls inside a configured placeholder range.
 *
 * @param address - textual address from a DNS answer.
 * @param ranges - compiled ranges from {@link compileFakeIpRanges}.
 * @returns true when the address is a fake-ip placeholder.
 */
export function isFakeIpAddress(address, ranges) {
  let parsed
  try {
    parsed = parseAddress(address)
  } catch {
    return false
  }
  return ranges.some(({ network, prefix }) => {
    if (parsed.kind() !== network.kind()) return false
    return parsed.match(network, prefix)
  })
}

/** Race a non-cancellable OS lookup without letting it delay tool cancellation. */
function raceWithSignal(promise, signal) {
  if (signal === undefined) return promise
  const abortError = () => new Error('web fetch aborted during hostname resolution', { cause: signal.reason })
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(abortError())
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort)
    })
  })
}

/**
 * Build the resolver the stock transport consumes: one hostname in, the
 * address set the connection may be pinned to out.
 *
 * The decision is deliberately all-or-nothing per answer set:
 *
 * - a hostname whose answers are **all** placeholders is accepted and returned
 *   as-is. A placeholder states no destination of its own — only the local TUN
 *   adapter can route it — so the connection reaches the proxy, which resolves
 *   the real origin;
 * - an IP **literal** never takes that path. It states a destination the caller
 *   chose, so handing it to a proxy running on this machine would reach exactly
 *   the loopback or private service the check exists to keep out of reach;
 * - every other answer set is validated exactly as before, so a private,
 *   loopback, link-local or otherwise reserved destination is still refused.
 *
 * A mixed answer set (one placeholder plus one real address) fails the public
 * check rather than being partly accepted, so a DNS answer can never widen the
 * policy by including a placeholder alongside a private address.
 *
 * @param hostname - URL hostname, including brackets when it is an IPv6 literal.
 * @param signal - aborts the wait for system resolution.
 * @param ranges - compiled placeholder ranges.
 * @param resolver - DNS lookup implementation, overridden by tests.
 * @returns the validated, non-empty address set.
 */
export function createFakeIpResolver(ranges, resolver = lookup) {
  return async function resolveFakeIpAware(hostname, signal) {
    const unbracketed = stripIpv6Brackets(hostname)
    const literalFamily = isIP(unbracketed)
    const resolved = literalFamily === 0
      ? await raceWithSignal(resolver(unbracketed, { all: true, order: 'verbatim' }), signal)
      : [{ address: unbracketed, family: literalFamily }]

    if (resolved.length === 0) {
      throw new WebError(`hostname "${hostname}" resolved to no addresses`, 'WEB_PROVIDER_ERROR')
    }

    for (const entry of resolved) {
      if (entry.family !== 4 && entry.family !== 6 || isIP(entry.address) !== entry.family) {
        throw new WebError(`hostname "${hostname}" resolved to an invalid IP address`, 'WEB_PROVIDER_ERROR')
      }
    }

    if (literalFamily === 0 && resolved.every((entry) => isFakeIpAddress(entry.address, ranges))) {
      return resolved.map((entry) => ({ address: entry.address, family: entry.family }))
    }

    for (const entry of resolved) {
      if (!isPublicIpAddress(entry.address)) {
        throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, 'WEB_BLOCKED_URL')
      }
    }
    return resolved.map((entry) => ({ address: entry.address, family: entry.family }))
  }
}
