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

function extractPatterns(reasons: Record<number, string[]>): string[] {
  const set = new Set<string>()
  for (const rs of Object.values(reasons)) {
    for (const r of rs) {
      if (r.startsWith('url-pattern:')) set.add(r.slice('url-pattern:'.length))
    }
  }
  return Array.from(set)
}

function escapeHost(host: string): string {
  return String(host || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function consider(
  reasons: Record<number, string[]>,
  pageHost: string,
  sourceRule?: string | null,
): Promise<void> {
  if (!pageHost) return
  const patterns = extractPatterns(reasons)
  if (patterns.length === 0) return

  const hostPattern = escapeHost(pageHost)
  const userRules = await loadUserRules()
  if (userRules.some((r) => r.hostPattern === hostPattern)) return

  const pending = (await persistentStorage.get<PendingSuggestion[]>(KEY)) ?? []
  const signature = `${hostPattern}|${patterns.sort().join('|')}`
  if (pending.some((p) => `${p.hostPattern}|${[...p.adUrlPatterns].sort().join('|')}` === signature)) return

  const suggestion: PendingSuggestion = {
    id: `suggest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    hostPattern, adUrlPatterns: patterns, scoreThreshold: 3,
    createdAt: Date.now(), sourceRule: sourceRule ?? undefined,
  }

  pending.push(suggestion)
  if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING)
  await persistentStorage.set(KEY, pending)
}

export async function listPending(): Promise<PendingSuggestion[]> {
  return (await persistentStorage.get<PendingSuggestion[]>(KEY)) ?? []
}

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

  const remaining = pending.filter((p) => p.id !== id)
  await persistentStorage.set(KEY, remaining)
  return true
}

export async function dismiss(id: string): Promise<boolean> {
  const pending = (await persistentStorage.get<PendingSuggestion[]>(KEY)) ?? []
  const remaining = pending.filter((p) => p.id !== id)
  if (remaining.length === pending.length) return false
  await persistentStorage.set(KEY, remaining)
  return true
}
