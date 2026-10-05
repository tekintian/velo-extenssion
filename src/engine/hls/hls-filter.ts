import { detectAds } from './ad-detector'
import { computeFingerprint, initFingerprint, learnFingerprint, lookupFingerprint } from './fingerprint'
import { getSiteRule } from './hls-rules'
import { isMasterPlaylist, parseMasterPlaylist, parsePlaylist } from './playlist-parser'
import { rebuildPlaylist } from './playlist-rebuilder'
import type { AdFilterConfig, ProcessResult } from './types'
import { logger } from '@/lib/logger'

export const DEFAULT_AD_URL_PATTERNS: RegExp[] = [
  /\/ads?\//i,
  /\/advertis(?:ing|ement)?\//i,
  /\/preroll/i,
  /\/midroll/i,
  /\/postroll/i,
  /\bad[-_]\d+/i,
  /\b(preroll|midroll|postroll)[-_]\d+/i,
  /^https?:\/\/[^/]*\b(ad|ads|advert|promo|spot|sponsor)\b/i,
  /[?&](ad|adid|ad_id|adbreak|spotid)=/i,
]

export const DEFAULT_CONFIG: AdFilterConfig = {
  enabled: true,
  mode: 'm3u8-file',
  scoreThreshold: 3,
  urlPatterns: [],
  logToConsole: true,
  minSegmentsForStats: 4,
  keepDiscontinuityOnGap: true,
  remoteRulesUrl: '',
  enableFingerprint: false,
  fingerprintMode: 'suspicious-only',
  autoLearnFingerprints: true,
  remoteFingerprintsUrl: '',
  maxFingerprintPerPlaylist: 9999,
}

export async function buildConfig(
  userConfig: Partial<AdFilterConfig>,
  pageHost: string,
): Promise<AdFilterConfig> {
  const base: AdFilterConfig = { ...DEFAULT_CONFIG, ...userConfig }
  const { rule, patterns: sitePatterns, forceKeep } = await getSiteRule(pageHost)

  const userPats = base.urlPatterns
    .map((s) => { try { return new RegExp(s, 'i') } catch { return null } })
    .filter((p): p is RegExp => p !== null)

  const allPatterns = [...DEFAULT_AD_URL_PATTERNS, ...userPats, ...sitePatterns]
  const scoreThreshold = rule?.scoreThreshold ?? base.scoreThreshold
  const mode = rule?.mode ?? base.mode

  return { ...base, scoreThreshold, mode, _patterns: allPatterns, _forceKeep: forceKeep, _appliedRule: rule }
}

