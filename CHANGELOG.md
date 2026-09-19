# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `files` omitted `scripts/` and `test/`, so an installed bundle shipped
  without the diagnostic script the README points at, and without the test
  suites.
- `exports` did not expose `./scripts/diagnose.mjs`, so the diagnostic was
  unreachable through the package specifier even once shipped.

### Added

- Uninstall and update instructions, and a note that installing or removing a
  bundle requires a restart: `patchReload: live` re-reads only
  `cordis.patch.yml`, while `dsh.profile.bundles` is read once at boot.

## [0.1.0] - 2026-09-19

### Added

- fake-ip-aware destination policy for the `ctx.web` fetch seam, registered
  under the stock `http` provider id.
- `fakeIpRanges` configuration, defaulting to `198.18.0.0/15` (the RFC 2544
  benchmarking block mihomo/Clash use for `dns.fake-ip-range`).
- Bundle patch (`cordis.patch.yml`) that disables the stock `web-fetch-http`
  row and inserts this provider, so `dsh plugin --profile <name> add` composes
  it automatically.
- Offline unit suite (23 tests) covering classification, range matching, the
  resolver decision, literal handling, cancellation and config validation.
- Opt-in live suite (9 tests) that asserts a real hostname fetches under
  fake-ip DNS **and** that private, loopback and link-local destinations stay
  blocked. The fake-ip assertions skip themselves on hosts without fake-ip DNS.
- `scripts/diagnose.mjs`, which reports what DNS actually answers and whether
  the configured ranges cover it.
- Example patch files for the default range and a non-default range.

### Security

- IP literals are never treated as fake-ip placeholders, so `127.0.0.1`,
  RFC1918, link-local and the cloud metadata address remain blocked.
- A mixed answer set (placeholder plus any real address) fails the public
  check rather than being partly accepted, so a DNS answer cannot widen the
  policy by smuggling a private address alongside a placeholder.

[0.1.0]: https://github.com/OWNER/dsh-web-fetch-fakeip/releases/tag/v0.1.0
