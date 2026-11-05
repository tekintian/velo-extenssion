/**
 * 广告样本保存 — 移植自 NDM samples.js
 *
 * 业务场景：用户观看视频时看到强插的 ts 广告，点击"保存样本"按钮，
 *   扩展捕获当前播放位置前后 N 片 + 元数据，存档供后续分析；
 *   并可选 auto-learn：把疑似广告分片指纹入库，下次自动抓。
 *
 * 数据结构 (chrome.storage.local.hlsAdSamples, 上限 100):
 *   { id, ts, pageHost, baseUrl, currentTime, appliedRule,
 *     window: [{index, url, duration, discontinuity, seqNum, isCurrent, signals}],
 *     note }
 */

import { persistentStorage } from '@/lib/storage'
import type { Segment } from './types'
import { computeFingerprint, learnFingerprint } from './fingerprint'

const KEY = 'hlsAdSamples'
const MAX = 100
const DEFAULT_WINDOW = 3

export interface SampleSegment {
  readonly index: number
  readonly url: string
  readonly duration: number
  readonly discontinuity: boolean
  readonly seqNum: number | null
  readonly isCurrent: boolean
  readonly signals: readonly string[]
}

export interface AdSample {
  readonly id: string
  readonly ts: number
  readonly pageHost: string
  readonly baseUrl: string
  readonly currentTime: number
  readonly currentSegIndex: number
  readonly appliedRule: { id: string; name: string } | null
  readonly report: { ads: number; total: number; adDuration: number } | null
  readonly window: SampleSegment[]
  note: string
}

/**
 * 读取指定分片索引的命中理由
 *
 * `reasons` 在工程内存在两种序列化形态：
 *   - Record<number, string[]> —— processPlaylist 直接产出、持久化时原样落盘
 *   - Array<{ index, reasons }> —— 经过 testM3u8 / 消息 JSON 序列化后的形态
 * 这里统一归一化，避免样本 signals 因形态差异静默丢失。
 */
function readSignals(reasons: SampleReasons | undefined, index: number): string[] {
  if (!reasons) return []
  if (Array.isArray(reasons)) {
    const hit = (reasons as ReadonlyArray<{ index: number; reasons: string[] }>).find((r) => r?.index === index)
    return Array.isArray(hit?.reasons) ? hit.reasons : []
  }
  return (reasons as Record<number, string[]>)[index] ?? []
}

/** 分片命中理由的两种可能形态 */
type SampleReasons =
  | Record<number, string[]>
  | ReadonlyArray<{ index: number; reasons: string[] }>

/**
 * 在 segments 里找 currentTime 对应的分片索引
 */
export function findSegIndexAtTime(segments: readonly Segment[], currentTime: number): number {
  if (!segments || segments.length === 0) return -1
  let t = 0
  for (let i = 0; i < segments.length; i++) {
    const dur = segments[i]!.duration || 0
    if (currentTime < t + dur) return i
    t += dur
  }
  return segments.length - 1
}

/**
 * 捕获样本（纯函数，不碰 storage）
 *
 * @param segments     parsePlaylist 解析出的分片数组
 * @param currentTime  当前播放时间（秒）
 * @param pageHost     页面 host
 * @param baseUrl      m3u8 URL
 * @param report       AdFilter report（含 appliedRule）
 * @param reasons      AdFilter reasons（分片索引→命中理由，支持 Record 与数组两种形态）
 * @param N            前后窗口大小，默认 3
 */
export function captureSample(
  segments: readonly Segment[],
  currentTime: number,
  pageHost: string,
  baseUrl: string,
  report: { ads: number; total: number; adDuration: number; appliedRule?: { id: string; name: string } | null } | null,
  reasons: SampleReasons | undefined,
  N = DEFAULT_WINDOW,
): AdSample | null {
  const cur = findSegIndexAtTime(segments, currentTime)
  if (cur < 0) return null
  const start = Math.max(0, cur - N)
  const end = Math.min(segments.length - 1, cur + N)
  const win: SampleSegment[] = []
  for (let i = start; i <= end; i++) {
    const s = segments[i]!
    win.push({
      index: s.index,
      url: s.url,
      duration: s.duration,
      discontinuity: s.discontinuity,
      seqNum: s.seqNum,
      isCurrent: i === cur,
      signals: readSignals(reasons, s.index),
    })
  }
  return {
    id: `sample-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    ts: Date.now(),
    pageHost: pageHost || '',
    baseUrl: baseUrl || '',
    currentTime,
    currentSegIndex: cur,
    appliedRule: report?.appliedRule ?? null,
    report: report ? { ads: report.ads, total: report.total, adDuration: report.adDuration } : null,
    window: win,
    note: '',
  }
}

/**
 * 记录样本
 */
export async function recordSample(sample: AdSample): Promise<boolean> {
  if (!sample) return false
  const list = (await persistentStorage.get<AdSample[]>(KEY)) ?? []
  list.unshift(sample)
  if (list.length > MAX) list.length = MAX
  await persistentStorage.set(KEY, list)
  return true
}

/**
 * 列出所有样本
 */
export async function listSamples(): Promise<AdSample[]> {
  return (await persistentStorage.get<AdSample[]>(KEY)) ?? []
}

/**
 * 清空样本
 */
export async function clearSamples(): Promise<void> {
  await persistentStorage.set(KEY, [])
}

/**
 * 删除单个样本
 */
export async function removeSample(id: string): Promise<boolean> {
  const list = await listSamples()
  const filtered = list.filter((s) => s.id !== id)
  if (filtered.length === list.length) return false
  await persistentStorage.set(KEY, filtered)
  return true
}

/**
 * 设置样本备注
 */
export async function setSampleNote(id: string, note: string): Promise<boolean> {
  const list = await listSamples()
  const s = list.find((x) => x.id === id)
  if (!s) return false
  s.note = note
  await persistentStorage.set(KEY, list)
  return true
}

/**
 * 样本数量
 */
export async function getSampleCount(): Promise<number> {
  const list = await listSamples()
  return list.length
}

/**
 * auto-learn：把样本里"当前片所在 discontinuity 块"的全部分片指纹入库
 *
 * 算法（移植自 NDM samples.js autoLearnFromSample）:
 *   1. 找当前片
 *   2. 扩展当前片所在的 discontinuity 块：往前到 disc 边界（含），往后到下一个 disc（不含）
 *   3. 对块内每片算指纹 + learnFingerprint
 *
 * @returns 新入库的指纹数
 */
export async function autoLearnFromSample(sample: AdSample): Promise<number> {
  if (!sample || !sample.window) return 0

  const curIdx = sample.window.findIndex((w) => w.isCurrent)
  if (curIdx < 0) return 0

  // 扩展当前片所在的 discontinuity 块
  let blockStart = curIdx
  if (!sample.window[curIdx]!.discontinuity) {
    for (let i = curIdx - 1; i >= 0; i--) {
      if (sample.window[i]!.discontinuity) {
        blockStart = i
        break
      }
    }
  }
  let blockEnd = curIdx
  for (let i = curIdx + 1; i < sample.window.length; i++) {
    if (sample.window[i]!.discontinuity) break
    blockEnd = i
  }

  let learned = 0
  for (let j = blockStart; j <= blockEnd; j++) {
    const w = sample.window[j]!
    try {
      const hash = await computeFingerprint(w.url)
      if (hash) {
        const added = await learnFingerprint(hash, {
          adName: `user-sample:${sample.pageHost || '?'}`,
          source: 'user-marked',
        })
        if (added) learned++
      }
    } catch {
      // ignore
    }
  }
  return learned
}