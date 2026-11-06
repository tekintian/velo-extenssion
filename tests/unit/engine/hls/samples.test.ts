/**
 * samples.ts 样本捕获测试
 *
 * 覆盖本次修复的核心逻辑：
 *   ① reasons 两种形态（Record / Array<{index,reasons}>）都能还原 signals
 *      —— 原实现只支持 Record，数组形态下 signals 会静默丢失，
 *         导致 autoLearnFromSample 学不到任何指纹
 *   ② 窗口边界：开头 / 末尾 / 中间位置的 currentTime 映射与窗口裁剪
 *   ③ 找不到分片时返回 null（由上层翻译成 sample-out-of-range）
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/storage', () => ({
  persistentStorage: {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/engine/hls/fingerprint', () => ({
  computeFingerprint: vi.fn(async () => null),
  learnFingerprint: vi.fn(async () => false),
  lookupUserMarkedFingerprint: vi.fn(async () => null),
  removeLearnedFingerprint: vi.fn(async () => false),
  USER_MARKED_SOURCE: 'user-marked',
}))

import type { Mock } from 'vitest'
import { persistentStorage } from '@/lib/storage'
import {
  applyFullBlock,
  applyVerdict,
  autoLearnFromSample,
  captureSample,
  clearSamples,
  computeDiscontinuityBlock,
  deriveVerdict,
  findSegIndexAtTime,
  isValidVerdict,
  removeSample,
  resolveSampleBlock,
  resolveVerdict,
  revokeFingerprint,
} from '@/engine/hls/samples'
import {
  computeFingerprint,
  learnFingerprint,
  lookupUserMarkedFingerprint,
  removeLearnedFingerprint,
} from '@/engine/hls/fingerprint'
import type { Segment } from '@/engine/hls/types'

const mockCompute = computeFingerprint as unknown as Mock
const mockLearn = learnFingerprint as unknown as Mock
const mockLookupUser = lookupUserMarkedFingerprint as unknown as Mock
const mockRemoveLearned = removeLearnedFingerprint as unknown as Mock
const mockStorageGet = persistentStorage.get as unknown as Mock
const mockStorageSet = persistentStorage.set as unknown as Mock

function makeSegment(index: number, duration = 4): Segment {
  return {
    index,
    url: `https://cdn.example.com/seg-${index}.ts`,
    duration,
    title: '',
    byterange: null,
    discontinuity: false,
    cueState: null,
    scte35: null,
    dateRangeAd: null,
    seqNum: index,
  }
}

const SEGMENTS: Segment[] = [0, 1, 2, 3, 4, 5].map((i) => makeSegment(i))

const REPORT = { ads: 2, total: 6, adDuration: 8, appliedRule: { id: 'rule-1', name: '测试规则' } }

describe('findSegIndexAtTime', () => {
  it('空分片列表返回 -1', () => {
    expect(findSegIndexAtTime([], 10)).toBe(-1)
  })

  it('按累计时长定位分片', () => {
    // 每片 4s：0-4→0, 4-8→1, 8-12→2
    expect(findSegIndexAtTime(SEGMENTS, 0)).toBe(0)
    expect(findSegIndexAtTime(SEGMENTS, 3.9)).toBe(0)
    expect(findSegIndexAtTime(SEGMENTS, 4)).toBe(1)
    expect(findSegIndexAtTime(SEGMENTS, 9)).toBe(2)
  })

  it('超出总时长回落到最后一片', () => {
    expect(findSegIndexAtTime(SEGMENTS, 1000)).toBe(SEGMENTS.length - 1)
  })
})

describe('captureSample — reasons 形态兼容', () => {
  it('Record 形态正确还原 signals', () => {
    const sample = captureSample(
      SEGMENTS,
      10,
      'example.com',
      'https://cdn.example.com/index.m3u8',
      REPORT,
      { 2: ['ad-block'], 3: ['ad-block', 'path-pattern'] },
    )
    expect(sample).not.toBeNull()
    const seg2 = sample!.window.find((w) => w.index === 2)
    const seg3 = sample!.window.find((w) => w.index === 3)
    expect(seg2?.signals).toEqual(['ad-block'])
    expect(seg3?.signals).toEqual(['ad-block', 'path-pattern'])
  })

  it('Array 形态正确还原 signals（本次修复点）', () => {
    const sample = captureSample(
      SEGMENTS,
      10,
      'example.com',
      'https://cdn.example.com/index.m3u8',
      REPORT,
      [
        { index: 2, reasons: ['ad-block'] },
        { index: 3, reasons: ['ad-block', 'path-pattern'] },
      ],
    )
    expect(sample).not.toBeNull()
    const seg2 = sample!.window.find((w) => w.index === 2)
    const seg3 = sample!.window.find((w) => w.index === 3)
    expect(seg2?.signals).toEqual(['ad-block'])
    expect(seg3?.signals).toEqual(['ad-block', 'path-pattern'])
  })

  it('无 reasons 时 signals 为空数组而非 undefined', () => {
    const sample = captureSample(SEGMENTS, 10, 'example.com', 'https://cdn.example.com/i.m3u8', REPORT, undefined)
    expect(sample!.window.every((w) => Array.isArray(w.signals))).toBe(true)
    expect(sample!.window.every((w) => w.signals.length === 0)).toBe(true)
  })
})

describe('captureSample — 窗口边界', () => {
  it('纪录片头时窗口从 0 开始且不越界', () => {
    const sample = captureSample(SEGMENTS, 0, 'h', 'u', REPORT, undefined, 3)
    expect(sample!.currentSegIndex).toBe(0)
    expect(sample!.window[0]!.index).toBe(0)
    expect(sample!.window.length).toBe(4)
  })

  it('片中时前后各取 N 片', () => {
    const sample = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, undefined, 3)
    expect(sample!.currentSegIndex).toBe(2)
    expect(sample!.window.map((w) => w.index)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('片尾时窗口不越过末尾', () => {
    const sample = captureSample(SEGMENTS, 1000, 'h', 'u', REPORT, undefined, 3)
    expect(sample!.currentSegIndex).toBe(5)
    expect(sample!.window[sample!.window.length - 1]!.index).toBe(5)
  })

  it('恰好一个窗口被标记为 isCurrent', () => {
    const sample = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, undefined, 3)
    const flags = sample!.window.filter((w) => w.isCurrent)
    expect(flags.length).toBe(1)
    expect(flags[0]!.index).toBe(2)
  })

  it('空分片列表返回 null', () => {
    expect(captureSample([], 10, 'h', 'u', REPORT, undefined)).toBeNull()
  })
})

describe('captureSample — 元数据', () => {
  it('透传 report 与 appliedRule', () => {
    const sample = captureSample(SEGMENTS, 10, 'example.com', 'https://cdn/i.m3u8', REPORT, undefined)
    expect(sample!.report).toEqual({ ads: 2, total: 6, adDuration: 8 })
    expect(sample!.appliedRule).toEqual({ id: 'rule-1', name: '测试规则' })
    expect(sample!.pageHost).toBe('example.com')
    expect(sample!.baseUrl).toBe('https://cdn/i.m3u8')
  })

  it('report 为 null 时样本 report 也为 null', () => {
    const sample = captureSample(SEGMENTS, 10, 'h', 'u', null, undefined)
    expect(sample!.report).toBeNull()
    expect(sample!.appliedRule).toBeNull()
  })

  it('pageHost 为空时归一化为空字符串', () => {
    const sample = captureSample(SEGMENTS, 10, '', '', REPORT, undefined)
    expect(sample!.pageHost).toBe('')
    expect(sample!.baseUrl).toBe('')
  })
})

describe('computeDiscontinuityBlock', () => {
  function disc(i: number): Segment {
    const s = makeSegment(i)
    return { ...s, discontinuity: true }
  }

  it('当前片自身带 discontinuity 时是块起点', () => {
    const segs = [makeSegment(0), disc(1), makeSegment(2), makeSegment(3)]
    expect(computeDiscontinuityBlock(segs, 2)).toEqual({ start: 1, end: 3 })
  })

  it('向后到下一个 discontinuity 之前结束', () => {
    const segs = [disc(0), makeSegment(1), makeSegment(2), disc(3)]
    expect(computeDiscontinuityBlock(segs, 1)).toEqual({ start: 0, end: 2 })
  })

  it('无任何 discontinuity 标记时向前回到数组开头，向后到数组末尾', () => {
    const segs = [makeSegment(0), makeSegment(1), makeSegment(2)]
    // 从 index 1 向前找不到 discontinuity → start 退回 0；向后无 discontinuation → end=2
    expect(computeDiscontinuityBlock(segs, 1)).toEqual({ start: 0, end: 2 })
  })

  it('索引越界或空列表返回 null', () => {
    expect(computeDiscontinuityBlock([], 0)).toBeNull()
    expect(computeDiscontinuityBlock(SEGMENTS, -1)).toBeNull()
    expect(computeDiscontinuityBlock(SEGMENTS, 99)).toBeNull()
  })
})

describe('captureSample — block 完整广告块', () => {
  function disc(i: number): Segment {
    const s = makeSegment(i)
    return { ...s, discontinuity: true }
  }

  it('广告块超过窗口时 block 覆盖完整块，window 仅覆盖局部（本次修复点）', () => {
    // 块：index 1..10 共 10 片（1 是 discontinuity 起点，11 是下个块起点）
    // N=1 时 currentSegIndex=6，窗口只有 [5,6,7]；block 必须完整覆盖 1..10
    const segs = [
      makeSegment(0),
      disc(1),
      ...Array.from({ length: 9 }, (_, k) => makeSegment(2 + k)),
      disc(11),
      makeSegment(12),
    ]
    const sample = captureSample(segs, 25, 'h', 'u', REPORT, undefined, 1)
    expect(sample!.currentSegIndex).toBe(6)
    expect(sample!.window.map((w) => w.index)).toEqual([5, 6, 7])
    expect(sample!.block!.map((b) => b.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('block 内含当前片标记且仅一个 isCurrent', () => {
    const segs = [makeSegment(0), disc(1), makeSegment(2), makeSegment(3), disc(4), makeSegment(5)]
    const sample = captureSample(segs, 9, 'h', 'u', REPORT, undefined, 1)
    expect(sample!.block!.map((b) => b.index)).toEqual([1, 2, 3])
    expect(sample!.block!.filter((b) => b.isCurrent).length).toBe(1)
  })
})

describe('autoLearnFromSample — 学习统计', () => {
  it('优先使用 block，total 统计全部成功算出的指纹', async () => {
    const sample = captureSample(SEGMENTS, 10, 'example.com', 'u', REPORT, undefined, 1)
    mockCompute.mockImplementation(async (url: string) => `h-${url}`)
    mockLearn.mockResolvedValue(true)
    const r = await autoLearnFromSample(sample!)
    // block 覆盖 index 0..5（无 discontinuity 标记 → 整段一块），共 6 片
    expect(r.total).toBe(6)
    expect(r.added).toBe(6)
  })

  it('已存在的指纹会计入 total 但不计入 added', async () => {
    const sample = captureSample(SEGMENTS, 10, 'example.com', 'u', REPORT, undefined, 1)
    mockCompute.mockImplementation(async (url: string) => `h-${url}`)
    mockLearn.mockResolvedValue(false)
    const r = await autoLearnFromSample(sample!)
    expect(r.total).toBe(6)
    expect(r.added).toBe(0)
  })

  it('计算指纹返回 null 的分片不计入 total', async () => {
    const sample = captureSample(SEGMENTS, 10, 'example.com', 'u', REPORT, undefined, 1)
    mockCompute.mockResolvedValue(null)
    const r = await autoLearnFromSample(sample!)
    expect(r.total).toBe(0)
    expect(r.added).toBe(0)
  })

  it('历史样本无 block 时回退窗口路径（窗口内整段一块）', async () => {
    const sample = captureSample(SEGMENTS, 10, 'example.com', 'u', REPORT, undefined, 1)!
    const legacy = {
      id: sample.id,
      ts: sample.ts,
      pageHost: sample.pageHost,
      baseUrl: sample.baseUrl,
      currentTime: sample.currentTime,
      currentSegIndex: sample.currentSegIndex,
      appliedRule: sample.appliedRule,
      report: sample.report,
      window: sample.window,
      note: sample.note,
    }
    expect('block' in legacy).toBe(false)
    mockCompute.mockImplementation(async (url: string) => `h-${url}`)
    mockLearn.mockResolvedValue(true)
    const r = await autoLearnFromSample(legacy)
    // window 为 currentSegIndex(2) ± 1 → index 1..3，共 3 片
    expect(r.total).toBe(3)
  })

  it('无 window 无 block 时返回零值', async () => {
    const s = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, undefined)!
    const r = await autoLearnFromSample({ ...s, window: [], block: [] })
    expect(r).toEqual({ added: 0, total: 0 })
  })
})

describe('deriveVerdict / resolveVerdict', () => {
  it('有命中理由时为 ad，无理由时为 unknown', () => {
    expect(deriveVerdict(['ad-block'])).toBe('ad')
    expect(deriveVerdict([])).toBe('unknown')
    expect(deriveVerdict(undefined)).toBe('unknown')
  })

  it('resolveVerdict 优先读 verdict 字段，缺失时按 signals 推导', () => {
    const base = {
      index: 1,
      url: 'u',
      duration: 4,
      discontinuity: false,
      seqNum: 1,
      isCurrent: true,
    }
    expect(resolveVerdict({ ...base, signals: ['x'], verdict: 'content' })).toBe('content')
    expect(resolveVerdict({ ...base, signals: ['x'] })).toBe('ad')
    expect(resolveVerdict({ ...base, signals: [] })).toBe('unknown')
  })

  it('captureSample 为每个分片写入初始 verdict', () => {
    const s = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, { 2: ['ad-block'] })!
    const cur = s.window.find((w) => w.isCurrent)!
    expect(cur.verdict).toBe('ad')
    const other = s.window.find((w) => !w.isCurrent)!
    expect(other.verdict).toBe('unknown')
  })
})

describe('isValidVerdict', () => {
  it('只接受 ad / content', () => {
    expect(isValidVerdict('ad')).toBe(true)
    expect(isValidVerdict('content')).toBe(true)
    expect(isValidVerdict('unknown')).toBe(false)
    expect(isValidVerdict(null)).toBe(false)
  })
})

describe('applyVerdict — 人工改判', () => {
  it('改判后 window 与 block 中同索引分片同步更新', () => {
    const s = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, { 2: ['ad-block'] })!
    const next = applyVerdict(s, 2, 'content')
    expect(next.window.find((w) => w.index === 2)!.verdict).toBe('content')
    expect(next.block!.find((b) => b.index === 2)!.verdict).toBe('content')
  })

  it('改判生成 review.keep / reject 记录', () => {
    const s = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, { 2: ['ad-block'] })!
    const next = applyVerdict(s, 2, 'content')
    expect(next.review).toBeDefined()
    expect(next.review!.reject).toContain(2)
    expect(next.review!.keep).not.toContain(2)
  })

  it('不修改原样本（不可变）', () => {
    const s = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, { 2: ['ad-block'] })!
    const before = s.window.find((w) => w.index === 2)!.verdict
    applyVerdict(s, 2, 'content')
    expect(s.window.find((w) => w.index === 2)!.verdict).toBe(before)
  })
})

describe('applyFullBlock — 载入完整广告块', () => {
  it('用完整块替换并可学习范围扩大', () => {
    const s = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, { 2: ['ad-block'] }, 1)!
    const full = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, { 2: ['ad-block'] }, 99)!.window
    const next = applyFullBlock(s, full)
    expect(resolveSampleBlock(next).length).toBe(SEGMENTS.length)
  })

  it('空块原样返回', () => {
    const s = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, undefined)!
    expect(applyFullBlock(s, [])).toBe(s)
  })

  it('保留用户已做的改判，不被完整块初始判定覆盖', () => {
    const s = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, { 2: ['ad-block'] }, 1)!
    // 用户先把 #2 改判为非广告
    const judged = applyVerdict(s, 2, 'content')
    // 再载入完整块：完整块里 #2 初始为 'ad'，但用户改判必须优先
    const full = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, { 2: ['ad-block'] }, 99)!.window
    const next = applyFullBlock(judged, full)
    expect(resolveVerdict(next.block!.find((b) => b.index === 2)!)).toBe('content')
  })

  it('完整块中规则命中的 ad 不被 unknown 初始态抹掉', () => {
    const s = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, undefined, 1)!
    const full = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, { 4: ['ad-block'] }, 99)!.window
    const next = applyFullBlock(s, full)
    expect(resolveVerdict(next.block!.find((b) => b.index === 4)!)).toBe('ad')
  })
})

describe('autoLearnFromSample — 只学习判定为广告的分片', () => {
  // 全部分片 discontinuity=false 时 computeDiscontinuityBlock 把整段视为一块，
  // 因此 block 覆盖 SEGMENTS.length（6）片，改判 1 片后学习 5 片
  it('改判为 content 的分片不入库', async () => {
    const s = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, { 1: ['a'], 2: ['b'], 3: ['c'] }, 1)!
    mockCompute.mockImplementation(async (url: string) => `h-${url}`)
    mockLearn.mockResolvedValue(true)
    const next = applyVerdict(s, 2, 'content')
    const r = await autoLearnFromSample(next)
    expect(r.total).toBe(SEGMENTS.length - 1)
  })

  it('unknown 仍学习：规则漏检的广告是自学习的主要对象', async () => {
    const s = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, undefined, 1)!
    mockCompute.mockImplementation(async (url: string) => `h-${url}`)
    mockLearn.mockResolvedValue(true)
    const r = await autoLearnFromSample(s)
    expect(r.total).toBe(SEGMENTS.length)
  })

  it('全部改判为 content 时不学习', async () => {
    const s = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, undefined, 1)!
    let next = s
    for (const w of s.block ?? s.window) next = applyVerdict(next, w.index, 'content')
    mockCompute.mockImplementation(async (url: string) => `h-${url}`)
    mockLearn.mockResolvedValue(true)
    const r = await autoLearnFromSample(next)
    expect(r.total).toBe(0)
  })
})

describe('revokeFingerprint — 撤销误标指纹', () => {
  it('库中存在 user-marked 指纹时删除', async () => {
    mockCompute.mockResolvedValue('hash-1')
    mockLookupUser.mockResolvedValue({ hash: 'hash-1', adName: 'x', source: 'user-marked' })
    mockRemoveLearned.mockResolvedValue(true)
    expect(await revokeFingerprint('https://cdn.example.com/seg-1.ts')).toBe(true)
  })

  it('指纹不存在时不删除', async () => {
    mockCompute.mockResolvedValue('hash-2')
    mockLookupUser.mockResolvedValue(null)
    expect(await revokeFingerprint('https://cdn.example.com/seg-2.ts')).toBe(false)
  })

  it('算不出指纹时返回 false', async () => {
    mockCompute.mockResolvedValue(null)
    expect(await revokeFingerprint('https://cdn.example.com/x.ts')).toBe(false)
  })
})

describe('removeSample / clearSamples — 删除样本连带撤销指纹', () => {
  // 样本是自学习的唯一凭据：样本删除后指纹若留在库里就变成无主数据，
  // 「删样本」对屏蔽效果毫无影响，误标会永久生效
  it('removeSample 撤销该样本全部分片指纹并返回数量', async () => {
    const sample = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, undefined, 1)!
    mockStorageGet.mockResolvedValue([sample])
    mockCompute.mockImplementation(async (url: string) => `h-${url}`)
    mockLookupUser.mockImplementation(async (hash: string) => ({ hash, adName: 'x', source: 'user-marked' }))
    mockRemoveLearned.mockResolvedValue(true)
    const revoked = await removeSample(sample.id)
    expect(revoked).toBe(SEGMENTS.length)
    expect(mockStorageSet).toHaveBeenCalledWith('hlsAdSamples', [])
  })

  it('removeSample 对不存在的样本返回 null 且不改动存储', async () => {
    mockStorageGet.mockResolvedValue([])
    mockStorageSet.mockClear()
    const revoked = await removeSample('not-exist')
    expect(revoked).toBeNull()
    expect(mockStorageSet).not.toHaveBeenCalled()
  })

  it('clearSamples 撤销所有样本指纹', async () => {
    const a = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, undefined, 1)!
    const b = { ...a, id: 'other' }
    mockStorageGet.mockResolvedValue([a, b])
    mockCompute.mockImplementation(async (url: string) => `h-${url}`)
    mockLookupUser.mockImplementation(async (hash: string) => ({ hash, adName: 'x', source: 'user-marked' }))
    mockRemoveLearned.mockResolvedValue(true)
    const revoked = await clearSamples()
    expect(revoked).toBe(SEGMENTS.length * 2)
  })

  it('判为 content 的分片同样会被撤销（其指纹本不应存在）', async () => {
    const s = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, undefined, 1)!
    const judged = applyVerdict(s, 2, 'content')
    mockStorageGet.mockResolvedValue([judged])
    mockCompute.mockImplementation(async (url: string) => `h-${url}`)
    mockLookupUser.mockImplementation(async (hash: string) => ({ hash, adName: 'x', source: 'user-marked' }))
    mockRemoveLearned.mockResolvedValue(true)
    const revoked = await removeSample(judged.id)
    expect(revoked).toBe(SEGMENTS.length)
  })

  it('clearSamples(false) 只清样本不撤销指纹（备份导入场景）', async () => {
    const sample = captureSample(SEGMENTS, 10, 'h', 'u', REPORT, undefined, 1)!
    mockStorageGet.mockResolvedValue([sample])
    mockCompute.mockImplementation(async (url: string) => `h-${url}`)
    mockLookupUser.mockImplementation(async (hash: string) => ({ hash, adName: 'x', source: 'user-marked' }))
    mockRemoveLearned.mockResolvedValue(true)
    mockRemoveLearned.mockClear()
    const revoked = await clearSamples(false)
    expect(revoked).toBe(0)
    expect(mockRemoveLearned).not.toHaveBeenCalled()
  })
})