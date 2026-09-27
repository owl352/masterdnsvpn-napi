// Loads the prebuilt addon for the current platform.
//
// When the optional masterdnsvpn-node-router package is installed, its binary
// is loaded instead: it contains the same client plus the sing-box router, and
// only one Go runtime may live in a process. Set MASTERDNSVPN_NODE_FLAVOR=core
// to force the client-only binary.
//
// Target names match build.cjs: `${process.platform}-${process.arch}[-gnu]`.
const fs = require('node:fs')
const path = require('node:path')

function isMusl () {
  if (process.platform !== 'linux') return false
  try {
    const report = process.report?.getReport?.()
    return !report?.header?.glibcVersionRuntime
  } catch {
    // getReport() is unavailable in some embedders; assume glibc.
    return false
  }
}

function getTarget () {
  const base = `${process.platform}-${process.arch}`
  switch (process.platform) {
    case 'darwin':
    case 'win32':
      return base
    case 'linux':
      // Go c-shared libraries cannot be loaded on musl (golang/go#13492).
      return isMusl() ? null : `${base}-gnu`
    default:
      return null
  }
}

function routerBinary (target) {
  if (process.env.MASTERDNSVPN_NODE_FLAVOR === 'core') return null
  let pkg
  try {
    pkg = require.resolve('masterdnsvpn-node-router/package.json')
  } catch {
    return null
  }
  const file = path.join(path.dirname(pkg), 'binaries', target, 'masterdnsvpn.node')
  return fs.existsSync(file) ? file : null
}

function loadNative () {
  const target = getTarget()
  if (target === null) {
    throw new Error(`masterdnsvpn-node: unsupported platform ${process.platform}-${process.arch}${isMusl() ? ' (musl)' : ''}`)
  }
  const file = routerBinary(target) ?? path.join(__dirname, '..', 'binaries', target, 'masterdnsvpn.node')
  try {
    return require(file)
  } catch (error) {
    // Only the first line: node appends a multi-line "Require stack" to
    // MODULE_NOT_FOUND messages, which buries the actual reason.
    const reason = String(error?.message ?? error).split('\n')[0]
    throw new Error(`masterdnsvpn-node: failed to load native addon ${file}: ${reason}`)
  }
}

module.exports = loadNative()
