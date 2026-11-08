export const DEFAULT_PORT = 16888
export const MAX_PORT_RETRIES = 10
export const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000] as const
export const QUEUE_MAX_SIZE = 100

export const STORAGE_KEYS = {
  pairing: '_veloPairing',
  queue: '_veloPushQueue',
  config: '_veloConfig',
  pairedExtensions: '_veloPairedExtensions',
  autoConnectFailAt: '_veloAutoConnectFailAt',
} as const

export const M3U8_MIME_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'video/mpegurl',
  'audio/mpegurl',
] as const

export const MEDIA_EXTENSIONS = [
  '.mp4', '.avi', '.mpg', '.mpeg', '.ogg', '.ogv', '.ts', '.mkv', '.flv',
  '.webm', '.mov', '.m4v', '.wmv', '.rm', '.3gp', '.m3u8', '.m3u',
] as const

export const EXCLUDE_EXTENSIONS = [
  '.json', '.wasm', '.html', '.htm', '.css', '.js', '.png', '.jpg',
  '.gif', '.svg', '.ico', '.vtt', '.srt', '.ass', '.ttf', '.woff',
] as const

export const PROTOCOL_VERSION = 1
export const SUB_PROTOCOL = 'velo-ext.v1'

export interface PairingInfo {
  token: string
  port: number
  paired_at: number
}

export interface VeloConfig {
  port: number
  token: string
  pushChannel: 'ws' | 'http' | 'deep-link'
  /** @deprecated 已迁移到 DownloadClientConfig.autoPush */
  autoPush?: boolean
  /** @deprecated 已迁移到 DownloadClientConfig.mergeFormat */
  mergeFormat?: 'ts' | 'mp4' | 'mkv' | 'keep'
  /** @deprecated 已迁移到 HLS 广告过滤配置 */
  scoreThreshold?: number
  /** @deprecated 已迁移到 HLS 广告过滤配置 */
  enableFilter?: boolean
}

export const DEFAULT_CONFIG: VeloConfig = {
  port: DEFAULT_PORT,
  token: '',
  pushChannel: 'ws',
}

export interface PushMessage {
  version: number
  token: string
  action: 'push_m3u8' | 'push_url' | 'push_file' | 'push_normal' | 'push_dash'
  /** request-response 模式：桌面端在响应中回传此 ID，扩展匹配 pending 请求 */
  request_id?: number
  m3u8_text?: string
  url?: string
  video_url?: string
  audio_url?: string
  file_path?: string
  base_url?: string
  /** 透传 Content-Type（NDM bg.js T() 函数 b["10"]），让桌面端用正确扩展名落盘 */
  content_type?: string
  /** 透传 Content-Disposition（NDM bg.js T() 函数 b["11"]），桌面端可优先取其 filename */
  content_disposition?: string
  /** HTTP 方法（GET/HEAD/POST/PUT/PATCH...），用于桌面端复刻带请求体的请求 */
  method?: string
  /** 请求体（移植自 NDM bg.js V.I __0NeatPostData9__ 字段），非 GET/HEAD 时由桌面端直连下载器执行 */
  post_data?: string
  headers?: Record<string, string>
  /** 推送来源页面地址（原始页面 URL，非仅 Referer 头）：桌面端落库并在详情展示「引用地址」 */
  page_url?: string
  /** 推送来源页面标题：桌面端落库并在详情展示「页面标题」 */
  page_title?: string
  options: PushOptions
}

export interface PushOptions {
  output_dir?: string
  filename?: string
  merge_format: string
  extra_headers?: Record<string, string>
}

export interface MediaDescriptor {
  url: string
  method: string
  ext: string
  mime: string
  contentLength: number
  contentType: string
  contentDisposition: string
  pageUrl: string
  headers: Record<string, string>
}

export interface AdRange {
  start: number
  end: number
  duration: number
}

export interface Settings {
  enableHlsAdFilter: boolean
  enableDashAdFilter: boolean
  enableLogging: boolean
  enableAdSkip: boolean
  showPageBadge: boolean
  downloadClient: 'aria2' | 'ndm' | 'velo' | 'native'
  rpcUrl: string
  rpcSecret: string
  hlsRunMode: 'smart' | 'manual'
  hlsLearnedSites: string[]
  hlsEnabledSites: string[]
  hlsDisabledSites: string[]
}

export const DEFAULT_SETTINGS: Settings = {
  enableHlsAdFilter: true,
  enableDashAdFilter: true,
  enableLogging: false,
  enableAdSkip: true,
  showPageBadge: true,
  downloadClient: 'velo',
  rpcUrl: 'http://127.0.0.1:16888/jsonrpc',
  rpcSecret: '',
  hlsRunMode: 'smart',
  hlsLearnedSites: [],
  hlsEnabledSites: [],
  hlsDisabledSites: [],
}