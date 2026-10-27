/**
 * DASH 广告检测器
 *
 * 加权评分框架复用 HLS ad-detector 设计。
 * 信号集分两组：
 *   - JSON Playurl 场景（5 信号）
 *   - MPD XML 场景（7 信号，Phase 2 实现）
 */

import type {
  JsonPlayurlManifest,
  MpdManifest,
  MpdPeriod,
  DashManifest,
  DashDetection,
  DashDetectionResult,
  DashDetectionSummary,
  PlayurlTrack,
} from './types'
import type { SiteRule } from '@engine/shared/types'

const DEFAULT_SCORE_THRESHOLD = 3

export async function detectAds(
  manifest: DashManifest,
  config: {
    patterns?: RegExp[]
    forceKeep?: RegExp[]
    scoreThreshold?: number
    appliedRule?: SiteRule | null
  },
): Promise<DashDetectionResult> {
  const threshold = config.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD
  const patterns = config.patterns ?? []
  const forceKeep = config.forceKeep ?? []

  if (manifest.type === 'json-playurl') {
    return detectJsonPlayurlAds(manifest, threshold, patterns, forceKeep, config.appliedRule ?? null)
  }

  if (manifest.type === 'mpd-xml') {
    return detectMpdXmlAds(manifest, threshold, patterns, forceKeep, config.appliedRule ?? null)
  }

  return emptyResult(config.appliedRule ?? null)
}

// ============================================================================
// JSON Playurl 场景信号
// ============================================================================

async function detectJsonPlayurlAds(
  manifest: JsonPlayurlManifest,
  threshold: number,
  patterns: RegExp[],
  forceKeep: RegExp[],
  appliedRule: SiteRule | null,
): Promise<DashDetectionResult> {
  const detections: DashDetection[] = []
  const adTargetIds = new Set<string>()
  const forceKeepIds = new Set<string>()

  const videoTracks = manifest.tracks.filter((t) => t.kind === 'video')
  const audioTracks = manifest.tracks.filter((t) => t.kind === 'audio')

  for (const track of manifest.tracks) {
    if (isForceKeep(track, forceKeep)) {
      forceKeepIds.add(track.id)
      continue
    }

    let score = 0
    const reasons: string[] = []

    const urlScore = signalUrlPattern(track, patterns)
    if (urlScore > 0) { score += urlScore; reasons.push(`url-pattern:${urlScore}`) }

    const originScore = signalOriginDiffers(track, manifest.tracks)
    if (originScore > 0) { score += originScore; reasons.push(`origin-differs:${originScore}`) }

    const anomalyScore = signalTrackCountAnomaly(track, videoTracks, audioTracks)
    if (anomalyScore > 0) { score += anomalyScore; reasons.push(`track-count-anomaly:${anomalyScore}`) }

    const bwScore = signalBandwidthOutlier(track, manifest.tracks)
    if (bwScore > 0) { score += bwScore; reasons.push(`bandwidth-outlier:${bwScore}`) }

    const codecScore = signalCodecMismatch(track, manifest.tracks)
    if (codecScore > 0) { score += codecScore; reasons.push(`codec-mismatch:${codecScore}`) }

    if (score >= threshold) {
      adTargetIds.add(track.id)
      detections.push({
        targetId: track.id,
        targetType: 'track',
        signal: reasons.join(','),
        score,
        reason: `score=${score} >= threshold=${threshold}`,
      })
    }
  }

  const summary: DashDetectionSummary = {
    totalTargets: manifest.tracks.length,
    adTargets: adTargetIds.size,
    signals: countSignals(detections),
    appliedRule,
  }

  return { adTargetIds, detections, forceKeep: forceKeepIds, summary }
}

/** 信号 1: url-pattern — 轨 URL 匹配站点规则 adUrlPatterns */
function signalUrlPattern(track: PlayurlTrack, patterns: RegExp[]): number {
  if (patterns.length === 0) return 0
  for (const pat of patterns) {
    if (pat.test(track.baseUrl)) return 3
    if (track.backupUrls) {
      for (const bu of track.backupUrls) {
        if (pat.test(bu)) return 3
      }
    }
  }
  return 0
}

