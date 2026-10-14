export const DEFAULT_PORT = 16888
export const MAX_PORT_RETRIES = 10
export const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000] as const
export const QUEUE_MAX_SIZE = 100

export const STORAGE_KEYS = {
  pairing: '_veloPairing',
  queue: '_veloPushQueue',
  config: '_veloConfig',
  pairedExtensions: '_veloPairedExtensions',
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
  autoPush: boolean
  mergeFormat: 'ts' | 'mp4' | 'mkv' | 'keep'
  pushChannel: 'ws' | 'http' | 'deep-link'
  scoreThreshold: number
  enableFilter: boolean
}

export const DEFAULT_CONFIG: VeloConfig = {
  port: DEFAULT_PORT,
  token: '',
  // 默认关闭自动推送：用户应在 options 显式开启，避免播放任意视频都自动推送到桌面端
  autoPush: false,
  mergeFormat: 'ts',
  pushChannel: 'ws',
  scoreThreshold: 3,
  enableFilter: true,
}

export interface PushMessage {
  version: number
  token: string
  action: 'push_m3u8' | 'push_url' | 'push_file' | 'push_normal' | 'push_dash'
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
  /** HTTP 方法（GET/POST），用于桌面端复刻带 POST body 的请求 */
  method?: string
  /** POST 请求体（移植自 NDM bg.js V.I __0NeatPostData9__ 字段） */
  post_data?: string
  headers?: Record<string, string>
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
  enableLogging: boolean
  enableAdSkip: boolean
  showPageBadge: boolean
  downloadClient: 'aria2' | 'ndm' | 'velo' | 'native'
  rpcHost: string
  rpcPort: number
  rpcSecret: string
}

export const DEFAULT_SETTINGS: Settings = {
  enableHlsAdFilter: true,
  enableLogging: false,
  enableAdSkip: true,
  showPageBadge: true,
  downloadClient: 'velo',
  rpcHost: '127.0.0.1',
  rpcPort: 16888,
  rpcSecret: '',
}