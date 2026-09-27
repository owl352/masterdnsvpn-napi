// Router options and their translation into sing-box options. Kept free of
// native calls so the generated config can be inspected and tested on its own.

/**
 * Where a matching connection goes:
 * `proxy` through the MasterDnsVPN tunnel, `direct` via the normal network,
 * `block` rejected.
 */
export type RouteOutbound = 'proxy' | 'direct' | 'block'

/**
 * A routing rule. All fields set on a rule must match (AND); within a field
 * any value may match (OR). Rules are checked in order; the first match wins.
 */
export interface RouteRule {
  /** Exact domains, e.g. `example.com` (does not match subdomains). */
  domain?: string[]
  /** Domain suffixes, e.g. `example.com` matches `a.example.com` and `example.com`. */
  domainSuffix?: string[]
  domainKeyword?: string[]
  domainRegex?: string[]
  /** Destination IPs or CIDRs, e.g. `10.0.0.0/8`, `2001:db8::/32`. */
  ipCidr?: string[]
  /** Match private/LAN destination addresses. */
  ipIsPrivate?: boolean
  port?: number[]
  /** Port ranges, e.g. `1000:2000`, `:3000`, `4000:`. */
  portRange?: string[]
  network?: Array<'tcp' | 'udp'>
  /** Process names (TUN mode, and proxy mode for local apps), e.g. `chrome.exe`, `curl`. */
  processName?: string[]
  processPath?: string[]
  /** Invert the match. */
  invert?: boolean
  outbound: RouteOutbound
}

export interface ProxyModeOptions {
  /** @default '127.0.0.1' */
  listen?: string
  /** SOCKS5 + HTTP proxy port. @default 2080 */
  port?: number
  /** Set this proxy as the OS system proxy while running (macOS, Windows, GNOME/KDE). @default false */
  systemProxy?: boolean
}

export interface TunModeOptions {
  /** @default chosen by the OS (utunN, tunN, ...) */
  interfaceName?: string
  /** @default 9000 */
  mtu?: number
  /** @default ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'] */
  address?: string[]
  /** `mixed` uses the system stack for TCP and gvisor for UDP. @default 'mixed' */
  stack?: 'system' | 'gvisor' | 'mixed'
  /** Stop traffic leaking around the TUN (e.g. apps binding to an interface). @default true */
  strictRoute?: boolean
  /**
   * Extra destinations to keep off the TUN at the OS routing level (faster
   * than a `direct` rule). The client's resolvers are always excluded.
   */
  routeExcludeAddress?: string[]
}

export interface RouterDnsOptions {
  /**
   * DNS server used for proxied domains, queried over TCP through the tunnel.
   * @default '1.1.1.1'
   */
  remote?: string
  /**
   * DNS for direct domains and direct connections: `'local'` for the system
   * resolver, or a server address queried over UDP outside the tunnel.
   * @default 'local'
   */
  direct?: string
  /**
   * TUN mode only. Answer A/AAAA queries for proxied domains with fake IPs
   * from these ranges instead of resolving them through the tunnel. Saves a
   * tunnel round-trip per lookup and lets the server resolve the domain.
   * `ipCidr` rules cannot match proxied domains' real IPs then. Must not
   * overlap your network or the TUN address. `false` disables it.
   * @default { inet4Range: '198.18.0.0/15', inet6Range: 'fc00::/18' }
   */
  fakeIp?: false | { inet4Range?: string, inet6Range?: string }
}

export type RouterLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'panic'

export interface RouterOptions {
  /**
   * `proxy`: a local SOCKS5/HTTP proxy apps opt into (optionally as the system
   * proxy). `tun`: captures all traffic through a TUN device; needs admin/root.
   */
  mode: 'proxy' | 'tun'
  proxy?: ProxyModeOptions
  tun?: TunModeOptions
  /** Checked in order; the first match wins. */
  rules?: RouteRule[]
  /** Where traffic matching no rule goes. @default 'proxy' */
  final?: Exclude<RouteOutbound, 'block'>
  /** Send private/LAN destinations direct, before any rule. @default true */
  bypassPrivate?: boolean
  dns?: RouterDnsOptions
  /** @default 'warn' */
  logLevel?: RouterLogLevel
  /**
   * Last-step hook to edit the generated sing-box options (advanced). The
   * `proxy` outbound and the resolver route exclusions are added after this.
   */
  singBox?: (options: SingBoxOptions) => SingBoxOptions
}

/** sing-box options as JSON (https://sing-box.sagernet.org/configuration/). */
export type SingBoxOptions = Record<string, any>

const DNS_REMOTE = 'dns-remote'
const DNS_DIRECT = 'dns-direct'
const DNS_FAKE = 'dns-fake'

function compact<T extends Record<string, unknown>> (obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))) as Partial<T>
}

function ruleMatch (rule: RouteRule): SingBoxOptions {
  return compact({
    domain: rule.domain,
    domain_suffix: rule.domainSuffix,
    domain_keyword: rule.domainKeyword,
    domain_regex: rule.domainRegex,
    ip_cidr: rule.ipCidr,
    ip_is_private: rule.ipIsPrivate === true ? true : undefined,
    port: rule.port,
    port_range: rule.portRange,
    network: rule.network,
    process_name: rule.processName,
    process_path: rule.processPath,
    invert: rule.invert === true ? true : undefined
  })
}

