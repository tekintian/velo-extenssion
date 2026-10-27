/**
 * HLS 广告分片过滤 — 类型定义
 *
 * HLS 特有类型（Segment / ParsedPlaylist / ProcessResult 等）保留在此。
 * 共享类型（SiteRule / FingerprintLookupResult 等）从 shared/types 导入后重新导出，
 * 消费端无需改动 import 路径。
 */

import type {
  SiteRule as SharedSiteRule,
  FingerprintEntry as SharedFingerprintEntry,
  FingerprintLookupResult as SharedFingerprintLookupResult,
  DetectionReport as SharedDetectionReport,
  AdRange as SharedAdRange,
} from '@engine/shared/types'

export type SiteRule = SharedSiteRule
export type FingerprintEntry = SharedFingerprintEntry
export type FingerprintLookupResult = SharedFingerprintLookupResult
export type DetectionReport = SharedDetectionReport
export type AdRange = SharedAdRange

// ============================================================================
// 播放列表解析（HLS 特有）
// ============================================================================

/** 单个分片上下文（parsePlaylist 输出） */
export interface Segment {
  readonly index: number
  readonly url: string
  readonly duration: number
  readonly title: string
  readonly byterange: string | null
  readonly discontinuity: boolean
  readonly cueState: 'out' | null
  readonly scte35: string | null
  readonly dateRangeAd: string | null
  readonly seqNum: number | null
}

export interface ParsedPlaylist {
  readonly headerTags: string[]
  readonly segments: Segment[]
  readonly mediaSeqStart: number
}

// ============================================================================
// 广告检测（HLS 特有）
// ============================================================================

export interface DetectionResult {
  adSegments: Set<number>
  reasons: Map<number, string[]>
  report: DetectionReport
}

// ============================================================================
// 配置（HLS 特有，mode 字段值）
// ============================================================================

export type AdDeliveryMode = 'data-url' | 'passthrough' | 'm3u8-file' | 'disabled' | 'master' | 'no-ads'

export type FingerprintMode = 'off' | 'suspicious-only' | 'all'

export interface AdFilterConfig {
  readonly enabled: boolean
  readonly mode: AdDeliveryMode
  readonly scoreThreshold: number
  readonly urlPatterns: readonly string[]
  readonly logToConsole: boolean
  readonly minSegmentsForStats: number
  readonly keepDiscontinuityOnGap: boolean
  readonly remoteRulesUrl: string
  readonly enableFingerprint: boolean
  readonly fingerprintMode: FingerprintMode
  readonly autoLearnFingerprints: boolean
  readonly remoteFingerprintsUrl: string
  readonly maxFingerprintPerPlaylist: number

  readonly _patterns?: readonly RegExp[]
  readonly _forceKeep?: readonly RegExp[]
  readonly _appliedRule?: SiteRule | null
}

// ============================================================================
// processPlaylist 主入口返回（HLS 特有）
// ============================================================================

export type ProcessResult =
  | { readonly mode: 'disabled'; readonly url: string; readonly report: null }
  | { readonly mode: 'master'; readonly url: string; readonly report: { readonly master: true; readonly variants: number; readonly appliedRule: SiteRule | null } }
  | { readonly mode: 'no-ads'; readonly url: string; readonly report: DetectionReport; readonly segments: readonly Segment[] }
  | { readonly mode: 'passthrough'; readonly url: string; readonly report: DetectionReport; readonly reasons: Record<number, string[]>; readonly adSegmentUrls: string[]; readonly segments: readonly Segment[]; readonly adRanges: AdRange[] }
  | { readonly mode: 'm3u8-file'; readonly cleaned: string; readonly report: DetectionReport; readonly reasons: Record<number, string[]>; readonly adSegmentUrls: string[]; readonly segments: readonly Segment[]; readonly adRanges: AdRange[] }
  | { readonly mode: 'data-url'; readonly url: string; readonly cleaned: string; readonly report: DetectionReport; readonly reasons: Record<number, string[]>; readonly adSegmentUrls: string[]; readonly segments: readonly Segment[]; readonly adRanges: AdRange[] }