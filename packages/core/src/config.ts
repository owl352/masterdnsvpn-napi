// Types for the MasterDnsVPN client config, mirroring config.ClientConfig in
// MasterDnsVPN/internal/config/client.go. test/config-types.test.js checks that
// every field there is present here, so a submodule bump that adds or renames
// fields fails the tests.
//
// `@default` is the value used when the key is omitted (Go defaultClientConfig),
// which is not always the value in client_config.toml.simple.

/** Payload encryption. Must match the server's DATA_ENCRYPTION_METHOD. */
export const DataEncryptionMethod = {
  None: 0,
  XOR: 1,
  ChaCha20: 2,
  AES128GCM: 3,
  AES192GCM: 4,
  AES256GCM: 5
} as const
export type DataEncryptionMethod = typeof DataEncryptionMethod[keyof typeof DataEncryptionMethod]

export const ResolverBalancingStrategy = {
  RoundRobinDefault: 0,
  Random: 1,
  RoundRobin: 2,
  LeastLoss: 3,
  LowestLatency: 4,
  /** Loss-first + latency-aware. */
  HybridScore: 5,
  /** Loss shortlist, then latency, then rotate among near-top. */
  LossThenLatency: 6,
  /** Random choice inside the best 10% loss tier. */
  LeastLossTopRandom: 7,
  /** Round-robin inside the best 10% loss tier. */
  LeastLossTopRoundRobin: 8
} as const
export type ResolverBalancingStrategy = typeof ResolverBalancingStrategy[keyof typeof ResolverBalancingStrategy]

export const CompressionType = {
  Off: 0,
  ZSTD: 1,
  LZ4: 2,
  ZLIB: 3
} as const
export type CompressionType = typeof CompressionType[keyof typeof CompressionType]

/** `SOCKS5`: proxy mode for browsers/apps. `TCP`: raw TCP tunnel mode. */
export type ProtocolType = 'SOCKS5' | 'TCP'

/** Unknown values fall back to INFO. */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'WARNING' | 'ERROR' | 'CRITICAL'

/**
 * Client config in the client_config.toml key format, as accepted by
 * `MasterDnsVpnClient.fromConfig()`. Integer fields must be whole numbers.
 */
export interface ClientConfig {
  // 1) Tunnel identity & security

  /** Tunnel domains used to build DNS queries. Must match the server's DOMAIN values; all must be served by the same server. At least one is required. */
  DOMAINS: string[]
  /** @default 1 (XOR) */
  DATA_ENCRYPTION_METHOD?: DataEncryptionMethod
  /** Shared key; must match the server-side key file contents. Required. */
  ENCRYPTION_KEY: string

  // 2) Local proxy listener

  /** @default 'SOCKS5' */
  PROTOCOL_TYPE?: ProtocolType
  /** Use '0.0.0.0' (with SOCKS5_AUTH) to serve other devices. @default '127.0.0.1' */
  LISTEN_IP?: string
  /** @default 18000 */
  LISTEN_PORT?: number
  /** Require auth on the local SOCKS5 proxy. @default false */
  SOCKS5_AUTH?: boolean
  /** @default 'master_dns_vpn' */
  SOCKS5_USER?: string
  /** @default 'master_dns_vpn' */
  SOCKS5_PASS?: string

  // 3) Local DNS service

  /** Expose a local DNS server on LOCAL_DNS_IP:LOCAL_DNS_PORT. @default false */
  LOCAL_DNS_ENABLED?: boolean
  /** @default '127.0.0.1' */
  LOCAL_DNS_IP?: string
  /** @default 53 */
  LOCAL_DNS_PORT?: number
  /** Must be >= 1. @default 10000 */
  LOCAL_DNS_CACHE_MAX_RECORDS?: number
  /** If <= 0, a default is used. @default 14400 */
  LOCAL_DNS_CACHE_TTL_SECONDS?: number
  /** @default 300 */
  LOCAL_DNS_PENDING_TIMEOUT_SECONDS?: number
  /** Timeout for reassembling fragmented DNS tunnel responses. Clamped to [1, 600]. @default 60 */
  DNS_RESPONSE_FRAGMENT_TIMEOUT_SECONDS?: number
  /** Persist the local DNS cache to local_dns_cache.bin in the config dir. @default true */
  LOCAL_DNS_CACHE_PERSIST_TO_FILE?: boolean
  /** @default 60 */
  LOCAL_DNS_CACHE_FLUSH_INTERVAL_SECONDS?: number

