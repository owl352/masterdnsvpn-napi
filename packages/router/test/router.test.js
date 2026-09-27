import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { MasterDnsVpnClient, createClientConfig, hasRouter } from 'masterdnsvpn-node'
import { Router, singBoxVersion } from '../dist/index.js'

// Proxy mode against a local HTTP server, without a MasterDnsVPN server:
// direct and blocked traffic is fully checkable; proxied traffic reaches the
// client's SOCKS5 listener (seen in the router log) but no tunnel exists.
const port = (base) => base + Math.floor(Math.random() * 10000)

function listen () {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => res.end(`hello ${req.headers.host}`))
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

// GET through the router's mixed inbound used as an HTTP proxy, one
// connection per request (a rejected keep-alive socket must not be reused).
function viaProxy (proxyPort, url) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: proxyPort, path: url, headers: { host: new URL(url).host }, agent: false, timeout: 5000 }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (error) => resolve({ error: error.message }))
  })
}

async function waitFor (predicate, ms = 3000) {
  for (let waited = 0; waited < ms && !predicate(); waited += 50) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return predicate()
}

function newClient () {
  return MasterDnsVpnClient.fromConfig(createClientConfig({
    DOMAINS: ['t.example.com'],
    ENCRYPTION_KEY: 'k',
    LISTEN_PORT: port(20000),
    LOG_LEVEL: 'ERROR',
    LOCAL_DNS_CACHE_PERSIST_TO_FILE: false
  }), { resolvers: ['127.0.0.1:5399'], onLog: () => {} })
}

// Resolve the test domains to the local server without real DNS.
const hostsDns = (o) => {
  o.dns.servers[1] = { type: 'hosts', tag: 'dns-direct', predefined: { 'direct.test': '127.0.0.1', 'later.test': '127.0.0.1' } }
  return o
}

test('router binary is loaded', () => {
  assert.equal(hasRouter(), true)
  assert.match(singBoxVersion(), /^v\d+\.\d+/)
})

test('proxy mode routes direct / block / proxy and applies rule updates', async () => {
  const server = await listen()
  const target = server.address().port
  const client = newClient()
  const logs = []
  const proxyPort = port(40000)
  const router = new Router(client, {
    mode: 'proxy',
    proxy: { port: proxyPort },
    bypassPrivate: false,
    logLevel: 'info',
    rules: [
      { domain: ['direct.test'], outbound: 'direct' },
      { domain: ['blocked.test'], outbound: 'block' }
    ],
    singBox: hostsDns
  }, { onLog: (entry) => logs.push(entry) })

  try {
    await router.start()
    assert.equal(router.running, true)
    await assert.rejects(router.start(), /already running/)

    const direct = await viaProxy(proxyPort, `http://direct.test:${target}/`)
    assert.equal(direct.status, 200)
    assert.equal(direct.body, `hello direct.test:${target}`)

    const blocked = await viaProxy(proxyPort, `http://blocked.test:${target}/`)
    assert.notEqual(blocked.status, 200)

    await viaProxy(proxyPort, `http://proxied.test:${target}/`)
    // Log lines arrive asynchronously.
    const reachedTunnel = await waitFor(() => logs.some((l) => l.message.includes('outbound/socks[proxy]') && l.message.includes('proxied.test')))
    assert.ok(reachedTunnel, 'proxied traffic did not reach the tunnel outbound:\n' + logs.map((l) => l.message).join('\n'))
    assert.ok(logs.every((l) => !l.raw.includes('outbound/direct') || !l.raw.includes('proxied.test')))

    await router.setRules([{ domain: ['later.test'], outbound: 'direct' }])
    const later = await viaProxy(proxyPort, `http://later.test:${target}/`)
    assert.equal(later.status, 200)
    assert.equal((await viaProxy(proxyPort, `http://direct.test:${target}/`)).status === 200, false, 'old rule still applied')
  } finally {
    await router.stop()
    assert.equal(router.running, false)
    await client.destroy()
    server.close()
  }
})

test('router rejects clients in TCP mode and TUN subnets containing a resolver', async () => {
  const tcpClient = MasterDnsVpnClient.fromConfig(createClientConfig({ DOMAINS: ['t.example.com'], ENCRYPTION_KEY: 'k', PROTOCOL_TYPE: 'TCP' }), { resolvers: ['127.0.0.1:5399'] })
  await assert.rejects(new Router(tcpClient, { mode: 'proxy' }).start(), /PROTOCOL_TYPE SOCKS5/)
  await tcpClient.destroy()

  const client = MasterDnsVpnClient.fromConfig(createClientConfig({ DOMAINS: ['t.example.com'], ENCRYPTION_KEY: 'k' }), { resolvers: ['10.9.0.2'] })
  await assert.rejects(new Router(client, { mode: 'tun', tun: { address: ['10.9.0.1/30'] } }).start(), /contains resolver 10\.9\.0\.2/)
  await client.destroy()
})
