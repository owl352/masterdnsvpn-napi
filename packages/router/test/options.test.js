import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toSingBoxOptions } from '../dist/options.js'

const rules = [
  { domainSuffix: ['example.org'], outbound: 'direct' },
  { domain: ['blocked.example'], outbound: 'block' },
  { ipCidr: ['10.1.0.0/16'], processName: ['curl'], outbound: 'proxy' }
]

test('proxy mode: mixed inbound, rules, tunnel DNS', () => {
  const o = toSingBoxOptions({ mode: 'proxy', proxy: { port: 1080, systemProxy: true }, rules })
  assert.deepEqual(o.inbounds, [{ type: 'mixed', tag: 'proxy-in', listen: '127.0.0.1', listen_port: 1080, set_system_proxy: true }])
  assert.deepEqual(o.outbounds, [{ type: 'direct', tag: 'direct' }])
  assert.deepEqual(o.route.rules, [
    { action: 'sniff' },
    { ip_is_private: true, action: 'route', outbound: 'direct' },
    { domain_suffix: ['example.org'], action: 'route', outbound: 'direct' },
    { domain: ['blocked.example'], action: 'reject' },
    { ip_cidr: ['10.1.0.0/16'], process_name: ['curl'], action: 'route', outbound: 'proxy' }
  ])
  assert.equal(o.route.final, 'proxy')
  assert.deepEqual(o.dns.servers.map((s) => s.tag), ['dns-remote', 'dns-direct'])
  assert.deepEqual(o.dns.servers[0], { type: 'tcp', tag: 'dns-remote', server: '1.1.1.1', detour: 'proxy' })
  assert.deepEqual(o.dns.rules, [
    { domain_suffix: ['example.org'], action: 'route', server: 'dns-direct' },
    { domain: ['blocked.example'], action: 'predefined', rcode: 'NXDOMAIN' }
  ])
  assert.equal(o.dns.final, 'dns-remote')
})

test('tun mode: auto route, DNS hijack, fake IPs for proxied domains', () => {
  const o = toSingBoxOptions({ mode: 'tun', rules, tun: { routeExcludeAddress: ['192.0.2.0/24'] } })
  assert.equal(o.inbounds[0].type, 'tun')
  assert.equal(o.inbounds[0].auto_route, true)
  assert.equal(o.inbounds[0].strict_route, true)
  assert.deepEqual(o.inbounds[0].route_exclude_address, ['192.0.2.0/24'])
  assert.deepEqual(o.route.rules[1], { protocol: 'dns', action: 'hijack-dns' })
  assert.equal(o.route.auto_detect_interface, true)
  assert.deepEqual(o.dns.servers[2], { type: 'fakeip', tag: 'dns-fake', inet4_range: '198.18.0.0/15', inet6_range: 'fc00::/18' })
  assert.deepEqual(o.dns.rules.at(-1), { query_type: ['A', 'AAAA'], action: 'route', server: 'dns-fake' })
})

test('tun mode without fake IPs, final direct', () => {
  const o = toSingBoxOptions({
    mode: 'tun',
    final: 'direct',
    dns: { fakeIp: false, direct: '9.9.9.9' },
    rules: [{ domainSuffix: ['proxied.example'], outbound: 'proxy' }]
  })
  assert.equal(o.dns.servers.length, 2)
  assert.deepEqual(o.dns.servers[1], { type: 'udp', tag: 'dns-direct', server: '9.9.9.9' })
  assert.deepEqual(o.dns.rules, [{ domain_suffix: ['proxied.example'], action: 'route', server: 'dns-remote' }])
  assert.equal(o.dns.final, 'dns-direct')
  assert.equal(o.route.final, 'direct')
})

test('bypassPrivate: false and singBox hook', () => {
  const o = toSingBoxOptions({ mode: 'proxy', bypassPrivate: false, singBox: (x) => ({ ...x, experimental: { a: 1 } }) })
  assert.deepEqual(o.route.rules, [{ action: 'sniff' }])
  assert.deepEqual(o.experimental, { a: 1 })
})

test('invalid options throw', () => {
  assert.throws(() => toSingBoxOptions({ mode: 'vpn' }), /invalid router mode/)
  assert.throws(() => toSingBoxOptions({ mode: 'proxy', final: 'block' }), /invalid final/)
  assert.throws(() => toSingBoxOptions({ mode: 'proxy', rules: [{ outbound: 'direct' }] }), /at least one match field/)
  assert.throws(() => toSingBoxOptions({ mode: 'proxy', rules: [{ domain: ['a'], outbound: 'nowhere' }] }), /invalid rule outbound/)
})
