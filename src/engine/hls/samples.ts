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
import {
  computeFingerprint,
  learnFingerprint,
  lookupUserMarkedFingerprint,
  removeLearnedFingerprint,
  USER_MARKED_SOURCE,
} from './fingerprint'

const KEY = 'hlsAdSamples'
const MAX = 100
const DEFAULT_WINDOW = 3

/** 分片判定：ad=广告 content=内容 unknown=待确认 */
export type SegmentVerdict = 'ad' | 'content' | 'unknown'

export interface SampleSegment {
  readonly index: number
  readonly url: string
  readonly duration: number
  readonly discontinuity: boolean
  readonly seqNum: number | null
  readonly isCurrent: boolean
  readonly signals: readonly string[]
  /**
   * 分片判定
   *
   * signals 只表示"命中理由"，不等于"被判为广告"：无理由的分片同样可能是广告，
   * 需人工确认。历史样本无此字段时按 deriveVerdict 推导，保持向后兼容。
   */
  readonly verdict?: SegmentVerdict
}

/** 由 signals 推导初始判定（历史样本兼容 + 捕获时赋初值） */
export function deriveVerdict(signals: readonly string[] | undefined): SegmentVerdict {
  return signals && signals.length > 0 ? 'ad' : 'unknown'
}

/** 读取分片判定，无 verdict 字段时按 signals 推导 */
export function resolveVerdict(seg: SampleSegment): SegmentVerdict {
  return seg.verdict ?? deriveVerdict(seg.signals)
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
  /**
   * 人工复核记录
   *
   * keep  = 用户确认属于广告的分片 index
   * reject = 用户确认为非广告的分片 index
   * 仅在保存时确认卡中产生；未复核的样本无此字段。
   */
  readonly review?: { at: number; keep: readonly number[]; reject: readonly number[] }
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
  const signals = readSignals(reasons, s.index)
  return {
    index: s.index,
    url: s.url,
    duration: s.duration,
    discontinuity: s.discontinuity,
    seqNum: s.seqNum,
    isCurrent: i === cur,
    signals,
    verdict: deriveVerdict(signals),
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
 *
 * 同时撤销这些样本学到的 user-marked 指纹：样本是自学习的唯一凭据，
 * 样本删除后指纹若留在库里就变成无主数据，用户再也无法通过删样本来回滚误判。
 * 返回被撤销的指纹数量。
 *
 * @param revoke 是否连带撤销指纹。备份导入（replace）场景必须传 false：
 *   导入包自带 learnedFingerprints 且先于样本写入，此时撤销会把刚导入的指纹抹掉。
 */
export async function clearSamples(revoke = true): Promise<number> {
  const list = await listSamples()
  let revoked = 0
  if (revoke) {
    for (const s of list) {
      revoked += await revokeSampleFingerprints(s)
    }
  }
  await persistentStorage.set(KEY, [])
  return revoked
}

/**
 * 删除单个样本
 *
 * 与 clearSamples 一致：删除样本必须连带撤销其 fingerprint，
 * 否则「删样本」这个操作对屏蔽效果毫无影响，误标会永久生效。
 * 成功删除时返回被撤销的指纹数量，样本不存在时返回 null。
 */
export async function removeSample(id: string): Promise<number | null> {
  const list = await listSamples()
  const target = list.find((s) => s.id === id)
  if (!target) return null
  const revoked = await revokeSampleFingerprints(target)
  const filtered = list.filter((s) => s.id !== id)
  await persistentStorage.set(KEY, filtered)
  return revoked
}

/** 撤销单个样本全部分片的 user-marked 指纹，返回撤销数量 */
async function revokeSampleFingerprints(sample: AdSample): Promise<number> {
  let revoked = 0
  for (const seg of resolveSampleBlock(sample)) {
    if (await revokeFingerprint(seg.url)) revoked++
  }
  return revoked
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
 * 仅排除用户复核时明确判为 'content' 的分片：
 *   - 'ad'      规则命中，学
 *   - 'unknown' 规则未命中，但用户主动保存样本即代表"这里像广告"，仍学
 *   - 'content' 用户明确确认为正常内容，绝不入库
 * 若把 unknown 也排除，会导致规则漏检的广告永远学不到指纹，
 * 而这类漏检恰恰是最需要自学习补上的场景。
 *
 * user-marked 指纹独立于 enableFingerprint 开关参与匹配（见 hls-filter），
 * 保证用户主动标注的广告后续必然被识别。
 */
export async function autoLearnFromSample(sample: AdSample): Promise<AutoLearnResult> {
  if (!sample) return { added: 0, total: 0 }

  const block = resolveSampleBlock(sample)
  if (block.length === 0) return { added: 0, total: 0 }

  let added = 0
  let total = 0
  for (const w of block) {
    if (resolveVerdict(w) === 'content') continue
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

/**
 * 解析样本的可学习分片块
 *
 * 导出供预览器复用：浮层展示的清单必须与 auto-learn 学习的集合完全一致，
 * 否则用户确认的内容与实际入库内容不一致。
 */
export function resolveSampleBlock(sample: AdSample): readonly SampleSegment[] {
  if (sample.block && sample.block.length > 0) return sample.block
  if (sample.window && sample.window.length > 0) {
    const curIdx = sample.window.findIndex((w) => w.isCurrent)
    if (curIdx < 0) return []
    const blk = computeDiscontinuityBlock(sample.window, curIdx)
    if (!blk) return []
    return sample.window.slice(blk.start, blk.end + 1)
  }
  return []
}

/**
 * 校验分片判定入参是否合法
 *
 * 只在 ad / content 两态间切换：unknown 是初始态而非用户可选动作，
 * 避免改判接口被用来把已确认分片回退成未确认。
 */
export function isValidVerdict(v: unknown): v is 'ad' | 'content' {
  return v === 'ad' || v === 'content'
}

/**
 * 应用用户改判，返回不可变的新样本
 *
 * 同时维护 window / block 两个集合中的同索引分片（二者在块内重叠），
 * 保证 UI 展示与 auto-learn 读到的判定一致；并重建 review 记录。
 *
 * 不触碰存储，由调用方决定是否落库——草稿阶段改判不落库。
 */
export function applyVerdict(sample: AdSample, segIndex: number, verdict: 'ad' | 'content'): AdSample {
  const patch = (list: readonly SampleSegment[]): SampleSegment[] =>
    list.map((s) => (s.index === segIndex ? { ...s, verdict } : s))

  const window2 = patch(sample.window)
  const block2 = sample.block ? patch(sample.block) : undefined

  const reviewed = resolveSampleBlock({ ...sample, window: window2, ...(block2 ? { block: block2 } : {}) })
  const keep: number[] = []
  const reject: number[] = []
  for (const s of reviewed) {
    const v = resolveVerdict(s)
    if (v === 'ad') keep.push(s.index)
    else if (v === 'content') reject.push(s.index)
  }

  return {
    ...sample,
    window: window2,
    ...(block2 ? { block: block2 } : {}),
    review: { at: Date.now(), keep, reject },
  }
}

/**
 * 用完整块替换样本的分片清单
 *
 * 「载入完整广告块」：把样本的可学习范围从当前窗口扩展到整块，
 * 供用户在确认卡里看到完整广告块的全部分片，而无须拖动播放器。
 *
 * 合并时保留样本中已有的判定：用户在点「载入完整块」之前做过的改判
 * 不能被完整块的初始 verdict 覆盖，否则确认卡会出现"改判后又变回去"。
 */
export function applyFullBlock(sample: AdSample, fullBlock: readonly SampleSegment[]): AdSample {
  if (fullBlock.length === 0) return sample
  // 已存在的判定：window 与 block 中凡被用户改判过的都以 'ad' / 'content' 落地，
  // 'unknown' 是初始态，不应阻止完整块里规则命中带来的 'ad'
  const existing = new Map<number, 'ad' | 'content'>()
  for (const s of [...sample.window, ...(sample.block ?? [])]) {
    const v = resolveVerdict(s)
    if (v !== 'unknown') existing.set(s.index, v)
  }
  const filled = fullBlock.map((s) => {
    const v = existing.get(s.index)
    return v ? { ...s, verdict: v } : s
  })
  const covered = new Set(filled.map((s) => s.index))
  const extra = sample.window.filter((s) => !covered.has(s.index))
  const merged = [...filled, ...extra].sort((a, b) => a.index - b.index)
  return { ...sample, block: [...filled], window: merged }
}

/**
 * 撤销指定分片的 user-marked 指纹
 *
 * 用户复核判定某分片为非广告时调用：若该分片曾被误学入指纹库，
 * 必须同步移除，否则下次播放会把正常内容当作广告跳掉。
 */
export async function revokeFingerprint(url: string): Promise<boolean> {
  try {
    const hash = await computeFingerprint(url)
    if (!hash) return false
    const hit = await lookupUserMarkedFingerprint(hash)
    if (!hit) return false
    return await removeLearnedFingerprint(hash)
  } catch {
    return false
  }
}