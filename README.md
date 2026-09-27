# masterdnsvpn-node

Node-API bindings for the [MasterDnsVPN](https://github.com/masterking32/MasterDnsVPN) client, shipped as prebuilt native addons for desktop platforms.

| Package | What | Size per platform |
| --- | --- | --- |
| [`masterdnsvpn-node`](packages/core) | The client: config, start/stop, status, logs | ~5 MB |
| [`masterdnsvpn-node-router`](packages/router) (optional) | TUN mode, local proxy / system proxy, direct/proxy/block rules (embedded sing-box) | ~19–26 MB |

The router is a separate, optional install, so apps that only need the client don't carry sing-box or need admin rights.

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

## Router (optional)

```sh
npm install masterdnsvpn-node masterdnsvpn-node-router
```

```js
import { MasterDnsVpnClient, createClientConfig } from 'masterdnsvpn-node'
import { Router } from 'masterdnsvpn-node-router'

const client = MasterDnsVpnClient.fromConfig(createClientConfig({ DOMAINS: ['v.example.com'], ENCRYPTION_KEY: '...' }), { resolvers })
client.start()

const router = new Router(client, {
  mode: 'proxy',                                  // or 'tun'
  proxy: { port: 2080, systemProxy: true },       // proxy mode: SOCKS5 + HTTP on 127.0.0.1:2080
  rules: [                                        // first match wins
    { domainSuffix: ['example.ir'], outbound: 'direct' },
    { ipCidr: ['192.0.2.0/24'], outbound: 'direct' },
    { processName: ['Telegram'], outbound: 'proxy' },
    { domainKeyword: ['ads'], outbound: 'block' },
  ],
  final: 'proxy',                                 // everything else
}, { onLog: ({ level, message }) => console.log(level, message) })

await router.start()
await router.setRules([...])     // applied live
await router.setMode('tun')      // switches live; the client's tunnel session is kept
await router.stop()              // restores routes / system proxy
```

- **Proxy mode**: a local SOCKS5/HTTP proxy that apps opt into, optionally set as the OS system proxy. No privileges needed.
- **TUN mode**: captures all traffic with a TUN device and automatic routes. **Needs admin/root** (root or `CAP_NET_ADMIN` on Linux, root on macOS, Administrator on Windows), so in a desktop app run it in a privileged helper. wintun is embedded on Windows.
- Private/LAN destinations go direct unless `bypassPrivate: false`.
- DNS follows the rules: direct domains use the system resolver (or `dns.direct`), blocked ones get NXDOMAIN. In TUN mode proxied domains get fake IPs (`dns.fakeIp`, default `198.18.0.0/15`) so no DNS round-trip goes through the slow tunnel and the server resolves the name; `ipCidr` rules therefore can't match proxied domains' real IPs. Without fake IPs they're resolved over TCP through the tunnel (`dns.remote`, default `1.1.1.1`).
- The client must use `PROTOCOL_TYPE = "SOCKS5"`. The client's resolvers are excluded from the TUN routes automatically, and a TUN `address` that contains a resolver is refused (it would loop the tunnel into itself).
- `router.singBoxOptions()` shows the generated sing-box config; the `singBox` option can edit it for anything the typed options don't cover.

## How it works

```
packages/core     masterdnsvpn-node          TS API, loader, core binaries
packages/router   masterdnsvpn-node-router   TS API, router binaries
native/           Go + C addon sources (shared by both binaries)
MasterDnsVPN/     upstream, git submodule
build.cjs         builds both flavors for all targets
e2e/              Docker end-to-end test against a real server
```

MasterDnsVPN is a Go module whose packages all live under `internal/`, so it cannot be imported from another module. Instead:

- `MasterDnsVPN/` is a git submodule pinned to an upstream commit.
- `native/*.go` is injected into that module as `masterdnsvpn-go/napibind` with `go build -overlay`, which makes the `internal/` imports legal without patching upstream.
- The addon is built with `-buildmode=c-shared`. The Node-API glue is C in the cgo preamble of `native/napi.go`, against the headers from `node-api-headers`.
- Node-API symbols resolve from the host process: `-undefined dynamic_lookup` on macOS, undefined symbols in the ELF on Linux, and an import library for `node.exe` built by `zig dlltool` on Windows.
- Linux and Windows are cross-compiled with `zig cc`; macOS uses the system clang.
- `onLog`: the upstream logger writes to whatever `os.Stdout` is when it is created and has no hook, so the addon briefly points `os.Stdout` at a pipe while the client is constructed, then forwards each line to JS.
- Inline `resolvers` are written to a temp file for the upstream loader and removed right after loading.
- **Two flavors, one runtime.** Only one Go runtime can live in a process, so the router is not a second addon: the router package ships a superset binary (client + sing-box, built with `-tags router`), and the core loader loads it instead of the core binary when `masterdnsvpn-node-router` is installed. `MASTERDNSVPN_NODE_FLAVOR=core` forces the core binary.
- sing-box is not in upstream's `go.mod`, so the router flavor builds with `-modfile=native/router.mod` (upstream's requirements plus sing-box, regenerated by `npm run router:deps`). Only the protocols the router uses are registered (tun, mixed, direct, socks and a few DNS transports).
- The router talks to the client over its local SOCKS5 listener: the addon adds a `proxy` outbound pointing at it, plus TUN route exclusions for the resolvers.

## Building

Requirements: Go (version from `native/router.mod`), zig 0.15, Node 22+, and a macOS host for the darwin targets.

```sh
git submodule update --init
npm ci
npm run build:full                                   # both flavors, all targets, then TypeScript
NATIVE_BUILD_TARGET=host npm run build:bin           # current platform only
FLAVOR=core NATIVE_BUILD_TARGET=linux-x64-gnu,win32-x64 npm run build:bin
npm test                                             # both packages (router binary)
MASTERDNSVPN_NODE_FLAVOR=core npm test -w masterdnsvpn-node
./e2e/run.sh                                         # Docker: proxy + TUN against a real server
```

Binaries land in `packages/<core|router>/binaries/<target>/masterdnsvpn.node`.

Updating dependencies:
- **MasterDnsVPN**: check out a new commit in the submodule, then `npm run router:deps` and rebuild. The tests check the config types and `defaultClientConfig` against the submodule. The version from `git describe` is stamped into the binary (`MASTERDNSVPN_VERSION` overrides it).
- **sing-box**: `SING_BOX_VERSION=vX.Y.Z npm run router:deps`, rebuild, run the router tests and `e2e/run.sh`.
