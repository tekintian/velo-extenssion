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
import { computeFingerprint, learnFingerprint, USER_MARKED_SOURCE } from './fingerprint'

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
  /**
   * 当前片所属的完整 discontinuity 块
   *
   * 历史样本无此字段：窗口只覆盖 currentSegIndex ± N，若广告块长度超过窗口，
   * auto-learn 会把块边界截断在窗口外，学到不完整的广告指纹集合。
   * 新样本直接存完整块，auto-learn 优先使用它。
   */
  readonly block?: SampleSegment[]
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
 * 计算某个分片所属的完整 discontinuity 块
 *
 * 块定义：从当前片往前找到最近的 discontinuity 分片（含），
 * 往后直到下一个 discontinuity 分片之前（不含）。
 * 当前片自身带 discontinuity 时，它就是块起点。
 *
 * @returns 块内分片的闭区间 [start, end]；segments 为空时返回 null
 */
export function computeDiscontinuityBlock(
  segments: readonly { discontinuity: boolean }[],
  index: number,
): { start: number; end: number } | null {
  if (!segments || segments.length === 0) return null
  if (index < 0 || index >= segments.length) return null

  let start = index
  for (let i = index - 1; i >= 0; i--) {
    if (segments[i]!.discontinuity) {
      start = i
      break
    }
    start = i
  }
  let end = index
  for (let i = index + 1; i < segments.length; i++) {
    if (segments[i]!.discontinuity) break
    end = i
  }
  return { start, end }
}

function toSampleSegment(
  segments: readonly Segment[],
  i: number,
  cur: number,
  reasons: SampleReasons | undefined,
): SampleSegment {
  const s = segments[i]!
  return {
    index: s.index,
    url: s.url,
    duration: s.duration,
    discontinuity: s.discontinuity,
    seqNum: s.seqNum,
    isCurrent: i === cur,
    signals: readSignals(reasons, s.index),
  }
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
    win.push(toSampleSegment(segments, i, cur, reasons))
  }

  // 完整 discontinuity 块：脱离窗口限制，供 auto-learn 学全广告块
  const blk = computeDiscontinuityBlock(segments, cur)
  const block: SampleSegment[] = []
  if (blk) {
    for (let i = blk.start; i <= blk.end; i++) {
      block.push(toSampleSegment(segments, i, cur, reasons))
    }
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
    ...(block.length > 0 ? { block } : {}),
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
 * auto-learn 结果
 *
 * `total` 为块内成功算出指纹的分片总数，`added` 为本次新入库数。
 * 两者不等通常意味着这些分片已被检测阶段自动入库（fingerprint-match 后重复学习），
 * 显式暴露给 UI，避免用户误以为「保存了样本但自学习没生效」。
 */
export interface AutoLearnResult {
  readonly added: number
  readonly total: number
}

/**
 * auto-learn：把样本里"当前片所在 discontinuity 块"的全部分片指纹入库
 *
 * 算法（移植自 NDM samples.js autoLearnFromSample）:
 *   1. 定位当前片所属的完整 discontinuity 块
 *      - 优先用 sample.block（捕获时已按全量 segments 计算，不受窗口截断）
 *      - 历史样本无 block 时回退：在 window 内扩展，边界可能被截断
 *   2. 对块内每片算指纹 + learnFingerprint(source='user-marked')
 *
 * user-marked 指纹独立于 enableFingerprint 开关参与匹配（见 hls-filter），
 * 保证用户主动标注的广告后续必然被识别。
 */
export async function autoLearnFromSample(sample: AdSample): Promise<AutoLearnResult> {
  if (!sample) return { added: 0, total: 0 }

  let block: readonly SampleSegment[]
  if (sample.block && sample.block.length > 0) {
    block = sample.block
  } else if (sample.window && sample.window.length > 0) {
    // 历史样本回退路径：窗口内扩展
    const curIdx = sample.window.findIndex((w) => w.isCurrent)
    if (curIdx < 0) return { added: 0, total: 0 }
    const blk = computeDiscontinuityBlock(sample.window, curIdx)
    if (!blk) return { added: 0, total: 0 }
    block = sample.window.slice(blk.start, blk.end + 1)
  } else {
    return { added: 0, total: 0 }
  }

  let added = 0
  let total = 0
  for (const w of block) {
    try {
      const hash = await computeFingerprint(w.url)
      if (!hash) continue
      total++
      const isNew = await learnFingerprint(hash, {
        adName: `user-sample:${sample.pageHost || '?'}`,
        source: USER_MARKED_SOURCE,
      })
      if (isNew) added++
    } catch {
      // ignore
    }
  }
  return { added, total }
}