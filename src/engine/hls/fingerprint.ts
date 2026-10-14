/**
 * TS 分片首帧哈希指纹库
 *
 * 移植自 NDM fingerprint.js
 * 用 Web Crypto API（crypto.subtle.digest）替代 Node crypto
 *
 * 三层数据源:
 *   1) learned  chrome.storage.local.hlsFingerprintsLearned  自学习入库（auto-learn）
 *   2) remote   用户配置的 remoteFingerprintsUrl 指定的 JSON
 *   3) builtin  预置（当前为空，可扩充）
 *
 * 性能策略:
 *   - computeFingerprint 用 HTTP Range: bytes=0-65535 只取首 64KB
 *   - 结果按 URL 缓存到内存 Map（本次 SW 生命周期内不重复请求）
 *   - lookup 是同步哈希表查找，O(1)
 */

import { persistentStorage } from '@/lib/storage'
import type { FingerprintLookupResult } from './types'

const PREFIX_BYTES = 65536 // 取前 64KB
const MAX_LEARNED = 5000 // learned 库上限，超过按 firstSeen 淘汰旧的
const LEARNED_KEY = 'hlsFingerprintsLearned'
const REMOTE_TTL = 6 * 60 * 60 * 1000 // 远程库 6 小时刷新一次

// P3-3: urlCache 加 LRU 上限，避免长生命周期 SW 累积内存
// 每个 entry ~100 字节（url + hash），1000 条 ≈ 100KB，安全上限
const URL_CACHE_MAX = 1000

const urlCache = new Map<string, string | null>() // url → hash|null（内存，本次 SW 生命周期）
let learned: Map<string, { adName: string; source: string; firstSeen: number }> | null = null
let remote: Map<string, { adName: string; source: string }> | null = null
let remoteLoadedAt = 0

/**
 * 写入 urlCache，超过上限时淘汰最早的条目（Map 保持插入顺序，delete+set 实现 LRU）
 */
function setUrlCache(url: string, value: string | null): void {
  if (urlCache.size >= URL_CACHE_MAX) {
    // 淘汰最早插入的 key（Map 迭代按插入顺序）
    const firstKey = urlCache.keys().next().value
    if (firstKey !== undefined) urlCache.delete(firstKey)
  }
  urlCache.set(url, value)
}

// ---------- learned 读写 ----------
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
    // 远程加载失败，保持空
    if (!remote) remote = new Map()
  }
}

// ---------- 对外 API ----------

/** 初始化（加载 learned + 远程库） */
export async function initFingerprint(remoteUrl?: string): Promise<{ learned: number; remote: number }> {
  await loadLearned()
  await loadRemote(remoteUrl ?? '')
  return {
    learned: learned?.size ?? 0,
    remote: remote?.size ?? 0,
  }
}

/** 清空 learned 库 */
export async function clearLearned(): Promise<void> {
  learned = new Map()
  await persistLearned()
}

/** 清空 URL 缓存 */
export function clearUrlCache(): void {
  urlCache.clear()
}

/**
 * 计算分片首帧指纹（SHA-256）
 *
 * 用 HTTP Range: bytes=0-65535 只取首 64KB
 * 服务器不支持 Range 则全量取后切片
 *
 * @param url       分片 URL
 * @param authHeaders 可选认证头（Cookie/User-Agent 等），由调用方从嗅探器 mediaItem.requestHeaders 传入
 */
export async function computeFingerprint(url: string, authHeaders?: Record<string, string>): Promise<string | null> {
  if (urlCache.has(url)) return urlCache.get(url) ?? null

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
    setUrlCache(url, null)
    return null
  }
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
 *
 * @returns 是否新增
 */
export async function learnFingerprint(
  hash: string,
  meta: { adName: string; source: string },
): Promise<boolean> {
  await loadLearned()
  if (!learned) learned = new Map()
  if (learned.has(hash)) return false

  learned.set(hash, { ...meta, firstSeen: Date.now() })

  // 淘汰：按 firstSeen 升序，超过上限删最早的
  if (learned.size > MAX_LEARNED) {
    const entries = Array.from(learned.entries()).sort((a, b) => a[1].firstSeen - b[1].firstSeen)
    const toRemove = entries.slice(0, entries.length - MAX_LEARNED)
    for (const [k] of toRemove) learned.delete(k)
  }

  await persistLearned()
  return true
}

/** learned 库当前条数 */
export function getLearnedCount(): number {
  return learned?.size ?? 0
}
