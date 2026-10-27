/**
 * HLS 站点规则库 — re-export 自 shared/rules
 *
 * HLS/DASH 引擎共用同一套规则系统，已提取到 engine/shared/rules.ts。
 * 本模块保留仅为向后兼容，所有 API 行为不变。
 */

export {
  BUILTIN_SITE_RULES,
  loadUserRules,
  saveUserRules,
  addUserRule,
  removeUserRule,
  clearUserRules,
  getSiteRule,
  listAllRules,
  refreshRemoteRules,
  loadRemoteCacheFromStorage,
} from '@engine/shared/rules'