# masterdnsvpn-node

Node-API bindings for the [MasterDnsVPN](https://github.com/masterking32/MasterDnsVPN) client, shipped as prebuilt native addons for desktop platforms.

| Target            | Notes                         |
| ----------------- | ----------------------------- |
| `darwin-arm64`    | macOS 13+                     |
| `darwin-x64`      | macOS 13+                     |
| `linux-x64-gnu`   | glibc 2.28+                   |
| `linux-arm64-gnu` | glibc 2.28+                   |
| `win32-x64`       | Windows 10+ (UCRT)            |
| `win32-arm64`     | Windows 10+ (UCRT)            |

musl (Alpine) is not supported: Go `c-shared` libraries cannot be `dlopen`ed on musl ([golang/go#13492](https://github.com/golang/go/issues/13492)).

## Usage

```js
import { MasterDnsVpnClient, createClientConfig, validateConfig, version } from 'masterdnsvpn-node'

// The repo's recommended config (client_config.toml.simple) plus your own values.
const config = createClientConfig({
  DOMAINS: ['v.example.com'],
  ENCRYPTION_KEY: '...',
  LISTEN_PORT: 1080,
})

const client = MasterDnsVpnClient.fromConfig(config, {
  resolvers: ['8.8.8.8', '1.1.1.1:5353', '192.168.1.0/30'], // or resolversPath
  onLog: ({ level, message, time }) => console.log(level, message), // instead of stdout
  logPath: './client.log',                                         // optional, in addition
})

const run = client.start() // settles when the client stops; keeps the event loop alive
setInterval(() => console.log(client.status()), 5000)
// { running, sessionReady, sessionId, activeConnections, totalConnections }
process.on('SIGINT', () => client.stop())
await run
await client.destroy()
```

| API | |
| --- | --- |
| `MasterDnsVpnClient.fromConfig(config, options)` / `.fromConfigFile(path, options)` / `new MasterDnsVpnClient(options)` | Loads the config and resolvers; throws if invalid. |
| `start()` / `stop()` / `wait()` / `destroy()` | A client runs once; create a new one to run again. |
| `info()` | Loaded config facts: listener, protocol, domains, resolver count. |
| `status()` | Session readiness and active/total resolver connections. Cheap to poll. |
| `connections()` | Every domain/resolver pair: validity, upload/download MTU, average RTT, last health check. |
| `validateConfig(options)` | Loads a config the same way without creating a client and returns every effective value and the expanded resolvers. |
| `defaultClientConfig` / `createClientConfig()` | The values from `client_config.toml.simple`, without `DOMAINS`/`ENCRYPTION_KEY`. |
| `ClientConfig`, `ClientConfigOverrides` | Types for config objects (TOML keys) and `overrides` (Go field names, like the CLI flags). |
| `version()` | MasterDnsVPN version stamped into the addon. |

The tests check the config types and `defaultClientConfig` against the submodule, so a MasterDnsVPN bump that adds or renames fields fails `npm test`.

## How it works

MasterDnsVPN is a Go module whose packages all live under `internal/`, so it cannot be imported from another module. Instead:

- `MasterDnsVPN/` is a git submodule pinned to an upstream commit.
- `native/*.go` is injected into that module as `masterdnsvpn-go/napibind` with `go build -overlay`, which makes the `internal/` imports legal without patching upstream.
- The addon is built with `-buildmode=c-shared`. The Node-API glue is C in the cgo preamble of `native/napi.go`, against the headers from `node-api-headers`.
- Node-API symbols resolve from the host process: `-undefined dynamic_lookup` on macOS, undefined symbols in the ELF on Linux, and an import library for `node.exe` built by `zig dlltool` on Windows.
- Linux and Windows are cross-compiled with `zig cc`; macOS uses the system clang.
- `onLog`: the upstream logger writes to whatever `os.Stdout` is when it is created and has no hook, so the addon briefly points `os.Stdout` at a pipe while the client is constructed, then forwards each line to JS.
- Inline `resolvers` are written to a temp file for the upstream loader and removed right after loading.

## Building

Requirements: Go (version from `MasterDnsVPN/go.mod`), zig 0.15, Node 20+, and a macOS host for the darwin targets.

```sh
git submodule update --init
npm ci
npm run build:full                                # all targets, then TypeScript
NATIVE_BUILD_TARGET=host npm run build:bin        # current platform only
NATIVE_BUILD_TARGET=linux-x64-gnu,win32-x64 npm run build:bin
npm test
```

Binaries land in `binaries/<target>/masterdnsvpn.node`. To update MasterDnsVPN, check out a new commit in the submodule and rebuild. The version from `git describe` is stamped into the binary; set `MASTERDNSVPN_VERSION` to override it.
