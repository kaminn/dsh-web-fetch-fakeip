# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version is `0.y.z`, the public surface — the exported plugin API, the
configuration fields, and the supported DSH peer versions — may change in a
minor release. A breaking change will be called out explicitly under
`### Changed` or `### Removed`.

## [0.1.1-alpha.1] - 2026-09-20

Release tooling only — no runtime code changes. This prerelease exists to
exercise the tag-driven Trusted Publishing pipeline end to end.

### Added

- Prerelease tags (e.g. `v0.1.1-alpha.1`) pass the release workflow's tag
  gate.
- Prerelease versions publish under the `next` dist-tag, so `latest` never
  points at a prerelease and a bare `npm install` keeps resolving to the
  stable line.

### Fixed

- The packaging guard accepts `npm pack --dry-run --json` output from both
  the pre-12 (array) and 12+ (name-keyed object) shapes — npm 12 changed the
  shape, which made the first release run fail with "npm pack reported no
  files". CI's packaging job now upgrades npm exactly like the release
  workflow, so the two environments can no longer drift apart.

## [0.1.0] - 2026-09-19

First published release.

### Added

- fake-ip-aware destination policy for the `ctx.web` fetch seam, registered
  under the stock `http` provider id.
- `fakeIpRanges` configuration, defaulting to `198.18.0.0/15` (the RFC 2544
  benchmarking block mihomo/Clash use for `dns.fake-ip-range`).
- Bundle patch (`cordis.patch.yml`) that disables the stock `web-fetch-http`
  row and inserts this provider, so `dsh plugin --profile <name> add` composes
  it automatically.
- Offline unit suite covering classification, range matching, the resolver
  decision, literal handling, cancellation, config validation, and the
  release-control helpers. No network required.
- Opt-in live suite that asserts a real hostname fetches under fake-ip DNS
  **and** that private, loopback and link-local destinations stay blocked. The
  fake-ip assertions skip themselves on hosts without fake-ip DNS.
- `scripts/diagnose.mjs`, which reports what DNS actually answers and whether
  the configured ranges cover it.
- `scripts/check-package.mjs`, which fails the build when the published
  tarball is missing a required file or ships one it must not. A `files`
  whitelist failure is invisible during development and only surfaces after
  publishing, so it is checked on every CI run.
- Example patch files for the default range and a non-default range.
- Tag-driven release workflow using npm Trusted Publishing (OIDC): no
  `NPM_TOKEN` secret, provenance attached to every tarball, idempotent
  re-runs, and a GitHub Release created only after npm confirms the version
  is installable.
- A test matrix over every DSH line named in `peerDependencies`, so a claimed
  peer range is a version the suite actually runs against.

### Security

- IP literals are never treated as fake-ip placeholders, so `127.0.0.1`,
  RFC1918, link-local and the cloud metadata address remain blocked.
- A mixed answer set (placeholder plus any real address) fails the public
  check rather than being partly accepted, so a DNS answer cannot widen the
  policy by smuggling a private address alongside a placeholder.

[0.1.1-alpha.1]: https://github.com/kaminn/dsh-web-fetch-fakeip/releases/tag/v0.1.1-alpha.1
[0.1.0]: https://github.com/kaminn/dsh-web-fetch-fakeip/releases/tag/v0.1.0
