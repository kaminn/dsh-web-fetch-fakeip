/**
 * `dsh-web-fetch-fakeip` — a fake-ip-aware `WebFetchProvider` for the
 * DeepSeek Harness web capability seam (`ctx.web`).
 *
 * ## The problem
 *
 * `@deepseek-ai/dsh-web-fetch-http` resolves every hostname itself and refuses
 * the request unless every answer is a public unicast address. Under a
 * transparent-proxy (TUN) setup whose DNS runs in fake-ip mode, mihomo/Clash
 * answer *every* hostname with a placeholder from `dns.fake-ip-range`
 * (`198.18.0.1/16` by default). `ipaddr.js` classifies `198.18.0.0/15` as
 * `reserved` (RFC 2544 benchmarking), so the stock provider rejects every
 * hostname with `WEB_BLOCKED_URL`.
 *
 * Other tools (`curl`, editors) are unaffected because they never make that
 * check: they send the packet to the placeholder address, and the TUN adapter
 * intercepts it and hands the connection to the proxy, which resolves the real
 * origin. The stock provider's proxy escape hatch does not apply either,
 * because `proxyRouteFor()` reads only `http_proxy` / `https_proxy` /
 * `all_proxy`, and a TUN setup sets none of them — it does not need to.
 *
 * ## The fix
 *
 * This plugin reuses the stock provider's entire transport
 * ({@link HttpFetchProvider}): redirect policy, byte and character caps,
 * content-type classification, charset decoding and `WebError` codes. It
 * replaces **only** the destination policy, through the resolver that
 * `HttpFetchProvider` accepts as its second constructor argument. See
 * `src/resolver.js` for the decision and why the relaxation is exactly as wide
 * as the placeholder block.
 *
 * @module dsh-web-fetch-fakeip
 */

import { HttpFetchProvider, LOCAL_FETCH_PROVIDER_ID } from '@deepseek-ai/dsh-web-fetch-http'
import { Config, assertValidConfig, toLimits } from './config.js'
import { compileFakeIpRanges, createFakeIpResolver } from './resolver.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-fetch-fakeip'

/** The web seam this provider registers into. */
export const inject = ['web']

export { Config }
export {
  DEFAULT_FAKE_IP_RANGES,
  WEB_FETCH_MAX_URL_LENGTH,
} from './config.js'
export {
  compileFakeIpRanges,
  createFakeIpResolver,
  isFakeIpAddress,
  isPublicIpAddress,
  stripIpv6Brackets,
} from './resolver.js'

/**
 * Register a fake-ip-aware `http` fetch provider with `ctx.web`.
 *
 * The provider keeps the stock id (`http`) so `ctx.web.fetch()` selects it by
 * the same `fetchProvider: http` configuration the stock provider uses. Both
 * cannot be mounted at once: the seam rejects a duplicate id with
 * `WEB_DUPLICATE_PROVIDER`, so disable the stock `web-fetch-http` row.
 *
 * @param ctx - context whose `web` service receives the provider.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config) {
  assertValidConfig(config)
  const ranges = compileFakeIpRanges(config.fakeIpRanges)
  const inner = new HttpFetchProvider(toLimits(config), createFakeIpResolver(ranges))

  ctx.web.registerFetchProvider({
    id: LOCAL_FETCH_PROVIDER_ID,
    // No credentials to check — an anonymous public fetcher is always usable.
    available: () => true,
    fetch: (request, signal) => inner.fetch(request, signal),
  })
}

export default { name, inject, Config, apply }
