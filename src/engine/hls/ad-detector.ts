/**
 * 广告分片检测 — 9 信号加权
 *
 * 移植自 NDM ad-filter.js detectAds + _detectSequenceJumps + _detectShortBlocks
 *
 * 检测信号（scored，默认阈值 3 分判定为广告）:
 *   +3  cueState=='out'    处于 #EXT-X-CUE-OUT ... #EXT-X-CUE-IN 之间（HLS 标准广告块）
 *   +3  scte35              命中 #EXT-X-SCTE35-OUT / #EXT-X-SCTE35-CMD（SCTE-35 广告信令）
 *   +3  dateRangeAd         命中 #EXT-X-DATERANGE 且 CLASS 含 ad/sponsor/promo 或带 SCTE35 字段
 *   +3  sequence-jump       discontinuity 块首片序列跳号（跳上→跑一段→跳回 = 广告插入）
 *   +3  short-block         短 discontinuity 块夹在长块之间（需经 URL / 少数派目录佐证）
 *   +3  minority-path-block 块路径前缀属于少数派（正片全在 A 目录，广告整块换 B 目录投放）
 *   +2  url-pattern         分片 URL 匹配广告正则
 *   +2  origin-differs      分片 origin 与多数分片 origin 不一致（跨域 CDN 投放）
 *   +1  path-differs        分片 path 前缀与多数分片不一致
 *   +1  duration-outlier    分片时长偏离中位数 >50%（且分片数 >=4 时才启用）
 */

import type { AdFilterConfig, DetectionReport, DetectionResult, ParsedPlaylist, Segment } from './types'

/**
 * [迭代8] 检测 discontinuity 块首片序列跳号（跳上→跑一段→跳回 = 广告插入）
 *
 * 严格移植 NDM ad-filter.js _detectSequenceJumps
 * 关键保护条件（我们之前漏掉的）：
 *   1. 可解析尾号的分片占比 < 50% → 直接返回（hash 文件名无意义）
 *   2. 正常 delta 众数覆盖 < 40% → 直接返回（不是顺序编号）
 *   3. 跳号阈值 = max(normalDelta * 10, 100)（不是 5×）
 *   4. 同时检查 upDelta（跳上）+ downDelta（跳回）
 */
export function detectSequenceJumps(segments: readonly Segment[]): Set<number> {
  const jumpSet = new Set<number>()
  if (!segments || segments.length === 0) return jumpSet

  // 0) 可解析尾号的分片占比 — hash 名常不足 50%, 跳号检测无意义
  let withSeq = 0
  for (const s of segments) {
    if (s.seqNum !== null) withSeq++
  }
  if (withSeq < segments.length * 0.5) return jumpSet

  // 1) 按 discontinuity 分块
  const blocks: Array<{ segs: Segment[]; firstSeq: number | null }> = []
  let cur: { segs: Segment[]; firstSeq: number | null } | null = null
  for (const s of segments) {
    if (!cur || s.discontinuity) {
      cur = { segs: [], firstSeq: s.seqNum }
      blocks.push(cur)
    }
    cur.segs.push(s)
  }

  // 2) 算 "正常 delta" = 块间首片号差值的众数
  const deltas: number[] = []
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i]!.firstSeq !== null && blocks[i - 1]!.firstSeq !== null) {
      const d = (blocks[i]!.firstSeq as number) - (blocks[i - 1]!.firstSeq as number)
      if (d >= 0 && d < 100000) deltas.push(d)
    }
  }
  if (deltas.length < 3) return jumpSet

  const modeMap = new Map<number, number>()
  for (const d of deltas) modeMap.set(d, (modeMap.get(d) ?? 0) + 1)
  let normalDelta = 1
  let modeCount = 0
  for (const [d, c] of modeMap) {
    if (c > modeCount) {
      modeCount = c
      normalDelta = d
    }
  }
  // [迭代10] 置信度: 众数须覆盖 ≥40% 的 delta, 否则文件名不是顺序编号
  if (modeCount < deltas.length * 0.4) return jumpSet

  // 3) 跳号阈值: 10× 正常 delta 或 ≥100
  const jumpThreshold = Math.max(normalDelta * 10, 100)

  // 4) 跳号块: 首片号远超 prev+normalDelta, 且下一块首片号远低于本块 (跳上又跳回)
  for (let j = 1; j < blocks.length - 1; j++) {
    const prev = blocks[j - 1]!.firstSeq
    const curSeq = blocks[j]!.firstSeq
    const next = blocks[j + 1]!.firstSeq
    if (prev === null || curSeq === null || next === null) continue
    const upDelta = curSeq - prev
    const downDelta = next - curSeq
    // 跳上: upDelta >> 正常; 跳回: downDelta 是大负数 (回到内容序列)
    if (upDelta > jumpThreshold && downDelta < -jumpThreshold) {
      for (const s of blocks[j]!.segs) jumpSet.add(s.index)
    }
  }
  return jumpSet
}
/**
 * [迭代9] 检测"短 discontinuity 块夹在长块之间" = 广告插入
 *
 * dytt 类：长内容块夹短广告块，hash 文件名无尾号序列（sequence-jump 无效，只能靠 short-block）
 */
