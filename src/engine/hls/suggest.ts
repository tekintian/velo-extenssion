/**
 * HLS 规则自动建议 — re-export 自 shared/suggest
 *
 * HLS/DASH 引擎共用同一套建议系统，已提取到 engine/shared/suggest.ts。
 * 本模块保留仅为向后兼容，所有 API 行为不变。
 */

export {
  DEFAULT_SIGNAL_PREFIXES,
  extractPatterns,
  escapeHost,
  consider,
  listPending,
  approve,
  dismiss,
} from '@engine/shared/suggest'