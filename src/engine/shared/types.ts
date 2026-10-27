/**
 * 广告过滤共享类型定义
 *
 * 从 engine/hls/types.ts 提取，HLS 和 DASH 引擎共用。
 * HLS 特有类型（Segment / ParsedPlaylist / M3u8 相关）保留在 hls/types.ts。
 * DASH 特有类型（MpdManifest / JsonPlayurlManifest）放在 dash/types.ts。
 */

// ============================================================================
// 站点规则（HLS + DASH 共用）
// ============================================================================

/** 单条站点规则 */
export interface SiteRule {
  readonly id: string
  readonly name: string
  /** 域名匹配正则字符串（匹配 page host） */
  readonly hostPattern: string
  /** 追加的广告 URL 正则字符串（合并到默认规则之后） */
  readonly adUrlPatterns: readonly string[]
  /** 覆盖判广告阈值 */
  readonly scoreThreshold?: number
  /** 覆盖投递模式 */
  readonly mode?: string
  /** 强制保留（绝不当作广告）的 URL 正则字符串 */
  readonly forceKeep: readonly string[]
}

// ============================================================================
// 指纹（HLS + DASH 共用）
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
// 检测报告（HLS + DASH 共用）
// ============================================================================

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

/** 广告时间区间（用于页面内播放跳过） */
export interface AdRange {
  readonly start: number
  readonly end: number
  readonly duration: number
}