export function detectShortBlocks(segments: readonly Segment[]): Set<number> {
  const shortSet = new Set<number>()
  if (!segments || segments.length < 6) return shortSet

  // 1) 按 discontinuity 分块
  const blocks: Array<{ segs: Segment[]; dur: number }> = []
  let cur: { segs: Segment[]; dur: number } | null = null
  for (const s of segments) {
    if (!cur || s.discontinuity) {
      cur = { segs: [], dur: 0 }
      blocks.push(cur)
    }
    cur.segs.push(s)
    cur.dur += s.duration || 0
  }
  if (blocks.length < 3) return shortSet

  // 2) 块时长中位数 + 单块分片数中位数
  const durs = blocks.map((b) => b.dur).filter((d) => d > 0).sort((a, b) => a - b)
  if (durs.length === 0) return shortSet
  const median = durs[Math.floor(durs.length / 2)] ?? 0
  if (median <= 0) return shortSet

  const segLens = blocks.map((b) => b.segs.length).filter((n) => n > 0).sort((a, b) => a - b)
  const medianSegs = segLens[Math.floor(segLens.length / 2)] ?? 0

  // 3) 短块判定（均以"相对中位数"为准，不写死绝对秒数）
  //    (a) 块时长 << 中位数（< 0.5×）—— 抓 20片40s 的正片块之间的 13s / 17s 广告块
  //    (b) 分片数 ≤3 且 块时长 < 中位数×0.75
  //    (c) 分片数明显少于多数派块（< 0.6×中位片数）且 块时长 < 中位数×0.75
  const durRatio = median * 0.5
  const segCountThreshold = median * 0.75
  const segLenRatio = medianSegs * 0.6
  for (const b of blocks) {
    const isShort = b.dur > 0 && b.dur < durRatio
    const isFewSegs = b.dur > 0 && b.segs.length <= 3 && b.dur < segCountThreshold
    const isFewerSegs = b.dur > 0 && medianSegs >= 5 && b.segs.length < segLenRatio && b.dur < segCountThreshold
    if (isShort || isFewSegs || isFewerSegs) {
      for (const s of b.segs) shortSet.add(s.index)
    }
  }
  return shortSet
}

/**
 * 检测"少数派路径块" = 跨 CDN / 独立子目录投放的广告块
 *
 * 典型场景（kkzy/tnoQ2Gnh 类站点）：正片全在 `/20221216/xxx/2000kb/hls/`，
 * 广告整块换成 `/20261101/yyy/10082kb/hls/`，hash 文件名无尾号、无任何广告标签，
 * 只能靠"路径前缀属于少数派"识别。单/双分片的异常片不判，避免误伤。
 */
export function detectMinorityPathBlocks(segments: readonly Segment[]): Set<number> {
  const minoritySet = new Set<number>()
  if (!segments || segments.length < 6) return minoritySet

  // 1) 分片路径前缀（origin + 目录）多数派统计
  const prefixCount = new Map<string, number>()
  for (const s of segments) {
    const p = pathPrefixOf(s.url)
    if (p) prefixCount.set(p, (prefixCount.get(p) ?? 0) + 1)
  }
  if (prefixCount.size < 2) return minoritySet

  let majorityPrefix = ''
  let majorityCount = 0
  for (const [p, c] of prefixCount) {
    if (c > majorityCount) {
      majorityCount = c
      majorityPrefix = p
    }
  }
  if (majorityCount < segments.length * 0.5) return minoritySet

  // 2) 按 discontinuity 分块
  const blocks: Array<{ segs: Segment[] }> = []
  let cur: { segs: Segment[] } | null = null
  for (const s of segments) {
    if (!cur || s.discontinuity) {
      cur = { segs: [] }
      blocks.push(cur)
    }
    cur.segs.push(s)
  }

  // 3) 多数派块的典型片数（用于识别"广告块片数远少于正片块"）
  const segLens = blocks.map((b) => b.segs.length).sort((a, b) => a - b)
  const medianSegs = segLens[Math.floor(segLens.length / 2)] ?? 0

  // 4) 少数派块判定：块内多数分片前缀 != 多数派前缀，
  //    且块片数不超多数派块典型片数（广告块通常显著短于正片块）。
  //    同一前缀被多个块复用时更可信，但单块站点也必须识别，故不作为硬性条件。
  const blockPrefixOf = new Map<number, { prefix: string; count: number }>()
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi]!
    if (b.segs.length < 2) continue
    const bc = new Map<string, number>()
    for (const s of b.segs) {
      const p = pathPrefixOf(s.url)
      if (p) bc.set(p, (bc.get(p) ?? 0) + 1)
    }
    let blockPrefix = ''
    let blockPrefixCount = 0
    for (const [p, c] of bc) {
      if (c > blockPrefixCount) {
        blockPrefixCount = c
        blockPrefix = p
      }
    }
    if (!blockPrefix || blockPrefix === majorityPrefix) continue
    blockPrefixOf.set(bi, { prefix: blockPrefix, count: blockPrefixCount })
  }

  for (let bi = 0; bi < blocks.length; bi++) {
    const info = blockPrefixOf.get(bi)
    if (!info) continue
    const b = blocks[bi]!
    const fewerSegs = medianSegs > 0 && b.segs.length <= medianSegs * 1.5
    if (fewerSegs) {
      for (const s of b.segs) minoritySet.add(s.index)
    }
  }
  return minoritySet
}