export async function processPlaylist(
  text: string,
  baseUrl: string,
  pageUrl: string,
  config: AdFilterConfig,
): Promise<ProcessResult> {
  void pageUrl
  if (!config.enabled) return { mode: 'disabled', url: baseUrl, report: null }

  const appliedRule = config._appliedRule ?? null

  if (isMasterPlaylist(text)) {
    const variants = parseMasterPlaylist(text, baseUrl)
    if (config.logToConsole) {
      logger.info('[HLS-AdFilter] master playlist', baseUrl, '→', variants.length, 'variants (recurse)', appliedRule ? `· rule=${appliedRule.id}` : '')
    }
    return { mode: 'master', url: baseUrl, report: { master: true, variants: variants.length, appliedRule } }
  }

  const parsed = parsePlaylist(text, baseUrl)
  const detection = detectAds(parsed, config)

  if (config.enableFingerprint && config.fingerprintMode !== 'off') {
    await initFingerprint(config.remoteFingerprintsUrl)

    const oc = new Map<string, number>()
    for (const s of parsed.segments) {
      try { const u = new URL(s.url); oc.set(u.origin, (oc.get(u.origin) ?? 0) + 1) } catch { /* ignore */ }
    }
    let majO: string | null = null
    for (const [o, c] of oc) { if (majO === null || c > (oc.get(majO) ?? 0)) majO = o }

    const candidates = parsed.segments.filter((s) => {
      if (detection.adSegments.has(s.index)) return false
      if (config.fingerprintMode === 'all') return true
      if (config.fingerprintMode === 'suspicious-only') {
        if (s.discontinuity) return true
        try { const u = new URL(s.url); if (majO && u.origin !== majO) return true } catch { /* ignore */ }
      }
      return false
    })

    const cap = Math.min(candidates.length, config.maxFingerprintPerPlaylist || 9999)
    const batchSize = 10
    for (let bi = 0; bi < cap; bi += batchSize) {
      const batch = candidates.slice(bi, Math.min(bi + batchSize, cap))
      const hashes = await Promise.all(batch.map((s) => computeFingerprint(s.url)))
      for (let hi = 0; hi < batch.length; hi++) {
        const hit = hashes[hi] ? lookupFingerprint(hashes[hi]!) : null
        if (hit && hit.isAd) {
          detection.adSegments.add(batch[hi]!.index)
          detection.reasons.set(batch[hi]!.index, [`fingerprint-match(${hit.adName ?? hit.source ?? 'lib'})`])
        }
      }
    }

    let ad2 = 0; let con2 = 0
    for (const s of parsed.segments) { if (detection.adSegments.has(s.index)) ad2 += s.duration; else con2 += s.duration }
    detection.report = { ...detection.report, ads: detection.adSegments.size, adDuration: Math.round(ad2), contentDuration: Math.round(con2) }

    if (config.autoLearnFingerprints) {
      const learnList = parsed.segments.filter((s) => detection.adSegments.has(s.index))
      const lcap = Math.min(learnList.length, config.maxFingerprintPerPlaylist || 9999)
      let learnedNew = 0
      for (let lb = 0; lb < lcap; lb += batchSize) {
        const lbatch = learnList.slice(lb, Math.min(lb + batchSize, lcap))
        const lhashes = await Promise.all(lbatch.map((s) => computeFingerprint(s.url)))
        for (let lh = 0; lh < lbatch.length; lh++) {
          if (lhashes[lh]) {
            const added = await learnFingerprint(lhashes[lh]!, { adName: `auto:${appliedRule ? appliedRule.id : 'unknown'}`, source: 'auto-learned' })
            if (added) learnedNew++
          }
        }
      }
      if (config.logToConsole && learnedNew > 0) logger.info('[HLS-AdFilter] auto-learned', learnedNew, 'new ad fingerprints')
    }
  }

  if (detection.report.ads === 0) {
    if (config.logToConsole) logger.info('[HLS-AdFilter] no ads in', baseUrl, '(total segs:', detection.report.total, ')', appliedRule ? `· rule=${appliedRule.id}` : '')
    return { mode: 'no-ads', url: baseUrl, report: detection.report, segments: parsed.segments }
  }

  const reasonsExport: Record<number, string[]> = {}
  const adSegmentUrls: string[] = []
  for (const [idx, rs] of detection.reasons) {
    reasonsExport[idx] = rs
    const seg = parsed.segments.find((s) => s.index === idx)
    if (seg) adSegmentUrls.push(seg.url)
  }

  const adRanges = computeAdRangesFromSegments(parsed.segments, detection.adSegments)

  if (config.logToConsole) {
    logger.info(`[HLS-AdFilter] ${detection.report.ads}/${detection.report.total} ad segs in`, baseUrl, `(ad ${detection.report.adDuration}s, content ${detection.report.contentDuration}s)`, appliedRule ? `· rule=${appliedRule.id}` : '')
  }

  if (config.mode === 'passthrough') {
    return { mode: 'passthrough', url: baseUrl, report: detection.report, reasons: reasonsExport, adSegmentUrls, segments: parsed.segments, adRanges }
  }

  if (config.mode === 'enumerate') {
    const contentSegs = parsed.segments.filter((s) => !detection.adSegments.has(s.index))
    return { mode: 'enumerate', segments: contentSegs, report: detection.report, reasons: reasonsExport, adSegmentUrls, adRanges }
  }

  const cleaned = rebuildPlaylist(parsed, detection.adSegments, baseUrl, config)

  if (config.mode === 'm3u8-file') {
    return { mode: 'm3u8-file', cleaned, report: detection.report, reasons: reasonsExport, adSegmentUrls, segments: parsed.segments, adRanges }
  }

  const b64 = base64Encode(cleaned)
  const dataUrl = `data:application/vnd.apple.mpegurl;base64,${b64}`
  return { mode: 'data-url', url: dataUrl, cleaned, report: detection.report, reasons: reasonsExport, adSegmentUrls, segments: parsed.segments, adRanges }
}

function base64Encode(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return typeof Buffer !== 'undefined' ? Buffer.from(bin, 'binary').toString('base64') : btoa(bin)
}

function computeAdRangesFromSegments(
  segments: readonly { index: number; duration: number }[],
  adSet: Set<number>,
): Array<{ start: number; end: number; duration: number }> {
  const ranges: Array<{ start: number; end: number; duration: number }> = []
  if (segments.length === 0 || adSet.size === 0) return ranges
  let t = 0; let curStart = -1; let curEnd = -1
  for (const s of segments) {
    const dur = s.duration || 0
    const isAd = adSet.has(s.index)
    if (isAd) { if (curStart < 0) curStart = t; curEnd = t + dur }
    else if (curStart >= 0) { ranges.push({ start: curStart, end: curEnd, duration: curEnd - curStart }); curStart = -1; curEnd = -1 }
    t += dur
  }
  if (curStart >= 0) ranges.push({ start: curStart, end: curEnd, duration: curEnd - curStart })
  return ranges
}

export * from './playlist-parser'
export * from './ad-detector'
export * from './playlist-rebuilder'
export * from './hls-rules'
export * from './fingerprint'
export type { SiteRule } from './types'