/** 信号 2: origin-differs — 轨的 baseUrl 域名与大多数轨不同 */
function signalOriginDiffers(track: PlayurlTrack, allTracks: PlayurlTrack[]): number {
  const trackOrigin = extractOrigin(track.baseUrl)
  if (!trackOrigin) return 0

  const origins = allTracks.map((t) => extractOrigin(t.baseUrl)).filter(Boolean) as string[]
  if (origins.length <= 1) return 0

  const freq = new Map<string, number>()
  for (const o of origins) freq.set(o, (freq.get(o) ?? 0) + 1)

  const majorityOrigin = Array.from(freq.entries()).sort((a, b) => b[1] - a[1])[0]![0]
  if (trackOrigin !== majorityOrigin) return 2

  return 0
}

/** 信号 3: track-count-anomaly — 单独出现（1 video + 0 audio 或反之） */
function signalTrackCountAnomaly(
  track: PlayurlTrack,
  videoTracks: PlayurlTrack[],
  audioTracks: PlayurlTrack[],
): number {
  if (videoTracks.length === 1 && audioTracks.length === 0) return 2
  if (videoTracks.length === 0 && audioTracks.length === 1) return 2
  if (track.kind === 'video' && videoTracks.length === 1 && audioTracks.length > 0) return 1
  if (track.kind === 'audio' && audioTracks.length === 1 && videoTracks.length > 0) return 1
  return 0
}

/** 信号 4: bandwidth-outlier — 轨带宽显著偏离同 kind 其他轨 */
function signalBandwidthOutlier(track: PlayurlTrack, allTracks: PlayurlTrack[]): number {
  const sameKind = allTracks.filter((t) => t.kind === track.kind && t.id !== track.id)
  if (sameKind.length === 0) return 0

  const avgBw = sameKind.reduce((sum, t) => sum + t.bandwidth, 0) / sameKind.length
  if (avgBw > 0 && track.bandwidth < avgBw * 0.3) return 1
  if (avgBw > 0 && track.bandwidth > avgBw * 4) return 3

  return 0
}

/**
 * 信号 5: codec-mismatch — 轨的 codecs 与同 kind 多数轨不同
 *
 * B站广告轨常使用高 profile AVC（如 avc1.640028 = High@4.0），
 * 而内容轨用较低 profile（如 avc1.64001f = Main@3.1）。
 * 当同一 kind 中某轨的 codec family 与多数轨不同时，权重 3；
 * 同 family 但不同 profile/level 时，权重 1。
 */
function signalCodecMismatch(track: PlayurlTrack, allTracks: PlayurlTrack[]): number {
  if (!track.codecs) return 0

  const sameKind = allTracks.filter((t) => t.kind === track.kind && t.id !== track.id && t.codecs)
  if (sameKind.length === 0) return 0

  const trackFamily = codecFamily(track.codecs)
  const families = sameKind.map((t) => codecFamily(t.codecs!))

  const freq = new Map<string, number>()
  for (const f of families) freq.set(f, (freq.get(f) ?? 0) + 1)

  const majorityFamily = Array.from(freq.entries()).sort((a, b) => b[1] - a[1])[0]![0]

  if (trackFamily !== majorityFamily) return 3

  const trackProfile = codecProfile(track.codecs)
  const profiles = sameKind.map((t) => codecProfile(t.codecs!))
  const profileFreq = new Map<string, number>()
  for (const p of profiles) profileFreq.set(p, (profileFreq.get(p) ?? 0) + 1)
  const majorityProfile = Array.from(profileFreq.entries()).sort((a, b) => b[1] - a[1])[0]![0]

  if (trackProfile !== majorityProfile) return 1

  return 0
}

function codecFamily(codecs: string): string {
  const c = codecs.split(',')[0]!.split('.')[0]!
  return c.toLowerCase()
}

function codecProfile(codecs: string): string {
  const parts = codecs.split(',')[0]!.split('.')
  if (parts.length < 2) return codecs
  return parts.slice(0, 2).join('.')
}

function isForceKeep(track: PlayurlTrack, forceKeep: RegExp[]): boolean {
  for (const pat of forceKeep) {
    if (pat.test(track.baseUrl)) return true
    if (track.backupUrls) {
      for (const bu of track.backupUrls) {
        if (pat.test(bu)) return true
      }
    }
  }
  return false
}

// ============================================================================
// MPD XML 场景信号（Phase 2 骨架，当前返回空结果）
// ============================================================================

