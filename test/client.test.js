import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MasterDnsVpnClient, createClientConfig, defaultClientConfig, validateConfig, version } from '../dist/index.js'

// No MasterDnsVPN server is reachable here: the client binds its local
// listener, fails MTU tests against a dead resolver, and retries until stopped.
function tempResolvers () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'masterdnsvpn-'))
  const file = path.join(dir, 'client_resolvers.txt')
  fs.writeFileSync(file, '127.0.0.1:5399\n')
  return file
}

const config = {
  DOMAINS: ['t.example.com'],
  ENCRYPTION_KEY: 'test-key',
  LISTEN_PORT: 20000 + Math.floor(Math.random() * 20000),
  LOG_LEVEL: 'ERROR',
  MTU_TEST_TIMEOUT: 0.2,
  LOCAL_DNS_CACHE_PERSIST_TO_FILE: false
}

test('version', () => {
  assert.match(version(), /\S/)
})

test('invalid config throws', () => {
  assert.throws(() => new MasterDnsVpnClient({}), /configPath or config is required/)
  assert.throws(() => MasterDnsVpnClient.fromConfig({ DOMAINS: ['x.example.com'] }, { resolversPath: tempResolvers() }), /ENCRYPTION_KEY/)
  assert.throws(() => MasterDnsVpnClient.fromConfigFile('/nonexistent/client_config.toml'))
})

test('overrides apply with coerced types', async () => {
  const client = MasterDnsVpnClient.fromConfig(config, {
    resolversPath: tempResolvers(),
    overrides: { ListenPort: config.LISTEN_PORT + 1, Domains: ['o.example.com'], ProtocolType: 'TCP' }
  })
  const info = client.info()
  assert.equal(info.listenPort, config.LISTEN_PORT + 1)
  assert.deepEqual(info.domains, ['o.example.com'])
  assert.equal(info.protocol, 'TCP')
  assert.equal(info.resolvers, 1)
  await client.destroy()
  assert.throws(() => client.info(), /closed/)
})

test('start and stop', async () => {
  const client = MasterDnsVpnClient.fromConfig(config, { resolversPath: tempResolvers() })
  assert.equal(client.running, false)

  const run = client.start()
  assert.equal(client.running, true)
  await assert.rejects(client.start(), /already started/)

  await new Promise((resolve) => setTimeout(resolve, 500))
  await client.stop()
  await run
  assert.equal(client.running, false)
  await client.destroy()
})

test('validateConfig returns the effective config', () => {
  const loaded = validateConfig({
    config: createClientConfig({ DOMAINS: ['t.example.com'], ENCRYPTION_KEY: 'k' }),
    resolvers: ['1.1.1.1:5353', '10.0.0.0/30'],
    overrides: { ListenPort: 1080 }
  })
  assert.equal(loaded.config.LISTEN_PORT, 1080)
  assert.equal(loaded.config.RESOLVER_BALANCING_STRATEGY, defaultClientConfig.RESOLVER_BALANCING_STRATEGY)
  assert.deepEqual(loaded.config.DOMAINS, ['t.example.com'])
  assert.equal(loaded.resolversPath, '')
  assert.deepEqual(loaded.resolvers[0], { ip: '1.1.1.1', port: 5353 })
  assert.ok(loaded.resolvers.some((r) => r.ip.startsWith('10.0.0.') && r.port === 53))

  assert.throws(() => validateConfig({ config, resolvers: ['1.1.1.1'], resolversPath: tempResolvers() }), /only one of resolversPath and resolvers/)
  assert.throws(() => validateConfig({ config, resolvers: ['not an ip'] }))
})

test('status, connections and log capture', async () => {
  const logs = []
  const client = MasterDnsVpnClient.fromConfig({ ...config, LOG_LEVEL: 'INFO', LISTEN_PORT: config.LISTEN_PORT + 2 }, {
    resolvers: ['127.0.0.1:5399'],
    onLog: (entry) => logs.push(entry)
  })

  assert.deepEqual(client.status(), { running: false, sessionReady: false, sessionId: 0, activeConnections: 0, totalConnections: 1 })
  const [conn] = client.connections()
  assert.equal(conn.domain, 't.example.com')
  assert.equal(conn.resolver, '127.0.0.1')
  assert.equal(conn.resolverPort, 5399)
  assert.equal(conn.valid, false)
  assert.equal(conn.averageRttMs, null)

  const run = client.start()
  assert.equal(client.status().running, true)
  // The dead resolver fails MTU tests, which logs an ERROR.
  for (let i = 0; i < 50 && !logs.some((l) => l.level === 'ERROR'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  await client.stop()
  await run
  assert.equal(client.status().sessionReady, false)
  await client.destroy()

  assert.ok(logs.length > 0, 'no log lines captured')
  const error = logs.find((l) => l.level === 'ERROR')
  assert.ok(error, 'no ERROR line captured')
  assert.ok(error.time instanceof Date && !Number.isNaN(error.time.getTime()))
  assert.doesNotMatch(error.message, /\[ERROR\]|<red>|\x1b/)
})

test('createClientConfig applies the sample defaults', () => {
  const cfg = createClientConfig({ DOMAINS: ['a.example.com'], ENCRYPTION_KEY: 'k', LISTEN_PORT: 1 })
  assert.equal(cfg.LISTEN_PORT, 1)
  assert.equal(cfg.ARQ_WINDOW_SIZE, defaultClientConfig.ARQ_WINDOW_SIZE)
  assert.ok(Object.isFrozen(defaultClientConfig))
})
