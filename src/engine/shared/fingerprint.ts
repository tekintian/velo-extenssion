/**
 * 广告分片首帧哈希指纹库（HLS + DASH 共享）
 *
 * 从 engine/hls/fingerprint.ts 提取，函数协议无关。
 * 只计算前 64KB SHA-256，用于识别广告分片。
 */

import { persistentStorage } from '@/lib/storage'
import { AD_FILTER_KEYS } from './storage'
import type { FingerprintLookupResult } from './types'

const PREFIX_BYTES = 65536
const MAX_LEARNED = 5000
const REMOTE_TTL = 6 * 60 * 60 * 1000

const URL_CACHE_MAX = 1000

const urlCache = new Map<string, string | null>()
let learned: Map<string, { adName: string; source: string; firstSeen: number }> | null = null
let remote: Map<string, { adName: string; source: string }> | null = null
let remoteLoadedAt = 0

function setUrlCache(url: string, value: string | null): void {
  if (urlCache.size >= URL_CACHE_MAX) {
    const firstKey = urlCache.keys().next().value
    if (firstKey !== undefined) urlCache.delete(firstKey)
  }
  urlCache.set(url, value)
}

// ---------- learned 读写 ----------
async function loadLearned(): Promise<void> {
  if (learned) return
  try {
    const stored = await persistentStorage.get<Record<string, { adName: string; source: string; firstSeen: number }>>(AD_FILTER_KEYS.FINGERPRINTS_LEARNED)
    learned = new Map(Object.entries(stored ?? {}))
  } catch {
    learned = new Map()
  }
}

async function persistLearned(): Promise<void> {
  if (!learned) return
  const obj: Record<string, { adName: string; source: string; firstSeen: number }> = {}
  for (const [k, v] of learned) obj[k] = v
  await persistentStorage.set(AD_FILTER_KEYS.FINGERPRINTS_LEARNED, obj)
}

// ---------- remote 读写 ----------
async function loadRemote(remoteUrl: string, force = false): Promise<void> {
  if (!remoteUrl) {
    remote = new Map()
    return
  }
  if (!force && remote && Date.now() - remoteLoadedAt < REMOTE_TTL) return

  try {
    const res = await fetch(remoteUrl, { cache: 'no-cache' })
    if (!res.ok) return
    const arr = (await res.json()) as Array<{ hash: string; adName?: string }>
    remote = new Map()
    for (const item of arr) {
      remote.set(item.hash, { adName: item.adName ?? 'remote', source: 'remote' })
    }
    remoteLoadedAt = Date.now()
  } catch {
    if (!remote) remote = new Map()
  }
}

// ---------- 对外 API ----------

export async function initFingerprint(remoteUrl?: string): Promise<{ learned: number; remote: number }> {
  await loadLearned()
  await loadRemote(remoteUrl ?? '')
  return {
    learned: learned?.size ?? 0,
    remote: remote?.size ?? 0,
  }
}

export async function clearLearned(): Promise<void> {
  learned = new Map()
  await persistLearned()
}

export function clearUrlCache(): void {
  urlCache.clear()
}

/**
 * 计算分片首帧指纹（SHA-256）
 *
 * 用 HTTP Range: bytes=0-65535 只取首 64KB
 * 服务器不支持 Range 则全量取后切片
 *
 * @param url 分片 URL（.ts / .m4s / 任何分片格式均可，协议无关）
 * @param authHeaders 可选认证头
 */
export async function computeFingerprint(url: string, authHeaders?: Record<string, string>): Promise<string | null> {
  if (urlCache.has(url)) return urlCache.get(url) ?? null

  const MAX_RETRIES = 2
  const RETRY_BASE_MS = 300
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const headers: Record<string, string> = { Range: `bytes=0-${PREFIX_BYTES - 1}` }
      if (authHeaders) {
        for (const [name, value] of Object.entries(authHeaders)) {
          headers[name] = value
        }
      }
      const res = await fetch(url, {
        headers,
        cache: 'no-store',
      })
      if (!res.ok) {
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_BASE_MS * attempt))
          continue
        }
        setUrlCache(url, null)
        return null
      }
      const buf = await res.arrayBuffer()
      const bytes = new Uint8Array(buf).slice(0, PREFIX_BYTES)
      const hashBuf = await crypto.subtle.digest('SHA-256', bytes)
      const hashHex = Array.from(new Uint8Array(hashBuf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
      setUrlCache(url, hashHex)
      return hashHex
    } catch {
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * attempt))
        continue
      }
      setUrlCache(url, null)
      return null
    }
  }
  setUrlCache(url, null)
  return null
}

/** 查询指纹是否为已知广告 */
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

/**
 * 入库指纹（auto-learn）
 *
 * 已存在则跳过（保留首次入库时间），超过 MAX_LEARNED 按 firstSeen 淘汰旧的
 */
export async function learnFingerprint(
  hash: string,
  meta: { adName: string; source: string },
): Promise<boolean> {
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

export async function listLearnedFingerprints(): Promise<Array<{ hash: string; adName: string; source: string; firstSeen: number }>> {
  await loadLearned()
  if (!learned) return []
  return Array.from(learned.entries()).map(([hash, meta]) => ({
    hash,
    adName: meta.adName,
    source: meta.source,
    firstSeen: meta.firstSeen,
  }))
}

export async function removeLearnedFingerprint(hash: string): Promise<boolean> {
  await loadLearned()
  if (!learned || !learned.has(hash)) return false
  learned.delete(hash)
  await persistLearned()
  return true
}