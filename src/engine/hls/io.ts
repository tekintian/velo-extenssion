import { persistentStorage } from '@/lib/storage'
import { loadUserRules, saveUserRules } from './hls-rules'
import { listPending } from './suggest'
import { listSamples, recordSample, clearSamples } from './samples'
import type { AdSample } from './samples'
import { getStats, clearStats } from './stats'
import type { SiteRule } from './types'

const SCHEMA = 'adclear-hls-backup'
const VERSION = 1

const CONFIG_KEY = 'hlsFilterConfig'
const LEARNED_KEY = 'hlsFingerprintsLearned'
const SUGGEST_KEY = 'hlsSuggestPending'
const SAMPLES_KEY = 'hlsAdSamples'
const STATS_KEY = 'hlsStats'

export interface BackupPayload {
  readonly schema: string
  readonly version: number
  readonly exportedAt: number
  readonly userRules?: unknown
  readonly pendingSuggestions?: unknown
  readonly hlsConfig?: unknown
  readonly learnedFingerprints?: unknown
  readonly samples?: unknown
  readonly stats?: unknown
}

export async function buildExport(): Promise<BackupPayload> {
  const payload: BackupPayload = { schema: SCHEMA, version: VERSION, exportedAt: Date.now() }
  const userRules = await loadUserRules()
  const pending = await listPending()
  const hlsConfig = await persistentStorage.get<unknown>(CONFIG_KEY)
  const learnedFingerprints = await persistentStorage.get<unknown>(LEARNED_KEY)
  const samples = await listSamples()
  const stats = await getStats()

  const p = payload as unknown as Record<string, unknown>
  if (userRules.length) p.userRules = userRules
  if (pending.length) p.pendingSuggestions = pending
  if (hlsConfig) p.hlsConfig = hlsConfig
  if (learnedFingerprints) p.learnedFingerprints = learnedFingerprints
  if (samples.length) p.samples = samples
  p.stats = stats

  return p as unknown as BackupPayload
}

export async function applyImport(
  imported: BackupPayload,
  strategy: 'merge' | 'replace' = 'merge',
): Promise<{ userRules: number; pending: number; samples: number; fingerprints: number }> {
  const result = { userRules: 0, pending: 0, samples: 0, fingerprints: 0 }

  if (imported.userRules) {
    const importedRules = imported.userRules as SiteRule[]
    if (strategy === 'replace') {
      await saveUserRules(importedRules)
      result.userRules = importedRules.length
    } else {
      const existing = await loadUserRules()
      const byId = new Map(existing.map((r) => [r.id, r]))
      for (const r of importedRules) byId.set(r.id, r as SiteRule)
      await saveUserRules(Array.from(byId.values()) as SiteRule[])
      result.userRules = byId.size
    }
  }

  if (imported.pendingSuggestions) {
    const importedPending = imported.pendingSuggestions as Array<{ id: string }>
    const existing = (await persistentStorage.get<unknown[]>(SUGGEST_KEY)) ?? []
    const existingIds = new Set(existing.map((s) => (s as { id: string }).id))
    const newOnes = importedPending.filter((p) => !existingIds.has(p.id))
    if (strategy === 'replace') {
      await persistentStorage.set(SUGGEST_KEY, importedPending)
      result.pending = importedPending.length
    } else {
      await persistentStorage.set(SUGGEST_KEY, [...existing, ...newOnes])
      result.pending = existing.length + newOnes.length
    }
  }

  if (imported.hlsConfig) {
    const existing = strategy === 'replace' ? {} : (await persistentStorage.get<unknown>(CONFIG_KEY)) ?? {}
    await persistentStorage.set(CONFIG_KEY, { ...(existing as object), ...(imported.hlsConfig as object) })
  }

  if (imported.learnedFingerprints) {
    const importedFps = imported.learnedFingerprints as Record<string, unknown>
    if (strategy === 'replace') {
      await persistentStorage.set(LEARNED_KEY, importedFps)
      result.fingerprints = Object.keys(importedFps).length
    } else {
      const existing = (await persistentStorage.get<Record<string, unknown>>(LEARNED_KEY)) ?? {}
      const merged = { ...existing, ...importedFps }
      await persistentStorage.set(LEARNED_KEY, merged)
      result.fingerprints = Object.keys(merged).length
    }
  }

  if (imported.samples) {
    const importedSamples = imported.samples as AdSample[]
    if (strategy === 'replace') {
      await clearSamples()
      for (const s of importedSamples) await recordSample(s)
      result.samples = importedSamples.length
    } else {
      const existing = await listSamples()
      const byId = new Map(existing.map((s) => [s.id, s]))
      for (const s of importedSamples) byId.set(s.id, s)
      await persistentStorage.set(SAMPLES_KEY, Array.from(byId.values()))
      result.samples = byId.size
    }
  }

  if (imported.stats && strategy === 'replace') {
    await clearStats()
    await persistentStorage.set(STATS_KEY, imported.stats)
  }

  return result
}
