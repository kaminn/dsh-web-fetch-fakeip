---
description: "A fake-ip-aware WebFetchProvider for the DeepSeek Harness web seam: keeps the web_fetch tool working under mihomo/Clash TUN mode with fake-ip DNS, without disabling fake-ip or setting proxy environment variables."
kind: "package-reference"
---

# dsh-web-fetch-fakeip

English | [中文](README.zh.md)

A drop-in replacement for `@deepseek-ai/dsh-web-fetch-http` that keeps the
`web_fetch` tool working when the machine's DNS runs in **fake-ip** mode behind
a transparent-proxy (TUN) setup — with fake-ip left enabled and **no**
`http_proxy` / `https_proxy` / `all_proxy` environment variables.

## Summary

`dsh-web-fetch-http` resolves every hostname itself and refuses the request
unless every answer is a public unicast address. Under fake-ip mode, mihomo and
Clash answer *every* hostname with a placeholder drawn from
`dns.fake-ip-range` (`198.18.0.1/16` by default). `ipaddr.js` classifies
`198.18.0.0/15` as `reserved` — the RFC 2544 benchmarking block — so the stock
provider rejects every hostname:

```text
Error: URL hostname "example.com" resolves to a non-public IP address
```

`curl` and other tools are unaffected because they never make that check: they
send the packet to the placeholder address, the TUN adapter intercepts it, and
the proxy resolves the real origin. The stock provider's proxy escape hatch
does not help either, because `proxyRouteFor()` reads only `http_proxy` /
`https_proxy` / `all_proxy`, and a TUN setup sets none of them — it does not
need to.

This plugin reuses the stock provider's entire transport and replaces **only**
the destination policy.

## Table of Contents