function routeAction (outbound: RouteOutbound): SingBoxOptions {
  switch (outbound) {
    case 'block':
      return { action: 'reject' }
    case 'direct':
    case 'proxy':
      return { action: 'route', outbound }
    default:
      throw new TypeError(`invalid rule outbound: ${String(outbound)}`)
  }
}

function hasDomainMatch (rule: RouteRule): boolean {
  return [rule.domain, rule.domainSuffix, rule.domainKeyword, rule.domainRegex].some((v) => v !== undefined && v.length > 0)
}

function dnsServer (address: string, tag: string, detour?: string): SingBoxOptions {
  if (address === 'local') return { type: 'local', tag }
  return compact({ type: detour === undefined ? 'udp' : 'tcp', tag, server: address, detour })
}

/** Translates router options into sing-box options (without the client-specific parts the native side adds). */
export function toSingBoxOptions (options: RouterOptions): SingBoxOptions {
  const { mode, rules = [], final = 'proxy', bypassPrivate = true, dns = {}, logLevel = 'warn' } = options
  if (mode !== 'proxy' && mode !== 'tun') throw new TypeError(`invalid router mode: ${String(mode)}`)
  if (final !== 'proxy' && final !== 'direct') throw new TypeError(`invalid final outbound: ${String(final)}`)

  for (const rule of rules) {
    if (Object.keys(ruleMatch(rule)).filter((k) => k !== 'invert').length === 0) {
      throw new TypeError('a route rule needs at least one match field')
    }
  }

  let inbound: SingBoxOptions
  if (mode === 'proxy') {
    const proxy = options.proxy ?? {}
    inbound = compact({
      type: 'mixed',
      tag: 'proxy-in',
      listen: proxy.listen ?? '127.0.0.1',
      listen_port: proxy.port ?? 2080,
      set_system_proxy: proxy.systemProxy === true ? true : undefined
    })
  } else {
    const tun = options.tun ?? {}
    inbound = compact({
      type: 'tun',
      tag: 'tun-in',
      interface_name: tun.interfaceName,
      mtu: tun.mtu ?? 9000,
      address: tun.address ?? ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
      auto_route: true,
      strict_route: tun.strictRoute ?? true,
      stack: tun.stack ?? 'mixed',
      route_exclude_address: tun.routeExcludeAddress
    })
  }

  const routeRules: SingBoxOptions[] = [{ action: 'sniff' }]
  if (mode === 'tun') routeRules.push({ protocol: 'dns', action: 'hijack-dns' })
  if (bypassPrivate) routeRules.push({ ip_is_private: true, action: 'route', outbound: 'direct' })
  for (const rule of rules) routeRules.push({ ...ruleMatch(rule), ...routeAction(rule.outbound) })

  // Resolve domains the way their traffic is routed: direct domains with the
  // direct DNS, blocked ones not at all, proxied ones with fake IPs (TUN) or
  // through the tunnel.
  const fakeIp = mode === 'tun' && dns.fakeIp !== false ? dns.fakeIp ?? {} : null
  const proxyDns = (match: SingBoxOptions): SingBoxOptions => fakeIp !== null
    ? { ...match, query_type: ['A', 'AAAA'], action: 'route', server: DNS_FAKE }
    : { ...match, action: 'route', server: DNS_REMOTE }
  const dnsRules: SingBoxOptions[] = []
  for (const rule of rules) {
    if (!hasDomainMatch(rule)) continue
    const match = ruleMatch(rule)
    delete match.ip_cidr
    delete match.ip_is_private
    delete match.process_name
    delete match.process_path
    if (rule.outbound === 'block') dnsRules.push({ ...match, action: 'predefined', rcode: 'NXDOMAIN' })
    else if (rule.outbound === 'direct') dnsRules.push({ ...match, action: 'route', server: DNS_DIRECT })
    else dnsRules.push(proxyDns(match))
  }
  if (final === 'proxy' && fakeIp !== null) dnsRules.push(proxyDns({}))

  const dnsServers = [
    dnsServer(dns.remote ?? '1.1.1.1', DNS_REMOTE, 'proxy'),
    dnsServer(dns.direct ?? 'local', DNS_DIRECT)
  ]
  if (fakeIp !== null) {
    dnsServers.push({
      type: 'fakeip',
      tag: DNS_FAKE,
      inet4_range: fakeIp.inet4Range ?? '198.18.0.0/15',
      inet6_range: fakeIp.inet6Range ?? 'fc00::/18'
    })
  }

  const singBox: SingBoxOptions = {
    log: { level: logLevel, timestamp: false },
    dns: {
      servers: dnsServers,
      rules: dnsRules,
      final: final === 'direct' ? DNS_DIRECT : DNS_REMOTE,
      reverse_mapping: true
    },
    inbounds: [inbound],
    outbounds: [{ type: 'direct', tag: 'direct' }],
    route: {
      rules: routeRules,
      final,
      auto_detect_interface: true,
      default_domain_resolver: DNS_DIRECT
    }
  }
  return options.singBox === undefined ? singBox : options.singBox(singBox)
}
