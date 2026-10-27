/**
 * 广告过滤共享 storage key + 迁移工具
 *
 * HLS 原有 storage key 带 hls 前缀，现通用化为 adFilter 前缀。
 * 迁移逻辑：首次启动时读取旧 key → 写入新 key → 删除旧 key。
 */

import { persistentStorage } from '@/lib/storage'

// 新 key（通用化，HLS + DASH 共享）
export const AD_FILTER_KEYS = {
  FINGERPRINTS_LEARNED: 'adFilterFingerprintsLearned',
  USER_RULES: 'adFilterUserRules',
  REMOTE_RULES_CACHE: 'adFilterRemoteRulesCache',
  SUGGEST_PENDING: 'adFilterSuggestPending',
} as const

// 旧 key（HLS 专属前缀）
const LEGACY_KEYS = {
  FINGERPRINTS_LEARNED: 'hlsFingerprintsLearned',
  USER_RULES: 'hlsUserRules',
  REMOTE_RULES_CACHE: 'hlsRemoteRulesCache',
  SUGGEST_PENDING: 'hlsSuggestPending',
} as const

const MIGRATION_FLAG = 'adFilterKeysMigrated_v1'

/**
 * 一次性迁移旧 key → 新 key
 *
 * 双写验证：新 key 写入后立即读回校验，校验成功才删旧 key。
 * 幂等：迁移完成后写 flag，后续启动跳过。
 */
export async function migrateAdFilterKeys(): Promise<{ migrated: boolean; details: Record<string, { from: string; to: string; bytes: number }> }> {
  const already = await persistentStorage.get<boolean>(MIGRATION_FLAG)
  if (already) return { migrated: false, details: {} }

  const details: Record<string, { from: string; to: string; bytes: number }> = {}

  for (const [legacy, newKey] of Object.entries(LEGACY_KEYS) as [keyof typeof LEGACY_KEYS, string][]) {
    const oldVal = await persistentStorage.get<unknown>(legacy)
    if (oldVal === undefined || oldVal === null) continue

    const bytes = JSON.stringify(oldVal).length
    await persistentStorage.set(newKey, oldVal)

    const verify = await persistentStorage.get<unknown>(newKey)
    if (JSON.stringify(verify) === JSON.stringify(oldVal)) {
      await persistentStorage.remove(legacy)
      details[legacy] = { from: legacy, to: newKey, bytes }
    }
  }

  await persistentStorage.set(MIGRATION_FLAG, true)
  return { migrated: Object.keys(details).length > 0, details }
}