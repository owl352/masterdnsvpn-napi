// Loads the prebuilt addon for the current platform from binaries/<target>/.
// Target names match build.cjs: `${process.platform}-${process.arch}[-gnu]`.
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

function loadNative () {
  const target = getTarget()
  if (target === null) {
    throw new Error(`masterdnsvpn-node: unsupported platform ${process.platform}-${process.arch}${isMusl() ? ' (musl)' : ''}`)
  }
  const file = path.join(__dirname, '..', 'binaries', target, 'masterdnsvpn.node')
  try {
    return require(file)
  } catch (error) {
    // Only the first line: node appends a multi-line "Require stack" to
    // MODULE_NOT_FOUND messages, which buries the actual reason.
    const reason = String(error?.message ?? error).split('\n')[0]
    throw new Error(`masterdnsvpn-node: failed to load native addon for ${target}: ${reason}`)
  }
}

module.exports = loadNative()
