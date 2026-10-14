/**
 * HLS 广告分片过滤 — 类型定义
 *
 * 移植自 neat-download-manager/ad-filter.js + rules.js + fingerprint.js
 * 原 JS 全局变量挂载，TS 化为纯函数 + 命名 export
 */

// ============================================================================
// 播放列表解析
// ============================================================================

/** 单个分片上下文（parsePlaylist 输出） */
export interface Segment {
  /** 分片索引（在播放列表内顺序） */
  readonly index: number
  /** 绝对 URL */
  readonly url: string
  /** EXTINF duration（秒） */
  readonly duration: number
  /** EXTINF title（逗号后部分） */
  readonly title: string
  /** EXT-X-BYTERANGE 原文 */
  readonly byterange: string | null
  /** 是否带 EXT-X-DISCONTINUITY */
  readonly discontinuity: boolean
  /** 'out' = 在广告块内（CUE-OUT / SCTE35-OUT / DATERANGE-ad），null = 正常内容 */
  readonly cueState: 'out' | null
  /** SCTE35 信令原文 */
  readonly scte35: string | null
  /** DATERANGE 广告块原文 */
  readonly dateRangeAd: string | null
  /** 从文件名提取的尾号（用于跳号检测） */
  readonly seqNum: number | null
}

/** parsePlaylist 输出 */
export interface ParsedPlaylist {
  /** 头部标签原文（#EXTM3U 之后的非分片行） */
  readonly headerTags: string[]
  /** 全部分片 */
  readonly segments: Segment[]
  /** EXT-X-MEDIA-SEQUENCE 起始值 */
  readonly mediaSeqStart: number
}

// ============================================================================
// 广告检测
// ============================================================================

/** 检测结果 */
export interface DetectionResult {
  /** 广告分片索引集合 */
  adSegments: Set<number>
  /** 分片索引 → 命中理由数组 */
  reasons: Map<number, string[]>
  /** 统计报告（指纹步骤可能更新，所以非 readonly） */
  report: DetectionReport
}

/** 检测统计报告 */
export interface DetectionReport {
  readonly total: number
  readonly ads: number
  /** 广告总时长（秒） */
  readonly adDuration: number
  /** 内容总时长（秒） */
  readonly contentDuration: number
  /** 命中的站点规则（可选） */
  readonly appliedRule?: SiteRule | null
}

// ============================================================================
// 站点规则
// ============================================================================

/** 单条站点规则 */
export interface SiteRule {
  readonly id: string
  readonly name: string
  /** 域名匹配正则字符串（匹配 page host） */
  readonly hostPattern: string
  /** 追加的广告 URL 正则字符串（合并到默认 7 条之后） */
  readonly adUrlPatterns: readonly string[]
  /** 覆盖判广告阈值 */
  readonly scoreThreshold?: number
  /** 覆盖投递模式 */
  readonly mode?: AdDeliveryMode
  /** 强制保留（绝不当作广告）的 URL 正则字符串 */
  readonly forceKeep: readonly string[]
}

// ============================================================================
// 配置
// ============================================================================

export type AdDeliveryMode = 'data-url' | 'passthrough' | 'm3u8-file' | 'disabled'

export type FingerprintMode = 'off' | 'suspicious-only' | 'all'

/** 过滤配置（合并默认 + 用户配置 + 站点规则） */
export interface AdFilterConfig {
  readonly enabled: boolean
  readonly mode: AdDeliveryMode
  readonly scoreThreshold: number
  /** 用户追加的 URL 正则字符串数组 */
  readonly urlPatterns: readonly string[]
  readonly logToConsole: boolean
  /** 时长统计的最小样本量 */
  readonly minSegmentsForStats: number
  /** 剔除广告后是否在断点补 EXT-X-DISCONTINUITY */
  readonly keepDiscontinuityOnGap: boolean
  /** 远程站点规则 URL */
  readonly remoteRulesUrl: string
  /** 指纹二次过滤总开关 */
  readonly enableFingerprint: boolean
  readonly fingerprintMode: FingerprintMode
  /** 已判广告分片自动入库 */
  readonly autoLearnFingerprints: boolean
  /** 远程指纹库 JSON URL */
  readonly remoteFingerprintsUrl: string
  /** 单次播放列表指纹上限 */
  readonly maxFingerprintPerPlaylist: number

  // —— 运行时合成字段（非用户配置，由 getConfig 填充） ——
  /** 已编译的 URL 正则（默认 + 用户 + 站点规则） */
  readonly _patterns?: readonly RegExp[]
  /** 已编译的 forceKeep 正则 */
  readonly _forceKeep?: readonly RegExp[]
  /** 命中的站点规则 */
  readonly _appliedRule?: SiteRule | null
}

// ============================================================================
// 指纹
// ============================================================================

/** 指纹库条目 */
export interface FingerprintEntry {
  readonly hash: string
  readonly adName: string
  readonly source: string
  readonly firstSeen: number
}

/** 指纹查找结果 */
export interface FingerprintLookupResult {
  readonly isAd: boolean
  readonly adName?: string
  readonly source?: string
}

// ============================================================================
// processPlaylist 主入口返回
// ============================================================================

/** 广告时间区间（用于页面内播放跳过） */
export interface AdRange {
  readonly start: number
  readonly end: number
  readonly duration: number
}

/** processPlaylist 输出（discriminated union） */
export type ProcessResult =
  | { readonly mode: 'disabled'; readonly url: string; readonly report: null }
  | { readonly mode: 'master'; readonly url: string; readonly report: { readonly master: true; readonly variants: number; readonly appliedRule: SiteRule | null } }
  | { readonly mode: 'no-ads'; readonly url: string; readonly report: DetectionReport; readonly segments: readonly Segment[] }
  | { readonly mode: 'passthrough'; readonly url: string; readonly report: DetectionReport; readonly reasons: Record<number, string[]>; readonly adSegmentUrls: string[]; readonly segments: readonly Segment[]; readonly adRanges: AdRange[] }
  | { readonly mode: 'm3u8-file'; readonly cleaned: string; readonly report: DetectionReport; readonly reasons: Record<number, string[]>; readonly adSegmentUrls: string[]; readonly segments: readonly Segment[]; readonly adRanges: AdRange[] }
  | { readonly mode: 'data-url'; readonly url: string; readonly cleaned: string; readonly report: DetectionReport; readonly reasons: Record<number, string[]>; readonly adSegmentUrls: string[]; readonly segments: readonly Segment[]; readonly adRanges: AdRange[] }
