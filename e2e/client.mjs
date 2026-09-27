// End-to-end check of masterdnsvpn-node + masterdnsvpn-node-router against a
// real MasterDnsVPN server. Run by e2e/run.sh inside a Linux container.
//   node e2e/client.mjs <proxy|tun> <serverIP>   (env MDV_KEY: server key)
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { MasterDnsVpnClient, createClientConfig } from 'masterdnsvpn-node'
import { Router } from 'masterdnsvpn-node-router'

const [mode, serverIP] = process.argv.slice(2)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const curl = (...args) => new Promise((resolve) => execFile('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '60', ...args], (e, out) => resolve(e ? `exit ${e.code}` : out)))
const check = (name, actual, expected) => {
  console.log(`${actual === expected ? 'PASS' : 'FAIL'} ${name}: ${actual}`)
  assert.equal(actual, expected, name)
}

const client = MasterDnsVpnClient.fromConfig(createClientConfig({
  DOMAINS: ['t.example.com'],
  ENCRYPTION_KEY: process.env.MDV_KEY,
  LISTEN_PORT: 18000,
  LOCAL_DNS_CACHE_PERSIST_TO_FILE: false,
  MIN_DOWNLOAD_MTU: 100
}), { resolvers: [`${serverIP}:53`], onLog: () => {} })
const run = client.start()
for (let i = 0; i < 120 && !client.status().sessionReady; i++) await sleep(500)
check('client session ready', client.status().sessionReady, true)

const router = new Router(client, {
  mode,
  proxy: { port: 2080 },
  // Keep clear of Docker's 172.16/12 networks and any host fake-IP range.
  tun: { address: ['10.250.0.1/30'] },
  dns: { fakeIp: { inet4Range: '100.80.0.0/16', inet6Range: 'fd80::/18' } },
  rules: [
    { domainSuffix: ['example.org'], outbound: 'direct' },
    { domain: ['blocked.example.net'], outbound: 'block' }
  ]
})
await router.start()

const via = mode === 'proxy' ? ['-x', 'socks5h://127.0.0.1:2080'] : []
check('proxied example.com', await curl(...via, 'http://example.com/'), '200')
check('direct example.org', await curl(...via, 'http://example.org/'), '200')
check('blocked domain', (await curl(...via, 'http://blocked.example.net/')).startsWith('exit'), true)

if (mode === 'tun') {
  const session = client.status().sessionId
  await router.setMode('proxy')
  check('after setMode(proxy)', await curl('-x', 'socks5h://127.0.0.1:2080', 'http://example.com/'), '200')
  check('tunnel session kept', client.status().sessionId, session)
}

await router.stop()
await client.stop()
await run
await client.destroy()
console.log('PASS clean shutdown')
