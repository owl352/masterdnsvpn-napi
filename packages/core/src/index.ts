import { createRequire } from 'node:module'
import path from 'node:path'
import type { ClientConfig, ClientConfigOverrides, LogLevel, ProtocolType } from './config.js'

export * from './config.js'

interface NativeBinding {
  version: () => string
  loadConfig: (optionsJson: string) => string
  clientCreate: (optionsJson: string, onLog?: (line: string) => void) => number
  clientStart: (id: number) => Promise<void>
  clientStop: (id: number) => boolean
  clientDestroy: (id: number) => void
  clientInfo: (id: number) => string
  clientStatus: (id: number) => string
  clientConnections: (id: number) => string
}

const native: NativeBinding = createRequire(import.meta.url)('../lib/loader.cjs')

/**
 * Key for a client's native handle, used by the optional
 * masterdnsvpn-node-router package. Not part of the public API.
 * @internal
 */
export const nativeHandle: unique symbol = Symbol.for('masterdnsvpn-node.handle')

/**
 * True when the router binary (from masterdnsvpn-node-router) is loaded
 * instead of the client-only one.
 */
export function hasRouter (): boolean {
  return typeof (native as unknown as Record<string, unknown>).routerCreate === 'function'
}

/** Where the config comes from; shared by the client and {@link validateConfig}. */
export interface ConfigOptions {
  /**
   * Path to a client_config.toml (or .json). Relative paths resolve against
   * process.cwd(). Mutually exclusive with `config`.
   */
  configPath?: string
  /**
   * Config object with the same keys as client_config.toml.
   * Mutually exclusive with `configPath`.
   */
  config?: ClientConfig
  /**
   * Resolvers file. Defaults to client_resolvers.txt next to `configPath`,
   * or in process.cwd() when `config` is used. Mutually exclusive with `resolvers`.
   */
  resolversPath?: string
  /**
   * Resolvers inline, one entry per line of a resolvers file:
   * `8.8.8.8`, `1.1.1.1:5353`, `192.168.1.0/30`, `[2001:4860:4860::8888]:53`.
   * Mutually exclusive with `resolversPath`.
   */
  resolvers?: string[]
  /** Per-field overrides applied on top of the loaded config. */
  overrides?: ClientConfigOverrides
}

export interface ClientOptions extends ConfigOptions {
  /** Also append logs to this file. */
  logPath?: string
  /**
   * Receives every log line instead of stdout. An exception thrown here is
   * rethrown as an uncaught exception.
   */
  onLog?: (entry: LogEntry) => void
}

export interface LogEntry {
  /** Upstream levels; WARNING/CRITICAL config values log as WARN/ERROR. */
  level: Extract<LogLevel, 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'>
  message: string
  /** Local time the line was logged, at 1s resolution. */
  time: Date
  /** The line as the logger formatted it. */
  raw: string
}

export interface ResolverAddress {
  ip: string
  port: number
}

export interface ValidatedConfig {
  /** Effective config with every key: file/object values, then overrides, then built-in defaults. */
  config: Required<ClientConfig>
  /** Absolute path of the loaded file, or `<json_base64>` for a config object. */
  configPath: string
  /** Resolvers file that was read; empty for inline `resolvers`. */
  resolversPath: string
  /** Resolvers after expanding CIDR ranges and removing duplicates. */
  resolvers: ResolverAddress[]
}

export interface ClientInfo {
  version: string
  configPath: string
  resolversPath: string
  protocol: ProtocolType
  listenIP: string
  listenPort: number
  domains: string[]
  resolvers: number
  logLevel: string
  running: boolean
}

export interface ClientStatus {
  running: boolean
  /** A tunnel session with the server is established; false while connecting. */
  sessionReady: boolean
  /** Session id assigned by the server; 0 before the first session. */
  sessionId: number
  /** Domain/resolver pairs currently used (passed MTU tests and not disabled). */
  activeConnections: number
  totalConnections: number
}

/** One domain/resolver pair and its MTU/health state. */
export interface Connection {
  key: string
  domain: string
  resolver: string
  resolverPort: number
  resolverLabel: string
  /** Passed MTU tests and currently in use. */
  valid: boolean
  uploadMtuBytes: number
  uploadMtuChars: number
  downloadMtuBytes: number
  mtuResolveTimeMs: number
  /** Unix ms of the last background health check, or null. */
  lastHealthCheckAt: number | null
  /** Average RTT from runtime samples, or null before any. */
  averageRttMs: number | null
}

