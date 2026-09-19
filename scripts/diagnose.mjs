#!/usr/bin/env node
/**
 * Diagnostic: report what this machine's DNS actually answers, and whether the
 * configured placeholder ranges cover it.
 *
 * Run this first when `web_fetch` fails. It distinguishes the three cases that
 * look alike from the tool's error message:
 *
 *   1. fake-ip DNS, and the ranges are configured correctly -> the plugin
 *      should work; if it does not, the proxy is not routing;
 *   2. fake-ip DNS, but on a block you have not configured -> set
 *      `fakeIpRanges` to the reported block;
 *   3. no fake-ip DNS -> this plugin is not what you need.
 *
 * Usage:
 *   node scripts/diagnose.mjs [hostname ...]
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'

import { Config } from '../src/config.js'
import { compileFakeIpRanges, isFakeIpAddress, isPublicIpAddress } from '../src/resolver.js'

const hosts = process.argv.slice(2)
const targets = hosts.length > 0 ? hosts : ['example.com', 'www.google.com', 'api.github.com']

const ranges = compileFakeIpRanges(Config({}).fakeIpRanges)
const configured = ranges.map((range) => range.cidr)

console.log('configured fake-ip ranges:', configured.join(', '))
console.log('')

let sawFakeIp = false
let sawUncoveredFakeIp = false
let sawPublic = false

for (const host of targets) {
  if (isIP(host) !== 0) {
    console.log(`${host.padEnd(24)} literal      public=${isPublicIpAddress(host)}`)
    continue
  }
  let answers
  try {
    answers = await lookup(host, { all: true, order: 'verbatim' })
  } catch (error) {
    console.log(`${host.padEnd(24)} LOOKUP FAILED  ${error.code ?? error.message}`)
    continue
  }
  for (const entry of answers) {
    const fake = isFakeIpAddress(entry.address, ranges)
    const pub = isPublicIpAddress(entry.address)
    let verdict
    if (fake) {
      verdict = 'fake-ip (covered by config) -> plugin will accept'
      sawFakeIp = true
    } else if (!pub) {
      verdict = 'reserved/private, NOT covered by config -> would be blocked'
      sawUncoveredFakeIp = true
    } else {
      verdict = 'public unicast -> normal path'
      sawPublic = true
    }
    const range = safeRange(entry.address)
    console.log(`${host.padEnd(24)} ${entry.address.padEnd(16)} [${range}] ${verdict}`)
  }
}

console.log('')

if (sawFakeIp && !sawUncoveredFakeIp) {
  console.log('VERDICT: fake-ip DNS is active and covered by the configured ranges.')
  console.log('         This plugin is the right fix. If web_fetch still fails, the')
  console.log('         failure is downstream of destination policy (proxy routing).')
} else if (sawUncoveredFakeIp) {
  console.log('VERDICT: reserved addresses were returned that the configured ranges do')
  console.log('         NOT cover. Set fakeIpRanges to the block reported above, then')
  console.log('         re-run this script. The proxy config key is usually')
  console.log('         `dns.fake-ip-range` (mihomo/Clash) or `dns.fakeip.range` (sing-box).')
} else if (sawPublic) {
  console.log('VERDICT: no fake-ip placeholders seen. This machine resolves hostnames to')
  console.log('         real public addresses, so the stock provider is already correct')
  console.log('         and this plugin changes nothing for these hosts.')
} else {
  console.log('VERDICT: inconclusive — no usable answers were obtained.')
}

/** The ipaddr.js range label, for orientation only. */
function safeRange(address) {
  try {
    const parsed = ipaddr.parse(address)
    return parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()
      ? parsed.toIPv4Address().range()
      : parsed.range()
  } catch {
    return 'unparseable'
  }
}