- [Quick start](#quick-start)
- [Example configurations](#example-configurations)
- [Configuration reference](#configuration-reference)
- [What changes, and what does not](#what-changes-and-what-does-not)
- [Diagnosing your setup](#diagnosing-your-setup)
- [How it works](#how-it-works)
- [Development](#development)
- [Security notes](#security-notes)
- [Known limitations](#known-limitations)
- [License](#license)

-----

<a id="quick-start"></a>
## Quick start

### Install into a profile

```sh
# From the directory holding this checkout. The relative path is anchored to
# your invoking directory, not to the profile.
dsh plugin --profile web add /path/to/dsh-web-fetch-fakeip
```

Because this package declares `dsh.bundle` in its `package.json`, `dsh plugin`
adds it to `dsh.profile.bundles` automatically and its
[`cordis.patch.yml`](cordis.patch.yml) is applied as a layer: the stock
`web-fetch-http` row is disabled and this provider is inserted in its place.

Restart the profile (or let the profile's `patchReload: live` watcher pick it
up) and the `web_fetch` tool works again.

### Manual installation

If you would rather not install a package, copy the directory into your profile
and point a patch row at the file:

```sh
cp -r dsh-web-fetch-fakeip "$DSH_HOME/profiles/web/plugins/"
```

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: web-fetch-http
  disabled: true

- insert:
    - id: web-fetch-fakeip
      name: './plugins/dsh-web-fetch-fakeip/src/index.js'
```

A patch replaces the targeted row's whole `config`, and a patch that matches
nothing warns and is skipped — so the `disabled: true` row above is safe even
if the stock row is absent.

### Verify

```sh
# Should print the composed rows: web-fetch-http disabled, web-fetch-fakeip inserted.
dsh --profile web --dump-config | grep -A3 fakeip
```

Then ask the agent to fetch a page, or run the live suite:

```sh
npm run test:live
```

**A restart is required after installing or removing a bundle.** The profile's
`patchReload: live` watcher only re-reads `cordis.patch.yml`; the
`dsh.profile.bundles` list is read once at boot. Adding the bundle registers it
in that list immediately (so `--dump-config` shows it), but the running host
keeps the layer stack it booted with until it restarts.

### Uninstall

```sh
dsh plugin --profile web remove dsh-web-fetch-fakeip
```

`dsh plugin` reconciles `dsh.profile.bundles` after pnpm finishes, so the bundle
layer leaves the stack along with the dependency. Restart the profile
afterwards. The stock `web-fetch-http` row returns automatically — the disable
came from this bundle's patch, so removing the bundle removes the disable too.

### Updating

```sh
dsh plugin --profile web update dsh-web-fetch-fakeip
```

A `github:` spec without a ref tracks the repository's default branch, and pnpm
resolves it at install/update time — so updates are explicit, never silent.

-----

<a id="example-configurations"></a>
## Example configurations

### The common case: default mihomo/Clash range

Nothing needs configuring — every field defaults to the stock provider's value.
This is what the bundled [`cordis.patch.yml`](cordis.patch.yml) does:

```yaml
- id: web-fetch-http
  disabled: true

- insert:
    - id: web-fetch-fakeip
      name: 'dsh-web-fetch-fakeip'
```

See [`examples/mihomo-default.patch.yml`](examples/mihomo-default.patch.yml) for
the same row written out explicitly.

### A non-default `dns.fake-ip-range`

Match `fakeIpRanges` to whatever the proxy actually writes, or fake-ip
hostnames keep failing:

```yaml
- id: web-fetch-http
  disabled: true

- insert:
    - id: web-fetch-fakeip
      name: 'dsh-web-fetch-fakeip'
      config:
        fakeIpRanges:
          - 10.18.0.0/16
          - 198.18.0.0/15
```

More than one block is allowed; an answer set is accepted when every address
falls in *some* configured block. See
[`examples/custom-range.patch.yml`](examples/custom-range.patch.yml) for this
plus tightened transport limits.

### Find your proxy's actual range

| Proxy | Configuration key |
| --- | --- |
| mihomo / Clash / Clash Verge | `dns.fake-ip-range` |
| sing-box | `dns.fakeip.range` |

For a GUI client the effective value is the generated runtime config, not the
subscription profile — look for the key above in the client's own configuration
directory and confirm `enhanced-mode` is `fake-ip`:

```yaml
dns:
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
```

`scripts/diagnose.mjs` reads back whatever DNS actually answers, so you do not
have to find the file to know what to configure.

-----

<a id="configuration-reference"></a>
## Configuration reference

Every field defaults to the stock provider's value, so mounting this plugin with
no `config:` changes exactly one thing: how a destination is judged.

| Field | Default | Meaning |
| --- | --- | --- |
| `fakeIpRanges` | `['198.18.0.0/15']` | Placeholder blocks accepted as a fake-ip answer set |
| `maxResponseBytes` | `5000000` | Maximum response body size in bytes |
| `maxBodyChars` | `100000` | Maximum decoded body length in characters |
| `timeoutMs` | `30000` | Fetch timeout — a resource backstop, not the tool budget |
| `maxRedirects` | `5` | Maximum same-origin redirect hops (`0` follows none) |
| `userAgent` | `deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)` | `User-Agent` header sent on every request |

An invalid value fails loudly at plugin construction rather than building a
provider with nonsensical caps, matching the stock provider. The URL length
limit is fixed at 2,048 characters.

### Why `198.18.0.0/15` rather than the `198.18.0.1/16` default

mihomo's documented default is `198.18.0.1/16`, which is a subset of
`198.18.0.0/15`. The wider block is the RFC 2544 benchmarking range as a whole,
so the default covers both spellings and the neighbouring block that some
configurations use. Narrowing it to `/16` is safe if you prefer to be strict.

-----

<a id="what-changes-and-what-does-not"></a>
## What changes, and what does not

| Destination | Behaviour |
| --- | --- |
| Hostname whose answers are **all** fake-ip placeholders | **Accepted**, pinned as-is; the connection reaches the TUN adapter and the proxy resolves the real origin |
| Hostname resolving to public unicast | Accepted, exactly as the stock provider |
| Hostname resolving to private / loopback / reserved | **Refused** (`WEB_BLOCKED_URL`), exactly as the stock provider |
| Hostname with a **mixed** answer set (placeholder + any real address) | **Refused** — never partly accepted |
| IP **literal** in the placeholder block (`http://198.18.0.100/`) | **Refused** — a literal states a destination and never takes the fake-ip path |
| IP **literal** that is private/loopback/link-local (`127.0.0.1`, `192.168.1.1`, `169.254.169.254`, `10.0.0.1`, `[::1]`) | **Refused** |
| IP **literal** that is public (`1.1.1.1`) | Accepted through the normal validated path |

Everything else is inherited unchanged from the stock provider: same-origin-only
redirects, byte and character caps, `Content-Type` classification, charset
decoding from the `Content-Type` header, rejection of binary types and of URLs
carrying credentials, and the same `WebError` codes (`WEB_INVALID_URL`,
`WEB_BLOCKED_URL`, `WEB_FETCH_TOO_LARGE`, `WEB_FETCH_TIMEOUT`,
`WEB_REDIRECT_BLOCKED`, `WEB_UNSUPPORTED_CONTENT_TYPE`, `WEB_ABORTED`,
`WEB_PROVIDER_ERROR`).

-----

<a id="diagnosing-your-setup"></a>
## Diagnosing your setup

Run the bundled diagnostic first — it separates the three cases that look alike
from the tool's error message. When installed as a bundle, resolve its path
through the package so it works wherever pnpm placed it:

```sh
# From the profile directory (the profile that has the bundle installed).
node --input-type=module -e "import('dsh-web-fetch-fakeip/scripts/diagnose.mjs')"
```

Or run the file directly — from a source checkout, or via the installed path:

```sh
node scripts/diagnose.mjs
node scripts/diagnose.mjs example.com api.github.com
```

It prints each hostname's answers with their `ipaddr.js` range and whether the
configured blocks cover them, then gives a verdict:

- **fake-ip, covered** — this plugin is the right fix; a remaining failure is
  downstream of destination policy (proxy routing).
- **reserved, not covered** — set `fakeIpRanges` to the reported block.
- **no fake-ip seen** — this machine resolves real addresses; the stock
  provider is already correct and this plugin changes nothing.

To confirm the composed tree actually contains the replacement row:

```sh
dsh --profile web --dump-config | grep -B1 -A4 'fakeip\|web-fetch-http'
```

-----

<a id="how-it-works"></a>
## How it works

`HttpFetchProvider` accepts a resolver as its second constructor argument —
that is the whole seam. This plugin passes a resolver that understands fake-ip
and lets the stock class do everything else:

```js
import { HttpFetchProvider, LOCAL_FETCH_PROVIDER_ID } from '@deepseek-ai/dsh-web-fetch-http'

const inner = new HttpFetchProvider(limits, createFakeIpResolver(ranges))

ctx.web.registerFetchProvider({
  id: LOCAL_FETCH_PROVIDER_ID,
  available: () => true,
  fetch: (request, signal) => inner.fetch(request, signal),
})
```

The resolver's decision, per answer set:

1. Resolve once (or take the literal as stated).
2. Reject malformed entries (`WEB_PROVIDER_ERROR`).
3. If the hostname was **not** a literal and **every** answer is a placeholder
   in a configured block, accept the set as-is.
4. Otherwise require every answer to be public unicast, exactly as before.

Step 3 is deliberately all-or-nothing. A placeholder carries no destination of
its own — only the local TUN adapter can route it — so accepting one does not
open a path to a private service. A **mixed** set is refused because otherwise
a DNS answer could widen the policy by smuggling a private address alongside a
placeholder.

### Source map

| File | Role |
| --- | --- |
| [`src/index.js`](src/index.js) | Plugin entry: registers the provider, re-exports the API |
| [`src/config.js`](src/config.js) | Config schema, defaults mirroring the stock provider, limit validation |
| [`src/resolver.js`](src/resolver.js) | Destination policy: classification, range matching, the resolver decision |
| [`cordis.patch.yml`](cordis.patch.yml) | Bundle patch: disables the stock row, inserts this one |
| [`scripts/diagnose.mjs`](scripts/diagnose.mjs) | Reports what DNS answers and whether the config covers it |
| [`scripts/check-package.mjs`](scripts/check-package.mjs) | Fails when the published tarball is missing a required file or ships a forbidden one |
| [`scripts/release-control.mjs`](scripts/release-control.mjs) | Release gates: tag/version validation, npm idempotency check, CHANGELOG notes, GitHub Release sync |
| [`test/resolver.test.js`](test/resolver.test.js) | Offline unit suite (no network) |
| [`test/release-control.test.js`](test/release-control.test.js) | Offline tests for the release gates |
| [`test/transport.live.js`](test/transport.live.js) | Opt-in live suite (real transport) |

### Why the stock row must be disabled

Both providers register the same fetch-provider id (`http`), and the web seam
rejects a duplicate with `WEB_DUPLICATE_PROVIDER`. Disabling the row does not
remove the package — this plugin imports `HttpFetchProvider` from it. Keeping
the same id means `ctx.web.fetch()` selects this provider under the existing
`fetchProvider: http` configuration, with no change to the web service row.

-----

<a id="development"></a>
## Development

Requires Node 22+ (developed on Node 24).

```sh
npm test          # offline unit suite — no network, no DNS
npm run test:live # opt-in live suite — needs working DNS and egress
npm run check     # syntax check plus the offline suite
npm run pack:check # assert the published tarball's contents
npm run verify    # check + pack:check — what the release workflow gates on
```

The offline suite injects the resolver, so it asserts the destination policy
without touching the network. The live suite asserts both halves at once: a
real hostname fetches **even though** it resolves to a placeholder, and every
private destination is **still** refused. Its fake-ip assertions skip
themselves on a host without fake-ip DNS, so the suite stays meaningful
anywhere.

`pack:check` exists because a `files` whitelist mistake is invisible during
development — the whole working tree is present — and only surfaces once a
consumer installs the package. It has already happened here, so the check runs
on every CI run rather than only at release.

While developing outside a profile, `node_modules` must resolve the harness
packages. Point it at the installation's shared closure:

```sh
# Windows (junction; no admin rights needed)
New-Item -ItemType Junction -Path node_modules -Target "$env:USERPROFILE\.dsh\profiles\node_modules"

# POSIX
ln -s "$HOME/.dsh/profiles/node_modules" node_modules
```

`node_modules` is gitignored.

### Continuous integration

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| [`ci.yml`](.github/workflows/ci.yml) | push to `main`, pull request | Test matrix across the supported DSH versions, packaging guard, live transport lane |
| [`release.yml`](.github/workflows/release.yml) | tag push `v*` | Publish to npm via Trusted Publishing (OIDC), then create the GitHub Release |

The test matrix pins each DSH version explicitly rather than resolving by
range: npm's `latest` tag for the `@deepseek-ai/dsh-*` packages still points at
an old `0.0.1-rc` line while the current release sits under `next`.

See [RELEASING.md](RELEASING.md) for the release process and the one-time npm
setup.

-----

<a id="security-notes"></a>
## Security notes

This plugin exists because the stock check cannot be satisfied under fake-ip
DNS, so the question worth asking is what the relaxation costs.

**The relaxation is exactly as wide as the placeholder block.** Under fake-ip
the proxy performs origin resolution, so upstream reachability is governed by
the proxy's own routing rules rather than by this module. Two consequences:

- **Keep the proxy's rules from exposing private ranges** to the model's fetch
  tool. A rule that routes RFC1918 or loopback through the proxy would let a
  hostname reach an internal service — that risk is introduced by the proxy
  configuration, not by this plugin, but the plugin is what makes the fetch
  succeed, so it is worth auditing together.
- **IP literals are never placeholders.** They state a destination the caller
  chose, so handing one to a proxy running on this machine would reach exactly
  the loopback or private service the check exists to keep out of reach. This
  is why `http://127.0.0.1/` stays blocked even though a *hostname* that
  resolves into the placeholder block does not.

If you want a stricter posture, narrow `fakeIpRanges` to your proxy's exact
block (for example `198.18.0.0/16`) rather than the wider default.

-----

<a id="known-limitations"></a>
## Known limitations

- **The range must be configured by hand if it is not the default.** The plugin
  cannot discover the proxy's `dns.fake-ip-range`; `scripts/diagnose.mjs` tells
  you what to set.
- **Only textual content decodes** — inherited from the stock provider.
  `text/html`, `application/xhtml+xml`, `text/*` and the JSON/XML families are
  decoded; a missing `Content-Type` or a binary type throws
  `WEB_UNSUPPORTED_CONTENT_TYPE`.
- **Charset comes only from the `Content-Type` header** (UTF-8 default) — also
  inherited; an HTML `<meta charset>` declaration is ignored.
- **The stock provider must be disabled.** Two providers cannot share the
  `http` id.

## License

[MIT](LICENSE)
