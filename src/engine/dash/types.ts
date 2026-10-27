/**
 * DASH 广告过滤 — 类型定义
 *
 * 覆盖三大 manifest 来源：
 *   - 模式 B: JSON Playurl（B站 playurl / YouTube player API）— 高优
 *   - 模式 A: MPD XML（DASH-IF 参考服务器 / IPTV）— 次优
 *   - 模式 C: 纯分片（无 manifest，依赖 MSE Hook 指纹）— 兜底
 *
 * 共享类型从 shared/types 导入。
 */

import type {
  SiteRule,
  AdRange,
} from '@engine/shared/types'

// ============================================================================
// JSON Playurl（模式 B — B站 / YouTube）
// ============================================================================

export type PlayurlSource = 'bili-playurl' | 'youtube-player' | 'unknown'

export interface SegmentBaseInfo {
  initialization: string
  indexRange?: string
}

export interface SegmentTemplateInfo {
  media?: string
  initialization?: string
  timescale?: number
  duration?: number
  startNumber?: number
  segmentTimeline?: SegmentTimelineEntry[]
}

export interface SegmentTimelineEntry {
  t: number
  d: number
  r?: number
}

export interface PlayurlTrack {
  id: string
  kind: 'video' | 'audio'
  bandwidth: number
  mimeType: string
  codecs?: string
  width?: number
  height?: number
  frameRate?: string
  baseUrl: string
  backupUrls?: string[]
  segmentBase?: SegmentBaseInfo
  segmentTemplate?: SegmentTemplateInfo
  byteRange?: { start: number; end: number }
  metadata: Record<string, unknown>
}

export interface JsonPlayurlManifest {
  type: 'json-playurl'
  source: PlayurlSource
  duration: number
  minBufferTime?: number
  tracks: PlayurlTrack[]
  raw: Record<string, unknown>
}

// ============================================================================
// MPD XML（模式 A — DASH-IF / IPTV）
// ============================================================================

export interface ContentProtectionInfo {
  schemeIdUri: string
  value?: string
  cencPssh?: string
}

export interface MpdEventStream {
  schemeIdUri: string
  value?: string
  events: Array<{
    presentationTime?: number
    duration?: number
    id?: number
    content?: string
  }>
}

export interface MpdRepresentation {
  id: string
  bandwidth: number
  width?: number
  height?: number
  codecs?: string
  mimeType?: string
  segmentBase?: SegmentBaseInfo
  segmentTemplate?: SegmentTemplateInfo
  baseUrl?: string
}

export interface MpdAdaptation {
  id?: string
  mimeType?: string
  contentType?: string
  lang?: string
  representations: MpdRepresentation[]
  segmentTemplate?: SegmentTemplateInfo
  baseUrl?: string
}

export interface MpdPeriod {
  id?: string
  start?: number
  duration?: number
  xlinkHref?: string
  adaptations: MpdAdaptation[]
  eventStreams?: MpdEventStream[]
  baseUrl?: string
}

export interface MpdManifest {
  type: 'mpd-xml'
  mpdType: 'static' | 'dynamic'
  mediaPresentationDuration?: number
  minBufferTime?: number
  periods: MpdPeriod[]
  contentProtections: ContentProtectionInfo[]
  baseUrl?: string
  rawXml: string
}

// ============================================================================
// Manifest 类型联合
// ============================================================================

export type DashManifest = JsonPlayurlManifest | MpdManifest

export type ManifestType = 'json-playurl' | 'mpd-xml' | 'unknown'

// ============================================================================
// 广告检测
// ============================================================================

export interface DashDetection {
  targetId: string
  targetType: 'track' | 'period'
  signal: string
  score: number
  reason: string
  metadata?: Record<string, unknown>
}

export interface DashDetectionResult {
  adTargetIds: Set<string>
  detections: DashDetection[]
  forceKeep: Set<string>
  summary: DashDetectionSummary
}

export interface DashDetectionSummary {
  totalTargets: number
  adTargets: number
  signals: Record<string, number>
  appliedRule?: SiteRule | null
}

// ============================================================================
// 配置
// ============================================================================

export type DashAdDeliveryMode = 'disabled' | 'passthrough' | 'manifest-file' | 'data-url'

export type DashFingerprintMode = 'off' | 'suspicious-only' | 'all'

export interface DashAdFilterConfig {
  enabled: boolean
  mode: DashAdDeliveryMode
  scoreThreshold: number
  urlPatterns: readonly string[]
  logToConsole: boolean
  remoteRulesUrl: string
  enableFingerprint: boolean
  fingerprintMode: DashFingerprintMode
  autoLearnFingerprints: boolean
  remoteFingerprintsUrl: string
  maxFingerprintPerManifest: number

  _patterns?: readonly RegExp[]
  _forceKeep?: readonly RegExp[]
  _appliedRule?: SiteRule | null
}

// ============================================================================
// processManifest 主入口返回
// ============================================================================

export type DashProcessResult =
  | { mode: 'no-ads'; summary: DashDetectionSummary; adRanges?: AdRange[] }
  | { mode: 'manifest-file'; cleanedText: string; summary: DashDetectionSummary; adRanges?: AdRange[] }
  | { mode: 'data-url'; dataUrl: string; cleanedText: string; summary: DashDetectionSummary; adRanges?: AdRange[] }
  | { mode: 'passthrough'; summary: DashDetectionSummary; reason?: string }
  | { mode: 'disabled'; reason: string }

// ============================================================================
// Content Script ↔ Background 消息
// ============================================================================

export interface ProcessDashManifestMessage {
  type: 'processDashManifest'
  rawText: string
  url: string
  pageUrl: string
  authHeaders?: Record<string, string>
  config?: Partial<DashAdFilterConfig>
}

export interface DashManifestResponse {
  result: DashProcessResult
  adRanges: AdRange[]
}

// ============================================================================
// Cleaned Context（持久化供 sniffer 下载链路使用）
// ============================================================================

export interface CleanedDashContext {
  url: string
  pageUrl: string
  manifestType: ManifestType
  cleanedText: string
  adTargetCount: number
  originalTargetCount: number
  timestamp: number
}