  // 4) Resolver selection, duplication and health

  /** @default 2 (RoundRobin) */
  RESOLVER_BALANCING_STRATEGY?: ResolverBalancingStrategy
  /** Copies of each outgoing tunnel packet. Clamped to [1, 10]. @default 2 */
  PACKET_DUPLICATION_COUNT?: number
  /** Copies of stream setup packets. Clamped to [PACKET_DUPLICATION_COUNT, 12]. @default 2 */
  SETUP_PACKET_DUPLICATION_COUNT?: number
  /** Resends on one resolver before a stream fails over. Clamped to [1, 256]. @default 2 */
  STREAM_RESOLVER_FAILOVER_RESEND_THRESHOLD?: number
  /** Min seconds between resolver switches for one stream. Clamped to [0.1, 120]. @default 2.5 */
  STREAM_RESOLVER_FAILOVER_COOLDOWN?: number
  /** Recheck resolvers rejected during MTU testing in the background. @default true */
  RECHECK_INACTIVE_SERVERS_ENABLED?: boolean
  /** Disable resolvers that only time out across the window below. @default true */
  AUTO_DISABLE_TIMEOUT_SERVERS?: boolean
  /** Clamped to [1, 86400]. @default 30 */
  AUTO_DISABLE_TIMEOUT_WINDOW_SECONDS?: number
  /** Base-encode payload labels before tunneling. @default false */
  BASE_ENCODE_DATA?: boolean

  // 5) Compression

  /** @default 0 (Off) */
  UPLOAD_COMPRESSION_TYPE?: CompressionType
  /** @default 0 (Off) */
  DOWNLOAD_COMPRESSION_TYPE?: CompressionType
  /** Minimum payload size before compression is attempted. @default 100 */
  COMPRESSION_MIN_SIZE?: number

  // 6) MTU discovery

  /** @default 38 */
  MIN_UPLOAD_MTU?: number
  /** @default 100 */
  MIN_DOWNLOAD_MTU?: number
  /** @default 150 */
  MAX_UPLOAD_MTU?: number
  /** @default 500 */
  MAX_DOWNLOAD_MTU?: number
  /** Drop bottleneck resolvers during the initial MTU tests. @default true */
  AUTO_REMOVE_LOW_MTU_SERVERS?: boolean
  /** @default 2 */
  MTU_TEST_RETRIES?: number
  /** Seconds. @default 2 */
  MTU_TEST_TIMEOUT?: number
  /** Auto-raised for large resolver lists. @default 16 */
  MTU_TEST_PARALLELISM?: number
  /** Export MTU-tested resolvers to MTU_SERVERS_FILE_NAME. @default false */
  SAVE_MTU_SERVERS_TO_FILE?: boolean
  /** Placeholders: {time}. @default 'masterdnsvpn_success_test_{time}.log' */
  MTU_SERVERS_FILE_NAME?: string
  /** Placeholders: {IP}, {DOMAIN}, {UP_MTU}, {DOWN_MTU}, {DOWN-MTU}. @default '{IP} ({DOMAIN}) - UP: {UP_MTU} DOWN: {DOWN-MTU}' */
  MTU_SERVERS_FILE_FORMAT?: string
  /** @default '' */
  MTU_USING_SECTION_SEPARATOR_TEXT?: string
  /** Placeholders: {IP}, {DOMAIN}, {TIME}, {CAUSE}. */
  MTU_REMOVED_SERVER_LOG_FORMAT?: string
  /** Placeholders: {IP}, {DOMAIN}, {TIME}, {UP_MTU}, {DOWN_MTU}. */
  MTU_ADDED_SERVER_LOG_FORMAT?: string
  /** Placeholders: {IP}, {DOMAIN}, {TIME}, {UP_MTU}, {DOWN_MTU}. */
  MTU_REACTIVE_ADDED_SERVER_LOG_FORMAT?: string

