/**
 * 媒体嗅探类型定义
 */

/** DASH 音视频角色 */
export type DashRole = 'video' | 'audio'

/** 单个嗅探到的媒体项 */
export interface MediaItem {
  /** 唯一 ID（requestId 或 hash(url)） */
  readonly id: string
  /** 资源 URL */
  readonly url: string
  /** HTTP 方法 */
  readonly method: string
  /** 资源类型 (chrome.webRequest.ResourceType) */
  readonly resourceType: string
  /** Content-Type */
  readonly contentType: string
  /** Content-Disposition */
  readonly contentDisposition: string
  /** 文件大小（字节，从 Content-Length 或 Content-Range 提取） */
  readonly size: number
  /** 文件名（从 Content-Disposition 或 URL 提取） */
  readonly fileName: string
  /** 扩展名（小写，无点） */
  readonly ext: string
  /** tabId */
  readonly tabId: number
  /** 嗅探时间 */
  readonly detectedAt: number
  /** POST 请求体 (移植自 NDM bg.js V.T requestBody) */
  readonly requestBody?: string | undefined
  /** 自定义请求头 x-* (移植自 NDM bg.js V.U requestHeaders) */
  readonly requestHeaders?: Record<string, string> | undefined
  /** DASH 音视频角色（video/audio），配对后由 pairDashItems 设置 */
  readonly dashRole?: DashRole | undefined
  /** DASH 配对组 ID（同一视频的音视频共享同一 groupId），配对后由 pairDashItems 设置 */
  readonly dashGroupId?: string | undefined
  /** 页面代际号（SPA 路由变化时递增，用于过滤旧代际的过期项） */
  readonly generation?: number | undefined
}

/** DASH 音视频配对组 */
export interface DashPair {
  /** 配对组 ID */
  readonly groupId: string
  /** 视频 m4s 项 */
  readonly video: MediaItem
  /** 音频 m4s 项 */
  readonly audio: MediaItem
}

/** 下载客户端配置 */
export interface DownloadClientConfig {
  /** 客户端类型 */
  readonly client: 'ndm' | 'aria2' | 'velo' | 'native'
  /** aria2 RPC host */
  readonly rpcHost: string
  /** aria2 RPC port (Velo 默认 16816) */
  readonly rpcPort: number
  /** aria2 RPC secret (可选) */
  readonly rpcSecret: string
  /** velo push server host */
  readonly veloHost: string
  /** velo push server port (默认 16888) */
  readonly veloPort: number
  /** velo push server token (配对认证) */
  readonly veloToken: string
}

/** 默认下载客户端配置 */
export const DEFAULT_DOWNLOAD_CONFIG: DownloadClientConfig = {
  client: 'native',
  rpcHost: 'localhost',
  rpcPort: 16816,
  rpcSecret: '',
  veloHost: '127.0.0.1',
  veloPort: 16888,
  veloToken: 'ndm-auto',
}