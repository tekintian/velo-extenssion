/**
 * 站点规则自动建议
 *
 * 移植自 NDM suggest.js
 *
 * 流程：
 *   1. processHlsPlaylist 返回的 reasons 里提取所有 'url-pattern:<src>' 正则源
 *   2. 构造候选站点规则 { hostPattern, adUrlPatterns, scoreThreshold }
 *   3. 去重：若已有等价 builtin/user 规则覆盖此 host，跳过
 *   4. 存入 pending（chrome.storage.hlsSuggestPending，上限 20）
 *   5. popup/options UI 展示 pending，用户 approve → addUserRule
 */

import { persistentStorage } from '@/lib/storage'
import { addUserRule, loadUserRules } from './hls-rules'
import type { SiteRule } from './types'

const KEY = 'hlsSuggestPending'
const MAX_PENDING = 20

interface PendingSuggestion {
  readonly id: string
  readonly hostPattern: string
  readonly adUrlPatterns: readonly string[]
  readonly scoreThreshold: number
  readonly createdAt: number
  readonly sourceRule: string | undefined
}

/**
 * 从检测报告的 reasons 提取 url-pattern 正则源
 */
function extractPatterns(reasons: Record<number, string[]>): string[] {
  const set = new Set<string>()
  for (const rs of Object.values(reasons)) {
    for (const r of rs) {
      if (r.startsWith('url-pattern:')) {
        set.add(r.slice('url-pattern:'.length))
      }
    }
  }
  return Array.from(set)
}

/**
 * 转义 host 里的正则特殊字符，使其作为字面 host 匹配
 */
function escapeHost(host: string): string {
  return String(host || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 检测到广告后，考虑生成候选规则
 *
 * @param reasons  processHlsPlaylist 返回的 reasons
 * @param pageHost 当前页面 host
 * @param sourceRule 命中的源规则 ID（避免重复）
 */
export async function consider(
  reasons: Record<number, string[]>,
  pageHost: string,
  sourceRule?: string | null,
): Promise<void> {
  if (!pageHost) return
  const patterns = extractPatterns(reasons)
  if (patterns.length === 0) return

  const hostPattern = escapeHost(pageHost)

  // 去重：已有等价 user 规则覆盖此 host 则跳过
  const userRules = await loadUserRules()
  if (userRules.some((r) => r.hostPattern === hostPattern)) return

  // 加载 pending
  const pending = (await persistentStorage.get<PendingSuggestion[]>(KEY)) ?? []

  // 去重：pending 里已有相同 hostPattern + patterns 则跳过
  const signature = `${hostPattern}|${patterns.sort().join('|')}`
  if (pending.some((p) => `${p.hostPattern}|${[...p.adUrlPatterns].sort().join('|')}` === signature)) {
    return
  }

  const suggestion: PendingSuggestion = {
    id: `suggest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    hostPattern,
    adUrlPatterns: patterns,
    scoreThreshold: 3,
    createdAt: Date.now(),
    sourceRule: sourceRule ?? undefined,
  }

  pending.push(suggestion)
  // 上限：保留最近 MAX_PENDING
  if (pending.length > MAX_PENDING) {
    pending.splice(0, pending.length - MAX_PENDING)
  }
  await persistentStorage.set(KEY, pending)
}

/**
 * 列出 pending 建议供 UI 展示
 */
export async function listPending(): Promise<PendingSuggestion[]> {
  return (await persistentStorage.get<PendingSuggestion[]>(KEY)) ?? []
}

/**
 * 批准建议 → 转为正式用户规则
 */
export async function approve(id: string): Promise<boolean> {
  const pending = (await persistentStorage.get<PendingSuggestion[]>(KEY)) ?? []
  const suggestion = pending.find((p) => p.id === id)
  if (!suggestion) return false

  const rule: SiteRule = {
    id: `user-${Date.now()}`,
    name: `自动建议 (${suggestion.hostPattern})`,
    hostPattern: suggestion.hostPattern,
    adUrlPatterns: suggestion.adUrlPatterns,
    scoreThreshold: suggestion.scoreThreshold,
    forceKeep: [],
  }
  await addUserRule(rule)

  // 从 pending 移除
  const remaining = pending.filter((p) => p.id !== id)
  await persistentStorage.set(KEY, remaining)
  return true
}

/**
 * 忽略建议
 */
export async function dismiss(id: string): Promise<boolean> {
  const pending = (await persistentStorage.get<PendingSuggestion[]>(KEY)) ?? []
  const remaining = pending.filter((p) => p.id !== id)
  if (remaining.length === pending.length) return false
  await persistentStorage.set(KEY, remaining)
  return true
}