  // 7) Runtime workers, queues and timers

  /** Leave unset to let the client size it for the machine. @default 4 */
  RX_TX_WORKERS?: number
  /** @deprecated Legacy key; use RX_TX_WORKERS. */
  TUNNEL_READER_WORKERS?: number
  /** @deprecated Legacy key; use RX_TX_WORKERS. */
  TUNNEL_WRITER_WORKERS?: number
  /** Leave unset (0) to let the client size it for the machine. @default 0 */
  TUNNEL_PROCESS_WORKERS?: number
  /** Clamped to [0.5, 120]. @default 10 */
  TUNNEL_PACKET_TIMEOUT_SECONDS?: number
  /** Clamped to [0.001, 1]. @default 0.02 */
  DISPATCHER_IDLE_POLL_INTERVAL_SECONDS?: number
  /** Auto-raised when needed. @default 4096 */
  RX_CHANNEL_SIZE?: number
  /** Clamped to [1, 3600]. @default 30 */
  SOCKS_UDP_ASSOCIATE_READ_TIMEOUT_SECONDS?: number
  /** Clamped to [1, 3600]. @default 45 */
  CLIENT_TERMINAL_STREAM_RETENTION_SECONDS?: number
  /** Clamped to [1, 3600]. @default 120 */
  CLIENT_CANCELLED_SETUP_RETENTION_SECONDS?: number
  /** @default 1 */
  SESSION_INIT_RETRY_BASE_SECONDS?: number
  /** @default 1 */
  SESSION_INIT_RETRY_STEP_SECONDS?: number
  /** Failed attempts before the retry delay grows linearly. @default 5 */
  SESSION_INIT_RETRY_LINEAR_AFTER?: number
  /** @default 60 */
  SESSION_INIT_RETRY_MAX_SECONDS?: number
  /** Retry delay after SESSION_BUSY. Clamped to [1, 3600]. @default 60 */
  SESSION_INIT_BUSY_RETRY_INTERVAL_SECONDS?: number
  /** Concurrent session init attempts. Clamped to [1, 5]. @default 3 */
  SESSION_INIT_RACING_COUNT?: number
  /** @default 0.1 */
  PING_AGGRESSIVE_INTERVAL_SECONDS?: number
  /** @default 0.75 */
  PING_LAZY_INTERVAL_SECONDS?: number
  /** @default 2 */
  PING_COOLDOWN_INTERVAL_SECONDS?: number
  /** @default 15 */
  PING_COLD_INTERVAL_SECONDS?: number
  /** @default 8 */
  PING_WARM_THRESHOLD_SECONDS?: number
  /** @default 20 */
  PING_COOL_THRESHOLD_SECONDS?: number
  /** @default 30 */
  PING_COLD_THRESHOLD_SECONDS?: number

  // 8) ARQ reliability & packing

  /** Max control blocks packed into one outgoing batch. @default 8 */
  MAX_PACKETS_PER_BATCH?: number
  /** @default 600 */
  ARQ_WINDOW_SIZE?: number
  /** @default 1 */
  ARQ_INITIAL_RTO_SECONDS?: number
  /** @default 5 */
  ARQ_MAX_RTO_SECONDS?: number
  /** @default 0.5 */
  ARQ_CONTROL_INITIAL_RTO_SECONDS?: number
  /** @default 3 */
  ARQ_CONTROL_MAX_RTO_SECONDS?: number
  /** @default 400 */
  ARQ_MAX_CONTROL_RETRIES?: number
  /** @default 1800 */
  ARQ_INACTIVITY_TIMEOUT_SECONDS?: number
  /** @default 2400 */
  ARQ_DATA_PACKET_TTL_SECONDS?: number
  /** @default 1200 */
  ARQ_CONTROL_PACKET_TTL_SECONDS?: number
  /** @default 1200 */
  ARQ_MAX_DATA_RETRIES?: number
  /** Max out-of-order gap that can trigger a NACK; 0 disables NACKs. @default 16 */
  ARQ_DATA_NACK_MAX_GAP?: number
  /** Clamped to [0.1, 30]. @default 0.1 */
  ARQ_DATA_NACK_INITIAL_DELAY_SECONDS?: number
  /** @default 1 */
  ARQ_DATA_NACK_REPEAT_SECONDS?: number
  /** @default 120 */
  ARQ_TERMINAL_DRAIN_TIMEOUT_SECONDS?: number
  /** @default 90 */
  ARQ_TERMINAL_ACK_WAIT_TIMEOUT_SECONDS?: number

