# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the version is `0.y.z`, the public surface — the exported plugin API, the
configuration fields, and the supported DSH peer versions — may change in a
minor release. A breaking change will be called out explicitly under
`### Changed` or `### Removed`.

## Versioning policy

This plugin's minor version tracks the DSH line it supports:

> **Plugin `0.M.x` supports DSH `0.M.*`, and no further.**
> The DSH peer range's upper bound is always `<0.(M+1).0-0`.

So `0.2.0` supports the DSH `0.2` line and declares
`>=0.1.2-rc.1 <0.3.0-0`. The next DSH minor line (`0.3`) will be adopted as
plugin `0.3.0` with the bound moved to `<0.4.0-0`.

The point is that the two version numbers tell the same story: a reader can see
which DSH line a plugin release targets without opening its `package.json`, and
a new DSH **patch or prerelease** within the same minor line needs no plugin
release at all. `test/compat.test.js` derives the expected upper bound from the
manifest's own minor version, so the rule cannot drift.

This is a convention, not a promise about the seam: a DSH release can still
change the seam inside a minor line. That is what the CI matrix is for — it
pins each claimed DSH version explicitly — and why the range stays bounded
rather than open-ended.

## [0.2.0] - 2026-09-28

No runtime code changes — the plugin's source is untouched — but a
**declaration** change that DSH 0.2.0-rc.2 made load-bearing. Published to
`latest`, because `0.1.1` is skipped by the 0.2.0-rc.2 gate and the `latest`
tag therefore points at a version that does not work on the `latest` DSH.

### Fixed

- **DSH 0.2.0-rc.2 skipped the bundle entirely.** `0.2.0-rc.2` added a gate
  that refuses to load any bundle whose `peerDependencies` exclude the running
  DSH version, and reports it once at startup as
  `skipping profile bundle "dsh-web-fetch-fakeip"`. The peer range enumerated
  only the published `0.1.x` prereleases, so the bundle was dropped, the stock
  `web-fetch-http` row took over, and every `web_fetch` under fake-ip DNS went
  back to failing with `resolves to a non-public IP address`. The plugin's code
  was never the problem: the `0.2.0-rc.2` seam tarballs (`dsh-web`,
  `dsh-web-fetch-http`) are **byte-identical** to `0.1.7-rc.2`'s, verified by
  hash and by exercising `apply()` against the real `0.2.0-rc.2` closure.
  Widening the range is the whole fix.

### Changed

- The `@deepseek-ai/dsh-web` and `@deepseek-ai/dsh-web-fetch-http` peer ranges
  are now the bounded range `>=0.1.2-rc.1 <0.3.0-0` instead of a hand-written
  list of every published `0.1.x` prerelease. The list had to be edited for
  each new DSH release, and forgetting meant the bundle was silently skipped
  rather than failing loudly; a bounded range covers the `0.2.0` final and
  every future `0.2.x` without an edit. `0.3.0` is deliberately still refused,
  because that is an untested compatibility claim rather than a mechanical
  extension.
