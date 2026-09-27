import { createRequire } from 'node:module'
import { MasterDnsVpnClient, nativeHandle } from 'masterdnsvpn-node'
import { toSingBoxOptions } from './options.js'
import type { RouteRule, RouterLogLevel, RouterOptions } from './options.js'

export * from './options.js'

interface RouterBinding {
  routerVersion: () => string
  routerCreate: (clientId: number, optionsJson: string, onLog?: (line: string) => void) => number
  routerStart: (id: number) => Promise<void>
  routerClose: (id: number) => Promise<void>
}

// The same native module instance masterdnsvpn-node loaded; with this package
// installed that is the router binary.
const native: Partial<RouterBinding> = createRequire(import.meta.url)('masterdnsvpn-node/native')

function binding (): RouterBinding {
  if (typeof native.routerCreate !== 'function') {
    throw new Error(
      'masterdnsvpn-node-router: the router binary is not loaded. Its binaries/ may be missing for ' +
      `${process.platform}-${process.arch}, or MASTERDNSVPN_NODE_FLAVOR=core is set.`
    )
  }
  return native as RouterBinding
}

/** sing-box version embedded in the router binary. */
export function singBoxVersion (): string {
  return binding().routerVersion()
}

export interface RouterLogEntry {
  level: Uppercase<RouterLogLevel>
  message: string
  raw: string
}

export interface RouterCallbacks {
  /** Receives sing-box log lines instead of stderr. */
  onLog?: (entry: RouterLogEntry) => void
}

// sing-box format: `LEVEL[elapsed seconds] message`, colored.
const logLinePattern = /^(TRACE|DEBUG|INFO|WARN|ERROR|FATAL|PANIC)(?:\[\d+\])?\s*(.*)$/s
// eslint-disable-next-line no-control-regex
const ansiPattern = /\x1b\[[0-9;]*m/g

function parseLogLine (raw: string): RouterLogEntry {
  const plain = raw.replace(ansiPattern, '')
  const match = logLinePattern.exec(plain)
  if (match === null) return { level: 'INFO', message: plain, raw }
  return { level: match[1] as RouterLogEntry['level'], message: match[2], raw }
}

/**
 * Routes traffic through a MasterDnsVPN client: as a local proxy or a TUN
 * device, with direct/proxy/block rules. The client must use
 * PROTOCOL_TYPE SOCKS5 and be running for proxied traffic to flow.
 *
 * Changing the mode or rules rebuilds the embedded sing-box instance; the
 * client and its tunnel session are not affected.
 */
export class Router {
  readonly #client: MasterDnsVpnClient
  readonly #callbacks: RouterCallbacks
  #options: RouterOptions
  #id: number | null = null
  #queue: Promise<void> = Promise.resolve()

  constructor (client: MasterDnsVpnClient, options: RouterOptions, callbacks: RouterCallbacks = {}) {
    binding()
    toSingBoxOptions(options) // validate early
    this.#client = client
    this.#options = options
    this.#callbacks = callbacks
  }

  get options (): RouterOptions {
    return this.#options
  }

  get running (): boolean {
    return this.#id !== null
  }

  /**
   * Starts routing. In TUN mode this changes system routes and needs
   * admin/root; in proxy mode with `systemProxy` it changes the OS proxy
   * settings. Both are restored by `stop()`.
   */
  async start (): Promise<void> {
    await this.#serialize(async () => {
      if (this.#id !== null) throw new Error('router is already running')
      await this.#open(this.#options)
    })
  }

  /** Stops routing and restores routes / proxy settings. */
  async stop (): Promise<void> {
    await this.#serialize(async () => { await this.#close() })
  }

  /**
   * Replaces options (merged over the current ones). Applied immediately if
   * running; otherwise on the next start. If the new options fail to start,
   * the router is left stopped and the error is thrown.
   */
  async update (options: Partial<RouterOptions>): Promise<void> {
    const next = { ...this.#options, ...options }
    toSingBoxOptions(next)
    await this.#serialize(async () => {
      this.#options = next
      if (this.#id === null) return
      await this.#close()
      await this.#open(next)
    })
  }

  async setMode (mode: RouterOptions['mode']): Promise<void> {
    await this.update({ mode })
  }

  async setRules (rules: RouteRule[]): Promise<void> {
    await this.update({ rules })
  }

  /** The sing-box options for the current router options (client parts excluded). */
  singBoxOptions (): Record<string, any> {
    return toSingBoxOptions(this.#options)
  }

  async [Symbol.asyncDispose] (): Promise<void> {
    await this.stop()
  }

  async #open (options: RouterOptions): Promise<void> {
    const native = binding()
    const { onLog } = this.#callbacks
    const forward = onLog === undefined
      ? undefined
      : (line: string) => {
          try {
            onLog(parseLogLine(line))
          } catch (error) {
            process.nextTick(() => { throw error })
          }
        }
    const id = native.routerCreate(this.#client[nativeHandle], JSON.stringify(toSingBoxOptions(options)), forward)
    try {
      await native.routerStart(id)
    } catch (error) {
      await native.routerClose(id).catch(() => {})
      throw error
    }
    this.#id = id
  }

  async #close (): Promise<void> {
    if (this.#id === null) return
    const id = this.#id
    this.#id = null
    await binding().routerClose(id)
  }

  // start/stop/update run one at a time, in call order.
  #serialize (fn: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(fn)
    this.#queue = run.catch(() => {})
    return run
  }
}
