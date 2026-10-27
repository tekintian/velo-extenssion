/**
 * 站点规则自动建议（HLS + DASH 共享）
 *
 * 从 engine/hls/suggest.ts 提取，信号前缀可配置化。
 *
 * 流程：
 *   1. 从检测 reasons 里提取配置的信号前缀对应的正则源
 *   2. 构造候选站点规则 { hostPattern, adUrlPatterns, scoreThreshold }
 *   3. 去重：若已有等价 builtin/user 规则覆盖此 host，跳过
 *   4. 存入 pending（chrome.storage.adFilterSuggestPending，上限 20）
 *   5. popup/options UI 展示 pending，用户 approve → addUserRule
 */

import { persistentStorage } from '@/lib/storage'
import { AD_FILTER_KEYS } from './storage'
import { addUserRule, loadUserRules } from './rules'
import type { SiteRule } from './types'

const MAX_PENDING = 20

export const DEFAULT_SIGNAL_PREFIXES: readonly string[] = [
  'url-pattern',
  'origin-differs',
  'path-differs',
]

interface PendingSuggestion {
  readonly id: string
  readonly hostPattern: string
  readonly adUrlPatterns: readonly string[]
  readonly scoreThreshold: number
  readonly createdAt: number
  readonly sourceRule: string | undefined
}

/**
 * 从检测报告的 reasons 提取指定信号前缀的正则源
 *
 * @param reasons 引擎返回的 reasons 结构（HLS: Map<segmentIdx, string[]>，DASH: 同理）
 * @param signalPrefixes 要提取的信号前缀数组，默认 [DEFAULT_SIGNAL_PREFIXES]
 */
export function extractPatterns(
  reasons: Record<number, string[]> | Map<number, string[]>,
  signalPrefixes: readonly string[] = DEFAULT_SIGNAL_PREFIXES,
): string[] {
  const set = new Set<string>()
  const prefixSet = new Set(signalPrefixes)

  const entries = reasons instanceof Map ? reasons.entries() : Object.entries(reasons)
  for (const [, rs] of entries) {
    for (const r of rs) {
      const colonIdx = r.indexOf(':')
      if (colonIdx < 0) continue
      const signal = r.slice(0, colonIdx)
      if (prefixSet.has(signal)) {
        set.add(r.slice(colonIdx + 1))
      }
    }
  }
  return Array.from(set)
}

/**
 * 转义 host 里的正则特殊字符，使其作为字面 host 匹配
 */
export function escapeHost(host: string): string {
  return String(host || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 检测到广告后，考虑生成候选规则
 *
 * @param reasons       引擎返回的 reasons
 * @param pageHost      当前页面 host
 * @param sourceRule    命中的源规则 ID（避免重复）
 * @param signalPrefixes 本次建议要参考的信号前缀（不同引擎可能有不同信号）
 */
export async function consider(
  reasons: Record<number, string[]> | Map<number, string[]>,
  pageHost: string,
  sourceRule?: string | null,
  signalPrefixes: readonly string[] = DEFAULT_SIGNAL_PREFIXES,
): Promise<void> {
  if (!pageHost) return
  const patterns = extractPatterns(reasons, signalPrefixes)
  if (patterns.length === 0) return

  const hostPattern = escapeHost(pageHost)

  const userRules = await loadUserRules()
  if (userRules.some((r) => r.hostPattern === hostPattern)) return

  const pending = (await persistentStorage.get<PendingSuggestion[]>(AD_FILTER_KEYS.SUGGEST_PENDING)) ?? []

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
  if (pending.length > MAX_PENDING) {
    pending.splice(0, pending.length - MAX_PENDING)
  }
  await persistentStorage.set(AD_FILTER_KEYS.SUGGEST_PENDING, pending)
}

export async function listPending(): Promise<PendingSuggestion[]> {
  return (await persistentStorage.get<PendingSuggestion[]>(AD_FILTER_KEYS.SUGGEST_PENDING)) ?? []
}

export async function approve(id: string): Promise<boolean> {
  const pending = (await persistentStorage.get<PendingSuggestion[]>(AD_FILTER_KEYS.SUGGEST_PENDING)) ?? []
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

  const remaining = pending.filter((p) => p.id !== id)
  await persistentStorage.set(AD_FILTER_KEYS.SUGGEST_PENDING, remaining)
  return true
}

export async function dismiss(id: string): Promise<boolean> {
  const pending = (await persistentStorage.get<PendingSuggestion[]>(AD_FILTER_KEYS.SUGGEST_PENDING)) ?? []
  const remaining = pending.filter((p) => p.id !== id)
  if (remaining.length === pending.length) return false
  await persistentStorage.set(AD_FILTER_KEYS.SUGGEST_PENDING, remaining)
  return true
}