  // 9) Logging

  /** @default 'INFO' */
  LOG_LEVEL?: LogLevel
}

/** Keys every config must set itself; they have no usable default. */
export type RequiredClientConfigKeys = 'DOMAINS' | 'ENCRYPTION_KEY'

/**
 * The recommended client config from MasterDnsVPN's client_config.toml.simple
 * (tuned for lossy / high-latency links with many resolvers), without the
 * per-user DOMAINS and ENCRYPTION_KEY. test/config-types.test.js keeps it in
 * sync with the sample file.
 *
 * Note it differs from the built-in defaults (`@default` on {@link ClientConfig})
 * in a few places, e.g. RESOLVER_BALANCING_STRATEGY 3 vs 2.
 */
export const defaultClientConfig: Readonly<Omit<Required<ClientConfig>, RequiredClientConfigKeys | 'TUNNEL_READER_WORKERS' | 'TUNNEL_WRITER_WORKERS'>> = Object.freeze({
  DATA_ENCRYPTION_METHOD: 1,
  PROTOCOL_TYPE: 'SOCKS5',
  LISTEN_IP: '127.0.0.1',
  LISTEN_PORT: 18000,
  SOCKS5_AUTH: false,
  SOCKS5_USER: 'master_dns_vpn',
  SOCKS5_PASS: 'master_dns_vpn',
  LOCAL_DNS_ENABLED: false,
  LOCAL_DNS_IP: '127.0.0.1',
  LOCAL_DNS_PORT: 53,
  LOCAL_DNS_CACHE_MAX_RECORDS: 10000,
  LOCAL_DNS_CACHE_TTL_SECONDS: 14400,
  LOCAL_DNS_PENDING_TIMEOUT_SECONDS: 300,
  DNS_RESPONSE_FRAGMENT_TIMEOUT_SECONDS: 60,
  LOCAL_DNS_CACHE_PERSIST_TO_FILE: true,
  LOCAL_DNS_CACHE_FLUSH_INTERVAL_SECONDS: 60,
  RESOLVER_BALANCING_STRATEGY: 3,
  PACKET_DUPLICATION_COUNT: 3,
  SETUP_PACKET_DUPLICATION_COUNT: 4,
  STREAM_RESOLVER_FAILOVER_RESEND_THRESHOLD: 2,
  STREAM_RESOLVER_FAILOVER_COOLDOWN: 2.5,
  RECHECK_INACTIVE_SERVERS_ENABLED: true,
  AUTO_DISABLE_TIMEOUT_SERVERS: true,
  AUTO_DISABLE_TIMEOUT_WINDOW_SECONDS: 30,
  BASE_ENCODE_DATA: false,
  UPLOAD_COMPRESSION_TYPE: 0,
  DOWNLOAD_COMPRESSION_TYPE: 0,
  COMPRESSION_MIN_SIZE: 120,
  MIN_UPLOAD_MTU: 38,
  MIN_DOWNLOAD_MTU: 200,
  MAX_UPLOAD_MTU: 150,
  MAX_DOWNLOAD_MTU: 4000,
  AUTO_REMOVE_LOW_MTU_SERVERS: true,
  MTU_TEST_RETRIES: 2,
  MTU_TEST_TIMEOUT: 2,
  MTU_TEST_PARALLELISM: 32,
  SAVE_MTU_SERVERS_TO_FILE: false,
  MTU_SERVERS_FILE_NAME: 'masterdnsvpn_success_test_{time}.log',
  MTU_SERVERS_FILE_FORMAT: '{IP} ({DOMAIN}) - UP: {UP_MTU} DOWN: {DOWN-MTU}',
  MTU_USING_SECTION_SEPARATOR_TEXT: '',
  MTU_REMOVED_SERVER_LOG_FORMAT: 'Resolver {IP} ({DOMAIN}) removed at {TIME} due to {CAUSE}',
  MTU_ADDED_SERVER_LOG_FORMAT: 'Resolver {IP} ({DOMAIN}) added back at {TIME} (UP {UP_MTU}, DOWN {DOWN_MTU})',
  MTU_REACTIVE_ADDED_SERVER_LOG_FORMAT: 'Resolver {IP} ({DOMAIN}) added back at {TIME} after reactive recheck (UP {UP_MTU}, DOWN {DOWN_MTU})',
  RX_TX_WORKERS: 4,
  TUNNEL_PROCESS_WORKERS: 6,
  TUNNEL_PACKET_TIMEOUT_SECONDS: 10,
  DISPATCHER_IDLE_POLL_INTERVAL_SECONDS: 0.02,
  RX_CHANNEL_SIZE: 4096,
  SOCKS_UDP_ASSOCIATE_READ_TIMEOUT_SECONDS: 30,
  CLIENT_TERMINAL_STREAM_RETENTION_SECONDS: 45,
  CLIENT_CANCELLED_SETUP_RETENTION_SECONDS: 120,
  SESSION_INIT_RETRY_BASE_SECONDS: 1,
  SESSION_INIT_RETRY_STEP_SECONDS: 1,
  SESSION_INIT_RETRY_LINEAR_AFTER: 5,
  SESSION_INIT_RETRY_MAX_SECONDS: 60,
  SESSION_INIT_BUSY_RETRY_INTERVAL_SECONDS: 60,
  SESSION_INIT_RACING_COUNT: 3,
  PING_AGGRESSIVE_INTERVAL_SECONDS: 0.1,
  PING_LAZY_INTERVAL_SECONDS: 0.75,
  PING_COOLDOWN_INTERVAL_SECONDS: 2,
  PING_COLD_INTERVAL_SECONDS: 15,
  PING_WARM_THRESHOLD_SECONDS: 8,
  PING_COOL_THRESHOLD_SECONDS: 20,
  PING_COLD_THRESHOLD_SECONDS: 30,
  MAX_PACKETS_PER_BATCH: 8,
  ARQ_WINDOW_SIZE: 1000,
  ARQ_INITIAL_RTO_SECONDS: 0.5,
  ARQ_MAX_RTO_SECONDS: 3,
  ARQ_CONTROL_INITIAL_RTO_SECONDS: 0.5,
  ARQ_CONTROL_MAX_RTO_SECONDS: 2,
  ARQ_MAX_CONTROL_RETRIES: 126,
  ARQ_INACTIVITY_TIMEOUT_SECONDS: 1800,
  ARQ_DATA_PACKET_TTL_SECONDS: 2400,
  ARQ_CONTROL_PACKET_TTL_SECONDS: 1200,
  ARQ_MAX_DATA_RETRIES: 126,
  ARQ_DATA_NACK_MAX_GAP: 32,
  ARQ_DATA_NACK_INITIAL_DELAY_SECONDS: 0.1,
  ARQ_DATA_NACK_REPEAT_SECONDS: 0.8,
  ARQ_TERMINAL_DRAIN_TIMEOUT_SECONDS: 120,
  ARQ_TERMINAL_ACK_WAIT_TIMEOUT_SECONDS: 90,
  LOG_LEVEL: 'INFO'
})