const logLinePattern = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) \[[^\]]*\] \[(DEBUG|INFO|WARN|ERROR)\] (.*)$/s
// eslint-disable-next-line no-control-regex
const ansiPattern = /\x1b\[[0-9;]*m/g

function parseLogLine (raw: string): LogEntry {
  const match = logLinePattern.exec(raw.replace(ansiPattern, ''))
  if (match === null) {
    return { level: 'INFO', message: raw, time: new Date(), raw }
  }
  const [, y, mo, d, h, mi, s, level, message] = match
  return {
    level: level as LogEntry['level'],
    message,
    time: new Date(+y, +mo - 1, +d, +h, +mi, +s),
    raw
  }
}

function nativeOptions (options: ClientOptions): string {
  const { onLog, ...rest } = options
  return JSON.stringify({
    ...rest,
    configPath: absolute(rest.configPath),
    resolversPath: absolute(rest.resolversPath),
    logPath: absolute(rest.logPath)
  })
}

const absolute = (p: string | undefined): string | undefined => p === undefined ? undefined : path.resolve(p)

/** MasterDnsVPN build version stamped into the native addon. */
export function version (): string {
  return native.version()
}

/**
 * Loads and validates a config (including the resolvers) the same way the
 * client does, without creating one. Throws on an invalid config.
 */
export function validateConfig (options: ConfigOptions): ValidatedConfig {
  return JSON.parse(native.loadConfig(nativeOptions(options)))
}

/**
 * A MasterDnsVPN client. Construction loads the config and resolvers
 * (throws on invalid config); `start()` opens the local SOCKS5/TCP listener
 * and runs the tunnel until `stop()`.
 *
 * A client runs once: after it stops, create a new one to run again.
 */
export class MasterDnsVpnClient {
  #id: number
  #run: Promise<void> | null = null

  constructor (options: ClientOptions) {
    const { onLog } = options
    const forward = onLog === undefined
      ? undefined
      : (line: string) => {
          try {
            onLog(parseLogLine(line))
          } catch (error) {
            process.nextTick(() => { throw error })
          }
        }
    this.#id = native.clientCreate(nativeOptions(options), forward)
  }

  static fromConfigFile (configPath: string, options: Omit<ClientOptions, 'configPath' | 'config'> = {}): MasterDnsVpnClient {
    return new MasterDnsVpnClient({ ...options, configPath })
  }

  static fromConfig (config: ClientConfig, options: Omit<ClientOptions, 'configPath' | 'config'> = {}): MasterDnsVpnClient {
    return new MasterDnsVpnClient({ ...options, config })
  }

  /** @internal */
  get [nativeHandle] (): number {
    return this.#id
  }

  get running (): boolean {
    return this.info().running
  }

  /** Static facts about the loaded config. */
  info (): ClientInfo {
    return JSON.parse(native.clientInfo(this.#id))
  }

  /** Runtime state: session and resolver counts. Cheap enough to poll. */
  status (): ClientStatus {
    return JSON.parse(native.clientStatus(this.#id))
  }

  /**
   * Every domain/resolver pair with MTU and health data. The list has
   * domains x resolvers entries, so prefer {@link status} for polling.
   */
  connections (): Connection[] {
    return JSON.parse(native.clientConnections(this.#id))
  }

  /**
   * Starts the client in the background. Returns a promise that settles when
   * the client stops: resolves on `stop()`, rejects on a runtime error.
   * While running, the client keeps the Node event loop alive.
   */
  start (): Promise<void> {
    if (this.#run !== null) {
      return Promise.reject(new Error('client was already started; create a new client to run again'))
    }
    this.#run = native.clientStart(this.#id)
    return this.#run
  }

  /** Stops the client and waits until it has shut down. */
  async stop (): Promise<void> {
    native.clientStop(this.#id)
    await this.#run
  }

  /** Waits until the client stops. */
  async wait (): Promise<void> {
    await this.#run
  }

  /** Stops the client if running and releases the native handle. */
  async destroy (): Promise<void> {
    native.clientStop(this.#id)
    try {
      await this.#run
    } finally {
      native.clientDestroy(this.#id)
    }
  }

  async [Symbol.asyncDispose] (): Promise<void> {
    await this.destroy()
  }
}