/** origin + 目录路径前缀（不含文件名） */
function pathPrefixOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.origin + u.pathname.split('/').slice(0, -1).join('/')
  } catch {
    return null
  }
}

/**
 * 短块是否可作为广告采信
 *
 * 短块结构证据仅在以下两种情况成立：
 *   1) 该块属于少数派路径块（跨目录投放，如 /20261101/xxx/10082kb/hls）；
 *   2) URL 显式带广告标识（ads/ 目录、ad= 参数等）。
 *
 * 同目录 + hash 命名站点（dytt-tvs 类）广告无法靠 URL 区分，但此类站点的短块
 * 与正片块时长比例差异显著（< 0.45×），且不存在正片碎块，故允许直接采信。
 */
function isShortBlockAdmissible(s: Segment, minoritySet: ReadonlySet<number>, hasCrossDirAds: boolean): boolean {
  if (minoritySet.has(s.index)) return true
  if (!hasCrossDirAds) return true
  if (!s.url) return false
  try {
    const u = new URL(s.url)
    return (
      u.pathname
        .toLowerCase()
        .split('/')
        .some((part) => /^ads?($|[-_.])|^advertis|^preroll|^midroll|^postroll|^spot/.test(part)) ||
      /[?&](ad|adid|ad_id|adbreak|spotid)=/i.test(u.search)
    )
  } catch {
    return false
  }
}

/**
 * [迭代14] 计算广告时间区间（供页面内播放跳过用）
 *
 * 遍历分片累计时间，合并连续广告片为区间
 */
export function computeAdRanges(segments: readonly Segment[], adSet: Set<number>): Array<{ start: number; end: number; duration: number }> {
  const ranges: Array<{ start: number; end: number; duration: number }> = []
  if (!segments || segments.length === 0 || adSet.size === 0) return ranges

  let t = 0
  let curStart = -1
  let curEnd = -1
  for (const s of segments) {
    const dur = s.duration || 0
    const isAd = adSet.has(s.index)
    if (isAd) {
      if (curStart < 0) curStart = t
      curEnd = t + dur
    } else if (curStart >= 0) {
      ranges.push({ start: curStart, end: curEnd, duration: curEnd - curStart })
      curStart = -1
      curEnd = -1
    }
    t += dur
  }
  if (curStart >= 0) ranges.push({ start: curStart, end: curEnd, duration: curEnd - curStart })
  return ranges
}

/**
 * 多信号加权打分，识别广告分片
 */