/**
 * Builds a full client config: {@link defaultClientConfig} with `config` on top.
 *
 * @example
 * createClientConfig({ DOMAINS: ['v.example.com'], ENCRYPTION_KEY: '...', LISTEN_PORT: 1080 })
 */
export function createClientConfig (config: Pick<ClientConfig, RequiredClientConfigKeys> & Partial<ClientConfig>): ClientConfig {
  return { ...defaultClientConfig, ...config }
}

/**
 * Overrides applied on top of a loaded config (same as the CLI flags). Keys
 * are the Go ClientConfig field names; see {@link ClientConfig} for meaning
 * and defaults of the matching TOML key.
 */
export interface ClientConfigOverrides {
  ProtocolType?: ProtocolType
  Domains?: string[]
  ListenIP?: string
  ListenPort?: number
  SOCKS5Auth?: boolean
  SOCKS5User?: string
  SOCKS5Pass?: string
  LocalDNSEnabled?: boolean
  LocalDNSIP?: string
  LocalDNSPort?: number
  LocalDNSCacheMaxRecords?: number
  LocalDNSCacheTTLSeconds?: number
  LocalDNSPendingTimeoutSec?: number
  LocalDNSCachePersist?: boolean
  LocalDNSCacheFlushSec?: number
  ResolverBalancingStrategy?: ResolverBalancingStrategy
  PacketDuplicationCount?: number
  SetupPacketDuplicationCount?: number
  StreamResolverFailoverResendThreshold?: number
  StreamResolverFailoverCooldownSec?: number
  RecheckInactiveServersEnabled?: boolean
  AutoDisableTimeoutServers?: boolean
  AutoDisableTimeoutWindowSeconds?: number
  BaseEncodeData?: boolean
  UploadCompressionType?: CompressionType
  DownloadCompressionType?: CompressionType
  CompressionMinSize?: number
  DataEncryptionMethod?: DataEncryptionMethod
  EncryptionKey?: string
  MinUploadMTU?: number
  MinDownloadMTU?: number
  MaxUploadMTU?: number
  MaxDownloadMTU?: number
  AutoRemoveLowMTUServers?: boolean
  MTUTestRetries?: number
  MTUTestTimeout?: number
  MTUTestParallelism?: number
  RX_TX_Workers?: number
  LegacyTunnelReaderWorkers?: number
  LegacyTunnelWriterWorkers?: number
  TunnelProcessWorkers?: number
  TunnelPacketTimeoutSec?: number
  DispatcherIdlePollIntervalSeconds?: number
  PingAggressiveIntervalSeconds?: number
  PingLazyIntervalSeconds?: number
  PingCooldownIntervalSeconds?: number
  PingColdIntervalSeconds?: number
  PingWarmThresholdSeconds?: number
  PingCoolThresholdSeconds?: number
  PingColdThresholdSeconds?: number
  RXChannelSize?: number
  DNSResponseFragmentTimeoutSeconds?: number
  SOCKSUDPAssociateReadTimeoutSeconds?: number
  ClientTerminalStreamRetentionSeconds?: number
  ClientCancelledSetupRetentionSeconds?: number
  SessionInitRetryBaseSeconds?: number
  SessionInitRetryStepSeconds?: number
  SessionInitRetryLinearAfter?: number
  SessionInitRetryMaxSeconds?: number
  SessionInitBusyRetryIntervalSeconds?: number
  SessionInitRacingCount?: number
  SaveMTUServersToFile?: boolean
  MTUServersFileName?: string
  MTUServersFileFormat?: string
  MTUUsingSeparatorText?: string
  MTURemovedServerLogFormat?: string
  MTUAddedServerLogFormat?: string
  MTUReactiveAddedServerLogFormat?: string
  LogLevel?: LogLevel
  MaxPacketsPerBatch?: number
  ARQWindowSize?: number
  ARQInitialRTOSeconds?: number
  ARQMaxRTOSeconds?: number
  ARQControlInitialRTOSeconds?: number
  ARQControlMaxRTOSeconds?: number
  ARQMaxControlRetries?: number
  ARQInactivityTimeoutSeconds?: number
  ARQDataPacketTTLSeconds?: number
  ARQControlPacketTTLSeconds?: number
  ARQMaxDataRetries?: number
  ARQDataNackMaxGap?: number
  ARQDataNackInitialDelaySeconds?: number
  ARQDataNackRepeatSeconds?: number
  ARQTerminalDrainTimeoutSec?: number
  ARQTerminalAckWaitTimeoutSec?: number
}