- **The version number now follows the DSH minor line.** This release is
  `0.2.0` rather than a `0.1.2` patch, so the plugin's minor version and its
  declared DSH support (`<0.3.0-0`) name the same line — see
  [Versioning policy](#versioning-policy). It also means the version carries no
  prerelease suffix, so the release workflow publishes it to `latest` instead
  of `next`, which is what actually fixes the reported breakage for anyone on
  the current DSH.
- `devDependencies` track the `0.2.0-rc.2` stack, so the local suite runs
  against the closure a current harness actually ships. `semver` is now a dev
  dependency: the new compatibility test re-derives the harness's gate decision
  from the manifest.
- The CI matrix gained a `0.2.0-rc.2` row.

### Added

- [`test/compat.test.js`](test/compat.test.js): asserts the declared peer range
  against the harness's compatibility gate by re-deriving
  `evaluatePluginCompatibility`'s verdict from `package.json`, so a range that
  would get the whole bundle skipped fails offline instead of surfacing as a
  missing provider. It also checks that every DSH version pinned in the CI
  matrix satisfies the declared range, and that the two seam peers declare one
  shared bounded range. This is the test that would have caught the
  0.2.0-rc.2 breakage; the resolver suite could not, because every unit test
  imports `src/*` directly and never evaluates `package.json`.
- `test/compat.test.js` also enforces the [versioning
  policy](#versioning-policy), so it cannot drift: the declared DSH upper bound
  must match the manifest's own minor version, the version must carry no
  prerelease suffix (a `-` would divert the release to `next` and leave the
  broken `latest` in place), the CHANGELOG must carry the policy heading the
  README links to, and it must have a section for the exact version being
  released — which the release workflow requires and would otherwise fail on
  mid-run.
- Both suites now drive the real entry point instead of a copy of it. The live
  suite previously hand-mirrored what `apply()` does, so a registration mistake
  — a wrong provider id, or registering nothing — would have left every
  transport assertion green. `apply()` is now registered into an actual
  `Context` + `WebRuntime` (`ctx.web`) and the fetch is made through
  `ctx.web.fetch()`; the offline suite asserts the same registration and that
  the seam refuses a duplicate id.
- CI's syntax check now also covers `scripts/release-control.mjs` and the test
  files, so a syntax error there fails the matrix instead of only the suite
  that happens to run it.
- A README section on the `0.2.0-rc.2` skip message, its remedy, and why
  `dsh plugin allow-version` is an escape hatch rather than the fix.

## [0.1.1] - 2026-09-28

Promotes the `0.1.1` line to stable. No changes since `0.1.1-rc.1`, and no
runtime code changes since `0.1.0` — the release candidate passed the full CI
matrix (7/7 across node 22/24 and every claimed DSH line) and has been running
in a live fake-ip deployment.

Relative to `0.1.0`, the `0.1.1` line carries: a peer range extended to
`0.1.5-rc.3` and every published `0.1.7` prerelease, the CI matrix fix that
keeps the older DSH lines installable against the 0.1.7-era dev stack, and a
quick start that installs from npm by name.

## [0.1.1-rc.1] - 2026-09-28

First release candidate of the `0.1.1` line. No runtime code changes — the
plugin's source is untouched since `0.1.0`; this cycle was peer declarations,
CI, and documentation.

### Fixed

- The CI matrix's `dsh 0.1.5-rc.2` rows failed at **dependency install**, not
  in tests: `^0.1.5-rc.2` floats `@deepseek-ai/dsh-llm` to `0.1.5-rc.3`, which
  pins `@deepseek-ai/cordis` to exactly 4.0.2 — irreconcilable with the
  0.1.7-era devDependencies the matrix override left in place. Matrix rows now
  pin the `@deepseek-ai/cordis` / `@deepseek-ai/schemastery` pair their DSH
  line shipped with, so every claimed peer version installs coherently again.
  The offline suite passes against the restored 0.1.5-rc.2 closure (38 tests),
  and compatibility is kept rather than dropped: the seam is byte-identical
  across `0.1.5-rc.2`…`0.1.7-rc.2`.

### Changed

- README quick start now installs from npm by name —
  `dsh plugin --profile web add dsh-web-fetch-fakeip@next` — with the local
  checkout path kept as an alternative. `latest` still points at `0.1.0`
  (which targets the older DSH lines), so the document calls out that current
  DSH needs the `next` channel.

## [0.1.1-alpha.2] - 2026-09-28

### Added

- DSH `0.1.7` support: the peer range now also covers `0.1.5-rc.3` (missed
  when it shipped) and every published `0.1.7` prerelease — `0.1.7-alpha.1`,
  `0.1.7-alpha.2`, `0.1.7-rc.1`, `0.1.7-rc.2`. The `0.1.5-rc.3` and `0.1.7`
  tarballs ship a `lib/` that is byte-identical to `0.1.5-rc.2`'s, so the
  plugin's seam usage (`HttpFetchProvider`, `LOCAL_FETCH_PROVIDER_ID`,
  `DEFAULT_USER_AGENT`, `ctx.web.registerFetchProvider`) needs no runtime
  change; the CI matrix now also runs the suite against `0.1.7-rc.2`.

### Changed

- Development dependencies track the `0.1.7-rc.2` stack —
  `@deepseek-ai/cordis` 4.0.4 and `@deepseek-ai/schemastery` 3.18.4, the
  versions a real DSH `0.1.7` install resolves — so local tests exercise the
  same closure the new harness ships. The `@deepseek-ai/cordis` and
  `@deepseek-ai/schemastery` peer ranges already admit both, so they are
  unchanged.

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

[0.2.0]: https://github.com/kaminn/dsh-web-fetch-fakeip/releases/tag/v0.2.0
[0.1.1]: https://github.com/kaminn/dsh-web-fetch-fakeip/releases/tag/v0.1.1
[0.1.1-rc.1]: https://github.com/kaminn/dsh-web-fetch-fakeip/releases/tag/v0.1.1-rc.1
[0.1.1-alpha.2]: https://github.com/kaminn/dsh-web-fetch-fakeip/releases/tag/v0.1.1-alpha.2
[0.1.1-alpha.1]: https://github.com/kaminn/dsh-web-fetch-fakeip/releases/tag/v0.1.1-alpha.1
[0.1.0]: https://github.com/kaminn/dsh-web-fetch-fakeip/releases/tag/v0.1.0