export function detectAds(parsed: ParsedPlaylist, config: AdFilterConfig): DetectionResult {
  const segs = parsed.segments
  const adSegments = new Set<number>()
  const reasons = new Map<number, string[]>()

  if (segs.length === 0) {
    return {
      adSegments,
      reasons,
      report: { total: 0, ads: 0, adDuration: 0, contentDuration: 0, appliedRule: config._appliedRule ?? null },
    }
  }

  // 阈值 0 = 用户明确要求不过滤任何分片（非哨兵值，0 就是 0）
  if (config.scoreThreshold <= 0) {
    return {
      adSegments,
      reasons,
      report: {
        total: segs.length,
        ads: 0,
        adDuration: 0,
        contentDuration: Math.round(segs.reduce((sum, s) => sum + s.duration, 0)),
        appliedRule: config._appliedRule ?? null,
      },
    }
  }

  // URL origin / path 前缀的多数派统计
  const originCount = new Map<string, number>()
  const prefixCount = new Map<string, number>()
  for (const s of segs) {
    try {
      const u = new URL(s.url)
      originCount.set(u.origin, (originCount.get(u.origin) ?? 0) + 1)
      const pp = u.origin + u.pathname.split('/').slice(0, -1).join('/')
      prefixCount.set(pp, (prefixCount.get(pp) ?? 0) + 1)
    } catch {
      // ignore
    }
  }
  let majorityOrigin: string | null = null
  let majorityPrefix: string | null = null
  for (const [o, c] of originCount) {
    if (majorityOrigin === null || c > (originCount.get(majorityOrigin) ?? 0)) majorityOrigin = o
  }
  for (const [p, c] of prefixCount) {
    if (majorityPrefix === null || c > (prefixCount.get(majorityPrefix) ?? 0)) majorityPrefix = p
  }

  // 时长中位数
  const durs = segs.map((s) => s.duration).filter((d) => d > 0).sort((a, b) => a - b)
  const median = durs.length ? durs[Math.floor(durs.length / 2)]! : 0

  const threshold = config.scoreThreshold
  const patterns = config._patterns ?? []
  const useDurationHeuristic = segs.length >= (config.minSegmentsForStats || 4)

  // 预处理：跳号检测 + 短块检测 + 少数派路径块检测
  const jumpSet = detectSequenceJumps(segs)
  const jumpDetected = jumpSet.size > 0
  const shortSet = detectShortBlocks(segs)
  const shortDetected = shortSet.size > 0
  const minoritySet = detectMinorityPathBlocks(segs)
  const minorityDetected = minoritySet.size > 0

  // 是否存在跨目录投放（少数派路径块）。
  // kkzy 类站点广告整块换目录投放，正片目录里的短碎块与广告块时长比例重叠，
  // 此时短块必须靠少数派目录佐证；dytt 类站点全部同目录，短块可直接采信。
  const hasCrossDirAds = minorityDetected

  for (const s of segs) {
    let score = 0
    const r: string[] = []

    if (s.cueState === 'out') {
      score += 3
      r.push('cue-out')
    }
    if (s.scte35) {
      score += 3
      r.push('scte35')
    }
    if (s.dateRangeAd) {
      score += 3
      r.push('daterange-ad')
    }

    if (jumpDetected && jumpSet.has(s.index)) {
      score += 3
      r.push(`sequence-jump(seg#${s.seqNum !== null && s.seqNum !== undefined ? s.seqNum : '?'})`)
    }
    // short-block 结构证据：需经 URL / 少数派目录佐证（站点无正片碎块时直接采信）
    if (shortDetected && shortSet.has(s.index) && isShortBlockAdmissible(s, minoritySet, hasCrossDirAds)) {
      score += 3
      r.push('short-block')
    }
    if (minorityDetected && minoritySet.has(s.index)) {
      score += 3
      r.push('minority-path-block')
    }

    for (const p of patterns) {
      if (p.test(s.url)) {
        score += 2
        r.push(`url-pattern:${p.source}`)
        break
      }
    }

    try {
      const u = new URL(s.url)
      if (majorityOrigin && u.origin !== majorityOrigin) {
        score += 2
        r.push(`origin-differs(${u.origin})`)
      }
      const pp = u.origin + u.pathname.split('/').slice(0, -1).join('/')
      if (majorityPrefix && pp !== majorityPrefix) {
        score += 1
        r.push('path-differs')
      }
    } catch {
      // ignore
    }

    if (useDurationHeuristic && median && s.duration > 0 && Math.abs(s.duration - median) > median * 0.5) {
      score += 1
      r.push(`duration-outlier(${s.duration}s vs median ${median}s)`)
    }

    // forceKeep：强制保留（即使打分超阈值也不当广告）
    let kept = false
    const fks = config._forceKeep ?? []
    for (const fk of fks) {
      if (fk.test(s.url)) {
        kept = true
        r.push('force-keep(bypassed)')
        break
      }
    }

    if (!kept && score >= threshold) {
      adSegments.add(s.index)
      reasons.set(s.index, r)
    }
  }

  let adDur = 0
  let contentDur = 0
  for (const s of segs) {
    if (adSegments.has(s.index)) adDur += s.duration
    else contentDur += s.duration
  }

  const report: DetectionReport = {
    total: segs.length,
    ads: adSegments.size,
    adDuration: Math.round(adDur),
    contentDuration: Math.round(contentDur),
    appliedRule: config._appliedRule ?? null,
  }

  return { adSegments, reasons, report }
}