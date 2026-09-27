import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultClientConfig } from '../dist/index.js'

// Checks src/config.ts against config.ClientConfig in the MasterDnsVPN
// submodule, so upstream field additions/renames are caught on a bump.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const goFile = path.join(root, 'MasterDnsVPN', 'internal', 'config', 'client.go')
const tsFile = path.join(root, 'src', 'config.ts')

function goFields () {
  const src = fs.readFileSync(goFile, 'utf8')
  const body = src.match(/type ClientConfig struct \{([\s\S]*?)\n\}/)[1]
  return [...body.matchAll(/^\s*([A-Z]\w*)\s+(\S+)\s+`toml:"([^"]+)"`/gm)]
    .filter(([, , , tag]) => tag !== '-')
    .map(([, name, , tag]) => ({ name, tag }))
}

function tsKeys (iface) {
  const src = fs.readFileSync(tsFile, 'utf8')
  const body = src.match(new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`))[1]
  return new Set([...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]))
}

const skip = !fs.existsSync(goFile) && 'MasterDnsVPN submodule not checked out'

test('ClientConfig has every TOML key', { skip }, () => {
  const keys = tsKeys('ClientConfig')
  const fields = goFields()
  assert.ok(fields.length > 50)
  assert.deepEqual(fields.map((f) => f.tag).filter((t) => !keys.has(t)), [], 'missing in ClientConfig')
  assert.deepEqual([...keys].filter((k) => !fields.some((f) => f.tag === k)), [], 'unknown in ClientConfig')
})

test('ClientConfigOverrides has every Go field', { skip }, () => {
  const keys = tsKeys('ClientConfigOverrides')
  const fields = goFields()
  assert.deepEqual(fields.map((f) => f.name).filter((n) => !keys.has(n)), [], 'missing in ClientConfigOverrides')
  assert.deepEqual([...keys].filter((k) => !fields.some((f) => f.name === k)), [], 'unknown in ClientConfigOverrides')
})

test('defaultClientConfig matches client_config.toml.simple', { skip }, () => {
  const sample = fs.readFileSync(path.join(root, 'MasterDnsVPN', 'client_config.toml.simple'), 'utf8')
  // Every value in the sample is valid JSON (quoted strings, numbers, bools, string arrays).
  const values = Object.fromEntries(
    [...sample.matchAll(/^([A-Z0-9_]+)\s*=\s*(.+?)\s*$/gm)].map(([, key, value]) => [key, JSON.parse(value)])
  )
  delete values.DOMAINS
  delete values.ENCRYPTION_KEY
  assert.deepEqual({ ...defaultClientConfig }, values)
})
