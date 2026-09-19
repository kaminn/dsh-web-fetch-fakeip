# Releasing

This package publishes to npm through **Trusted Publishing (OIDC)** from GitHub
Actions. There is no `NPM_TOKEN` secret in this repository, and every published
tarball carries a provenance attestation binding it to the exact workflow run
and commit that produced it.

## One-time setup

Two of these can only be done once, by hand, and one of them is **irreversible**.

### 1. Publish the first version manually

npm configures a trusted publisher **per package**, and a package must already
exist before you can configure one. So the first version is published by hand:

```sh
npm login
npm whoami                    # confirm the account you expect
npm publish --dry-run         # inspect exactly what would be uploaded
npm publish --access public   # claims the name on npm — this cannot be undone
```

> **This step is permanent.** Once a version is published the name is claimed;
> `npm unpublish` is only possible for 72 hours, and never once another package
> depends on it. Run `npm run verify` first.

### 2. Configure the trusted publisher

1. Go to `https://www.npmjs.com/package/dsh-web-fetch-fakeip/access`.
2. Under **Trusted Publishers**, click **Add trusted publisher**.
3. Choose **GitHub Actions** and fill in:
   - **Organization or user:** `kaminn`
   - **Repository:** `dsh-web-fetch-fakeip`
   - **Workflow filename:** `release.yml`
   - **Environment:** *(leave blank)*
4. Save. Do **not** add an `NPM_TOKEN` secret — Trusted Publishing replaces it.

The workflow filename must match exactly. If you ever rename
`.github/workflows/release.yml`, come back and re-do this step.

### 3. (Optional) Disable token-based publishing

On the same Access page you can revoke any classic or granular tokens, so the
trusted publisher is the only way to publish. Recommended once a release has
succeeded end-to-end.

## Cutting a release

Everything below is reversible until the tag is pushed.

```sh
# 1. Start from a clean, passing default branch.
git status
npm run verify

# 2. Move the CHANGELOG entries out of [Unreleased] into a new version section.
#    The release workflow extracts notes from "## [<version>]" and fails if the
#    section is missing, so this is required rather than optional.
$EDITOR CHANGELOG.md

# 3. Bump the version, commit, and tag in one step.
npm version minor          # or: patch | major | x.y.z
                           # creates commit "vX.Y.Z" + tag vX.Y.Z

# 4. Push the commit and the tag.
git push
git push --tags
```

The tag push triggers `release.yml`, which:

1. validates that the tag equals `v` + `package.json` version, and that the
   manifest is publishable (a missing `repository` field would make npm reject
   provenance with `E422`, so it is caught here instead of mid-publish);
2. extracts this version's section from `CHANGELOG.md`;
3. checks whether this exact version is already on npm;
4. runs `npm run verify` and publishes with `--provenance --access public`,
   unless step 3 found it already published;
5. creates or updates the GitHub Release, **after** npm confirms the version is
   queryable.

Watch it at `https://github.com/kaminn/dsh-web-fetch-fakeip/actions`.

## Re-running a failed release

The workflow is idempotent, so re-run it without deleting anything:

- **Actions** → **Release** → **Run workflow** → enter the existing tag.
- Tick **dry_run** to pack and verify without publishing.

A version already on npm skips the publish steps and proceeds to reconcile the
GitHub Release, so a failure after publishing does not attempt a duplicate
publish (npm would reject that with a 403 and leave the run red for no reason).

If the failure happened *before* publishing and you need to change the commit
the tag points at, delete and re-push the tag:

```sh
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
# fix, then re-tag and push
```

That is safe only while the version is unpublished. Once npm has the version,
the tag and the published tarball must not diverge — publish a new patch
version instead.

## If a release turns out to be broken

```sh
# Preferred: mark it deprecated. Pinned users keep a working install.
npm deprecate dsh-web-fetch-fakeip@X.Y.Z "broken; use X.Y.Z+1"

# Only within 72 hours, and only if nothing depends on it.
npm unpublish dsh-web-fetch-fakeip@X.Y.Z
```

An unpublished version number cannot be reused for 24 hours.

## Pre-flight checklist

- [ ] `npm run verify` passes locally
- [ ] `npm run pack:check` reports the expected file list
- [ ] `CHANGELOG.md` has a `## [<version>]` section for the version being tagged
- [ ] `peerDependencies` still list every DSH version the test matrix covers
- [ ] `package.json#version` is bumped (`npm version` does this for you)

## How the pieces fit

| File | Role |
| --- | --- |
| `.github/workflows/ci.yml` | Tests, packaging guard, and live transport lane on every push/PR. Never publishes. |
| `.github/workflows/release.yml` | Tag-driven publish. Binds to the npm trusted publisher by filename. |
| `scripts/release-control.mjs` | `validate` / `check` / `notes` / `release` subcommands, unit-tested in `test/release-control.test.js`. |
| `scripts/check-package.mjs` | Fails when the tarball is missing a required file or ships a forbidden one. |

The two workflows are deliberately separate files: the trusted publisher binds
to one exact filename, so keeping publishing out of `ci.yml` means CI can be
edited freely without touching npm configuration.
