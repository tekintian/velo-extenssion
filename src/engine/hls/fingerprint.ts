/**
 * HLS 指纹库 — re-export 自 shared/fingerprint
 *
 * HLS/DASH 引擎共用同一套指纹系统，已提取到 engine/shared/fingerprint.ts。
 * 本模块保留仅为向后兼容，所有 API 行为不变。
 */

export {
  initFingerprint,
  clearLearned,
  clearUrlCache,
  computeFingerprint,
  lookupFingerprint,
  lookupUserMarkedFingerprint,
  hasUserMarkedFingerprints,
  learnFingerprint,
  getLearnedCount,
  USER_MARKED_SOURCE,
} from '@engine/shared/fingerprint'