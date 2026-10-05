import { persistentStorage } from '@/lib/storage'
import type { FingerprintLookupResult } from './types'

const PREFIX_BYTES = 65536
const MAX_LEARNED = 5000
const LEARNED_KEY = 'hlsFingerprintsLearned'
const REMOTE_TTL = 6 * 60 * 60 * 1000

const urlCache = new Map<string, string | null>()
let learned: Map<string, { adName: string; source: string; firstSeen: number }> | null = null
let remote: Map<string, { adName: string; source: string }> | null = null
let remoteLoadedAt = 0

async function loadLearned(): Promise<void> {
  if (learned) return
  try {
    const stored = await persistentStorage.get<Record<string, { adName: string; source: string; firstSeen: number }>>(LEARNED_KEY)
    learned = new Map(Object.entries(stored ?? {}))
  } catch {
    learned = new Map()
  }
}

async function persistLearned(): Promise<void> {
  if (!learned) return
  const obj: Record<string, { adName: string; source: string; firstSeen: number }> = {}
  for (const [k, v] of learned) obj[k] = v
  await persistentStorage.set(LEARNED_KEY, obj)
}

async function loadRemote(remoteUrl: string, force = false): Promise<void> {
  if (!remoteUrl) { remote = new Map(); return }
  if (!force && remote && Date.now() - remoteLoadedAt < REMOTE_TTL) return
  try {
    const res = await fetch(remoteUrl, { cache: 'no-cache' })
    if (!res.ok) return
    const arr = (await res.json()) as Array<{ hash: string; adName?: string }>
    remote = new Map()
    for (const item of arr) remote.set(item.hash, { adName: item.adName ?? 'remote', source: 'remote' })
    remoteLoadedAt = Date.now()
  } catch {
    if (!remote) remote = new Map()
  }
}

export async function initFingerprint(remoteUrl?: string): Promise<{ learned: number; remote: number }> {
  await loadLearned()
  await loadRemote(remoteUrl ?? '')
  return { learned: learned?.size ?? 0, remote: remote?.size ?? 0 }
}

export async function clearLearned(): Promise<void> {
  learned = new Map()
  await persistLearned()
}

export function clearUrlCache(): void {
  urlCache.clear()
}

export async function computeFingerprint(url: string): Promise<string | null> {
  if (urlCache.has(url)) return urlCache.get(url) ?? null
  try {
    const res = await fetch(url, { headers: { Range: `bytes=0-${PREFIX_BYTES - 1}` }, cache: 'no-store' })
    if (!res.ok) { urlCache.set(url, null); return null }
    const buf = await res.arrayBuffer()
    const bytes = new Uint8Array(buf).slice(0, PREFIX_BYTES)
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes)
    const hashHex = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('')
    urlCache.set(url, hashHex)
    return hashHex
  } catch {
    urlCache.set(url, null)
    return null
  }
}

export function lookupFingerprint(hash: string): FingerprintLookupResult {
  if (learned && learned.has(hash)) {
    const e = learned.get(hash)!
    return { isAd: true, adName: e.adName, source: e.source }
  }
  if (remote && remote.has(hash)) {
    const e = remote.get(hash)!
    return { isAd: true, adName: e.adName, source: e.source }
  }
  return { isAd: false }
}

export async function learnFingerprint(hash: string, meta: { adName: string; source: string }): Promise<boolean> {
  await loadLearned()
  if (!learned) learned = new Map()
  if (learned.has(hash)) return false
  learned.set(hash, { ...meta, firstSeen: Date.now() })
  if (learned.size > MAX_LEARNED) {
    const entries = Array.from(learned.entries()).sort((a, b) => a[1].firstSeen - b[1].firstSeen)
    const toRemove = entries.slice(0, entries.length - MAX_LEARNED)
    for (const [k] of toRemove) learned.delete(k)
  }
  await persistLearned()
  return true
}

export function getLearnedCount(): number {
  return learned?.size ?? 0
}