async function detectMpdXmlAds(
  manifest: MpdManifest,
  threshold: number,
  patterns: RegExp[],
  forceKeep: RegExp[],
  appliedRule: SiteRule | null,
): Promise<DashDetectionResult> {
  const detections: DashDetection[] = []
  const adTargetIds = new Set<string>()
  const forceKeepIds = new Set<string>()

  for (const period of manifest.periods) {
    if (isMpdForceKeep(period, forceKeep)) {
      forceKeepIds.add(period.id ?? '')
      continue
    }

    let score = 0
    const reasons: string[] = []

    const urlScore = signalMpdUrlPattern(period, patterns)
    if (urlScore > 0) { score += urlScore; reasons.push(`url-pattern:${urlScore}`) }

    if (period.eventStreams) {
      for (const es of period.eventStreams) {
        if (es.schemeIdUri.includes('scte35')) {
          score += 4
          reasons.push('event-scte35:4')
        }
        if (es.schemeIdUri.includes('splice')) {
          score += 3
          reasons.push('event-cue-out:3')
        }
      }
    }

    if (period.xlinkHref) {
      score += 3
      reasons.push('ad-period-xlink:3')
    }

    if (period.id && /ad|advert|commercial|sponsor|promo/i.test(period.id)) {
      score += 3
      reasons.push('ad-period-id-pattern:3')
    }

    const durScore = signalShortPeriod(period, manifest)
    if (durScore > 0) { score += durScore; reasons.push(`short-period:${durScore}`) }

    const repScore = signalRepAnomaly(period, manifest)
    if (repScore > 0) { score += repScore; reasons.push(`rep-anomaly:${repScore}`) }

    if (score >= threshold && period.id) {
      adTargetIds.add(period.id)
      detections.push({
        targetId: period.id,
        targetType: 'period',
        signal: reasons.join(','),
        score,
        reason: `score=${score} >= threshold=${threshold}`,
      })
    }
  }

  const summary: DashDetectionSummary = {
    totalTargets: manifest.periods.length,
    adTargets: adTargetIds.size,
    signals: countSignals(detections),
    appliedRule,
  }

  return { adTargetIds, detections, forceKeep: forceKeepIds, summary }
}

// ============================================================================
// 工具函数
// ============================================================================

function extractOrigin(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function signalMpdUrlPattern(period: MpdPeriod, patterns: RegExp[]): number {
  if (patterns.length === 0) return 0
  for (const adapt of period.adaptations) {
    for (const rep of adapt.representations) {
      const url = rep.baseUrl ?? adapt.baseUrl ?? period.baseUrl ?? ''
      for (const pat of patterns) {
        if (pat.test(url)) return 3
      }
    }
  }
  return 0
}

function isMpdForceKeep(period: MpdPeriod, forceKeep: RegExp[]): boolean {
  for (const adapt of period.adaptations) {
    for (const rep of adapt.representations) {
      const url = rep.baseUrl ?? adapt.baseUrl ?? period.baseUrl ?? ''
      for (const pat of forceKeep) {
        if (pat.test(url)) return true
      }
    }
  }
  return false
}

function signalShortPeriod(period: MpdPeriod, manifest: MpdManifest): number {
  if (manifest.periods.length < 2) return 0
  const dur = period.duration ?? 0
  if (dur <= 0) return 0
  const totalDur = manifest.mediaPresentationDuration ?? manifest.periods.reduce((s, p) => s + (p.duration ?? 0), 0)
  if (totalDur <= 0) return 0
  const avgDur = totalDur / manifest.periods.length
  if (dur < avgDur * 0.2 && dur < 60) return 2
  return 0
}

function signalRepAnomaly(period: MpdPeriod, manifest: MpdManifest): number {
  if (manifest.periods.length < 2) return 0
  const repCount = period.adaptations.reduce((s, a) => s + a.representations.length, 0)
  const avgRepCount = manifest.periods.reduce((s, p) => s + p.adaptations.reduce((s2, a) => s2 + a.representations.length, 0), 0) / manifest.periods.length
  if (avgRepCount > 0 && repCount > avgRepCount * 3) return 2
  if (repCount === 1 && avgRepCount > 2) return 1
  return 0
}

function countSignals(detections: DashDetection[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const d of detections) {
    const signals = d.signal.split(',')
    for (const s of signals) {
      const name = s.replace(/:\d+$/, '')
      counts[name] = (counts[name] ?? 0) + 1
    }
  }
  return counts
}

function emptyResult(appliedRule?: SiteRule | null): DashDetectionResult {
  return {
    adTargetIds: new Set(),
    detections: [],
    forceKeep: new Set(),
    summary: { totalTargets: 0, adTargets: 0, signals: {}, appliedRule: appliedRule ?? null },
  }
}