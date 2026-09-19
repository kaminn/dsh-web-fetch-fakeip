#!/usr/bin/env node
/**
 * Packaging guard: assert that the tarball npm would actually publish contains
 * everything the package needs at runtime, and nothing it must not ship.
 *
 * This exists because a `files` whitelist is easy to get subtly wrong and the
 * failure is invisible until a consumer installs the package: during
 * development the whole working tree is present, so a missing entry only
 * surfaces after publishing. It has already happened once here — `files`
 * omitted `scripts/`, so the diagnostic the README points at was absent from
 * every published tarball.
 *
 * Runs `npm pack --dry-run --json` and checks the resulting file list, so it
 * validates the real packer rather than a reimplementation of it.
 *
 * Usage: node scripts/check-package.mjs
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Files a consumer needs at runtime, or that the README tells them to run. */
const REQUIRED = [
  'package.json',
  'src/index.js',
  'src/config.js',
  'src/resolver.js',
  'cordis.patch.yml',
  'scripts/diagnose.mjs',
  'README.md',
  'LICENSE',
]

/** Paths that must never reach the registry. */
const FORBIDDEN = [
  'node_modules',
  '.git/',
  '.github/',
  'pnpm-lock.yaml',
  'package-lock.json',
]

/** Exit with a readable failure instead of a stack trace. */
function fail(message, details = []) {
  console.error(`check-package: ${message}`)
  for (const line of details) console.error(`  ${line}`)
  process.exit(1)
}

const manifest = JSON.parse(await readFile('package.json', 'utf8'))

// A published package must be public and self-describing. `repository` is not
// cosmetic: npm rejects `--provenance` with E422 when it is absent, which would
// break the release workflow rather than this check.
if (manifest.private === true) fail('package.json sets "private": true — npm publish would refuse it')
if (manifest.repository === undefined) fail('package.json has no "repository" field — provenance publishing fails with E422')

let parsed
try {
  const { stdout } = await exec('npm', ['pack', '--dry-run', '--json'], { maxBuffer: 32 * 1024 * 1024 })
  parsed = JSON.parse(stdout)
} catch (error) {
  fail(`npm pack --dry-run failed: ${error.message}`)
}

const packed = parsed[0]?.files?.map((entry) => entry.path)
if (!Array.isArray(packed) || packed.length === 0) fail('npm pack reported no files')

const present = new Set(packed)
const missing = REQUIRED.filter((path) => !present.has(path))
if (missing.length > 0) {
  fail('the tarball is missing required files (add them to "files" in package.json):', missing)
}

const leaked = packed.filter((path) => FORBIDDEN.some((bad) => path === bad || path.startsWith(bad)))
if (leaked.length > 0) fail('the tarball contains paths that must not be published:', leaked)

// Every subpath the README tells a user to run must also be reachable through
// the `exports` map, or the documented command fails with
// ERR_PACKAGE_PATH_NOT_EXPORTED once the package is installed as a dependency.
const exported = Object.keys(manifest.exports ?? {})
for (const path of REQUIRED) {
  if (!path.startsWith('scripts/')) continue
  const specifier = `./${path}`
  if (!exported.includes(specifier)) {
    fail(`"${path}" ships but is not reachable: add "${specifier}" to "exports"`)
  }
}

console.log(`check-package: OK — ${packed.length} files, ${REQUIRED.length} required present, no forbidden paths`)
