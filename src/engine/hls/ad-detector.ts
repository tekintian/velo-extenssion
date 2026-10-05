import type { AdFilterConfig, DetectionReport, DetectionResult, ParsedPlaylist, Segment } from './types'

export function detectSequenceJumps(segments: readonly Segment[]): Set<number> {
  const jumpSet = new Set<number>()
  if (!segments || segments.length === 0) return jumpSet

  let withSeq = 0
  for (const s of segments) {
    if (s.seqNum !== null) withSeq++
  }
  if (withSeq < segments.length * 0.5) return jumpSet

  const blocks: Array<{ segs: Segment[]; firstSeq: number | null }> = []
  let cur: { segs: Segment[]; firstSeq: number | null } | null = null
  for (const s of segments) {
    if (!cur || s.discontinuity) {
      cur = { segs: [], firstSeq: s.seqNum }
      blocks.push(cur)
    }
    cur.segs.push(s)
  }

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
  if (modeCount < deltas.length * 0.4) return jumpSet

  const jumpThreshold = Math.max(normalDelta * 10, 100)

  for (let j = 1; j < blocks.length - 1; j++) {
    const prev = blocks[j - 1]!.firstSeq
    const curSeq = blocks[j]!.firstSeq
    const next = blocks[j + 1]!.firstSeq
    if (prev === null || curSeq === null || next === null) continue
    const upDelta = curSeq - prev
    const downDelta = next - curSeq
    if (upDelta > jumpThreshold && downDelta < -jumpThreshold) {
      for (const s of blocks[j]!.segs) jumpSet.add(s.index)
    }
  }
  return jumpSet
}

export function detectShortBlocks(segments: readonly Segment[]): Set<number> {
  const shortSet = new Set<number>()
  if (!segments || segments.length < 6) return shortSet

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

  const durs = blocks.map((b) => b.dur).filter((d) => d > 0).sort((a, b) => a - b)
  if (durs.length === 0) return shortSet
  const median = durs[Math.floor(durs.length / 2)] ?? 0
  if (median <= 0) return shortSet

  const shortThreshold = Math.min(median * 0.3, 60)
  const segCountThreshold = median * 0.75
  for (const b of blocks) {
    const isShort = b.dur > 0 && b.dur < shortThreshold && b.segs.length < 20
    const isFewSegs = b.dur > 0 && b.segs.length <= 3 && b.dur < segCountThreshold
    if (isShort || isFewSegs) {
      for (const s of b.segs) shortSet.add(s.index)
    }
  }
  return shortSet
}

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

  const originCount = new Map<string, number>()
  const prefixCount = new Map<string, number>()
  for (const s of segs) {
    try {
      const u = new URL(s.url)
      originCount.set(u.origin, (originCount.get(u.origin) ?? 0) + 1)
      const pp = u.origin + u.pathname.split('/').slice(0, -1).join('/')
      prefixCount.set(pp, (prefixCount.get(pp) ?? 0) + 1)
    } catch { /* ignore */ }
  }
  let majorityOrigin: string | null = null
  let majorityPrefix: string | null = null
  for (const [o, c] of originCount) {
    if (majorityOrigin === null || c > (originCount.get(majorityOrigin) ?? 0)) majorityOrigin = o
  }
  for (const [p, c] of prefixCount) {
    if (majorityPrefix === null || c > (prefixCount.get(majorityPrefix) ?? 0)) majorityPrefix = p
  }

  const durs = segs.map((s) => s.duration).filter((d) => d > 0).sort((a, b) => a - b)
  const median = durs.length ? durs[Math.floor(durs.length / 2)]! : 0

  const threshold = config.scoreThreshold || 3
  const patterns = config._patterns ?? []
  const useDurationHeuristic = segs.length >= (config.minSegmentsForStats || 4)

  const jumpSet = detectSequenceJumps(segs)
  const jumpDetected = jumpSet.size > 0
  const shortSet = detectShortBlocks(segs)
  const shortDetected = shortSet.size > 0

  for (const s of segs) {
    let score = 0
    const r: string[] = []

    if (s.cueState === 'out') { score += 3; r.push('cue-out') }
    if (s.scte35) { score += 3; r.push('scte35') }
    if (s.dateRangeAd) { score += 3; r.push('daterange-ad') }
    if (jumpDetected && jumpSet.has(s.index)) { score += 3; r.push(`sequence-jump(seg#${s.seqNum !== null && s.seqNum !== undefined ? s.seqNum : '?'})`) }
    if (shortDetected && shortSet.has(s.index)) { score += 3; r.push('short-block') }

    for (const p of patterns) {
      if (p.test(s.url)) { score += 2; r.push(`url-pattern:${p.source}`); break }
    }

    try {
      const u = new URL(s.url)
      if (majorityOrigin && u.origin !== majorityOrigin) { score += 2; r.push(`origin-differs(${u.origin})`) }
      const pp = u.origin + u.pathname.split('/').slice(0, -1).join('/')
      if (majorityPrefix && pp !== majorityPrefix) { score += 1; r.push('path-differs') }
    } catch { /* ignore */ }

    if (useDurationHeuristic && median && s.duration > 0 && Math.abs(s.duration - median) > median * 0.5) {
      score += 1; r.push(`duration-outlier(${s.duration}s vs median ${median}s)`)
    }

    let kept = false
    const fks = config._forceKeep ?? []
    for (const fk of fks) {
      if (fk.test(s.url)) { kept = true; r.push('force-keep(bypassed)'); break }
    }

    if (!kept && score >= threshold) { adSegments.add(s.index); reasons.set(s.index, r) }
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
