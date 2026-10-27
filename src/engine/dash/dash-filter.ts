/**
 * DASH 广告过滤主入口
 *
 * 三路径分发式架构：
 *   - 模式 B: JSON Playurl → json-playurl-parser → ad-detector → json-playurl-rebuilder
 *   - 模式 A: MPD XML → mpd-parser → ad-detector → mpd-rebuilder
 *   - 模式 C: 纯分片 → 依赖 MSE Hook 指纹（已就绪）
 */

import type {
  DashProcessResult,
  DashAdFilterConfig,
  ManifestType,
  JsonPlayurlManifest,
  DashDetectionSummary,
} from './types'
import { parseJsonPlayurl } from './json-playurl-parser'
import { rebuildJsonPlayurl } from './json-playurl-rebuilder'
import { parseMpd } from './mpd-parser'
import { rebuildMpd } from './mpd-rebuilder'
import { detectAds } from './ad-detector'
import { resolveTrackFirstSegmentUrl, resolvePeriodFirstSegmentUrl } from './resolve-first-url'
import { extractMpdAdRanges, extractJsonAdRanges } from './ad-ranges'
import {
  initFingerprint,
  computeFingerprint,
  lookupFingerprint,
  learnFingerprint,
} from '@engine/shared/fingerprint'
import { getSiteRule } from '@engine/shared/rules'
import { consider } from '@engine/shared/suggest'
import { logger } from '@/lib/logger'
import {
  incManifestIntercepted,
  incAdDetected,
  incCleanSuccess,
  incFingerprintHit,
  incParseFail,
  incRebuildFail,
  incDrmDetected,
  incDynamicPassthrough,
} from './metrics'

const DEFAULT_CONFIG: DashAdFilterConfig = {
  enabled: true,
  mode: 'manifest-file',
  scoreThreshold: 3,
  urlPatterns: [],
  logToConsole: false,
  remoteRulesUrl: '',
  enableFingerprint: true,
  fingerprintMode: 'suspicious-only',
  autoLearnFingerprints: true,
  remoteFingerprintsUrl: '',
  maxFingerprintPerManifest: 5,
}

/**
 * 检测 manifest 类型
 */
export function detectManifestType(
  rawText: string,
  url: string,
  contentType?: string,
): ManifestType {
  if (/playurl(\?|$)/i.test(url) || /youtubei\/v\d+\/player/i.test(url)) return 'json-playurl'
  if (/\.mpd(\?|$)/i.test(url)) return 'mpd-xml'

  if (contentType) {
    if (/application\/dash\+xml/i.test(contentType)) return 'mpd-xml'
    if (/application\/json/i.test(contentType)) {
      if (/dash|mpd|playurl|player/i.test(contentType)) return 'json-playurl'
    }
  }

  const trimmed = rawText.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json-playurl'
  if (trimmed.startsWith('<?xml') || trimmed.includes('<MPD')) return 'mpd-xml'

  return 'unknown'
}

/**
 * 处理 DASH manifest — 主入口
 */
export async function processManifest(
  rawText: string,
  url: string,
  pageUrl: string,
  authHeaders?: Record<string, string>,
  config?: Partial<DashAdFilterConfig>,
): Promise<DashProcessResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  if (!cfg.enabled) {
    return { mode: 'passthrough', summary: emptySummary(), reason: 'disabled-by-config' }
  }

  const manifestType = detectManifestType(rawText, url)

  if (manifestType === 'unknown') {
    return { mode: 'passthrough', summary: emptySummary(), reason: 'unknown-manifest-type' }
  }

  await incManifestIntercepted()

  if (cfg.enableFingerprint) {
    await initFingerprint(cfg.remoteFingerprintsUrl)
  }

  const pageHost = extractHost(pageUrl)
  const siteRule = pageHost ? await getSiteRule(pageHost) : null

  const extraPatterns = cfg.urlPatterns
    .map((s) => { try { return new RegExp(s, 'i') } catch { return null } })
    .filter((r): r is RegExp => r !== null)

  const mergedConfig = {
    ...cfg,
    patterns: [...(siteRule?.patterns ?? []), ...extraPatterns],
    forceKeep: siteRule?.forceKeep ?? [],
    appliedRule: siteRule?.rule ?? null,
    scoreThreshold: siteRule?.rule?.scoreThreshold ?? cfg.scoreThreshold,
  }

  if (manifestType === 'json-playurl') {
    return processJsonPlayurl(rawText, url, authHeaders, mergedConfig)
  }

  if (manifestType === 'mpd-xml') {
    return processMpdXml(rawText, url, authHeaders, mergedConfig)
  }

  return { mode: 'passthrough', summary: emptySummary(), reason: 'unsupported-type' }
}

async function processJsonPlayurl(
  rawText: string,
  url: string,
  authHeaders: Record<string, string> | undefined,
  config: DashAdFilterConfig & { patterns: RegExp[]; forceKeep: RegExp[]; appliedRule: import('@engine/shared/types').SiteRule | null },
): Promise<DashProcessResult> {
  let manifest: JsonPlayurlManifest
  try {
    manifest = parseJsonPlayurl(rawText, url)
  } catch {
    await incParseFail()
    return { mode: 'passthrough', summary: emptySummary(), reason: 'parse-error' }
  }

  if (manifest.tracks.length === 0) {
    return { mode: 'passthrough', summary: emptySummary(), reason: 'empty-tracks' }
  }

  const detection = await detectAds(manifest, {
    patterns: config.patterns,
    forceKeep: config.forceKeep,
    scoreThreshold: config.scoreThreshold,
    appliedRule: config.appliedRule,
  })

  if (detection.adTargetIds.size === 0) {
    if (config.logToConsole) {
      logger.info('[DASH-AdFilter] JSON playurl no ads, url:', url.slice(0, 80))
    }
    return { mode: 'no-ads', summary: detection.summary }
  }

  await incAdDetected()

  let adTrackIds = new Set(detection.adTargetIds)
  const adRanges = extractJsonAdRanges(manifest, detection)

  if (config.enableFingerprint) {
    adTrackIds = await applyFingerprintFilter(manifest, adTrackIds, authHeaders, config)
  }

  if (adTrackIds.size === 0) {
    return { mode: 'no-ads', summary: detection.summary }
  }

  const rebuild = rebuildJsonPlayurl(manifest, adTrackIds)

  if (!rebuild.success) {
    await incRebuildFail()
    return { mode: 'passthrough', summary: detection.summary, reason: rebuild.reason ?? 'rebuild-failed' }
  }

  if (config.autoLearnFingerprints) {
    await autoLearnFingerprints(manifest, adTrackIds, authHeaders)
  }

  const reasons: Record<number, string[]> = {}
  let idx = 0
  for (const d of detection.detections) {
    reasons[idx++] = [d.reason]
  }
  await consider(reasons, extractHost(url) || '', config.appliedRule?.id)

  const cleanedText = JSON.stringify(rebuild.cleanedJson)
  await incCleanSuccess()

  if (config.logToConsole) {
    logger.info('[DASH-AdFilter] JSON playurl cleaned:', adTrackIds.size, 'ad tracks removed, url:', url.slice(0, 80))
  }

  if (config.mode === 'data-url') {
    const dataUrl = `data:application/json;base64,${btoa(unescape(encodeURIComponent(cleanedText)))}`
    return { mode: 'data-url', dataUrl, cleanedText, summary: detection.summary, adRanges }
  }

  return { mode: 'manifest-file', cleanedText, summary: detection.summary, adRanges }
}

async function processMpdXml(
  rawText: string,
  url: string,
  authHeaders: Record<string, string> | undefined,
  config: DashAdFilterConfig & { patterns: RegExp[]; forceKeep: RegExp[]; appliedRule: import('@engine/shared/types').SiteRule | null },
): Promise<DashProcessResult> {
  const drmCheck = detectDrm(rawText, 'xml')
  if (drmCheck.hasDrm) {
    await incDrmDetected()
    return { mode: 'disabled', reason: `drm-detected:${drmCheck.scheme ?? 'unknown'}` }
  }

  let mpd: import('./types').MpdManifest
  try {
    mpd = parseMpd(rawText, url)
  } catch {
    await incParseFail()
    return { mode: 'passthrough', summary: emptySummary(), reason: 'mpd-parse-error' }
  }

  if (mpd.mpdType === 'dynamic') {
    await incDynamicPassthrough()
    return { mode: 'passthrough', summary: emptySummary(), reason: 'dynamic-mpd-not-supported' }
  }

  if (mpd.periods.length === 0) {
    return { mode: 'passthrough', summary: emptySummary(), reason: 'empty-periods' }
  }

  const detection = await detectAds(mpd, {
    patterns: config.patterns,
    forceKeep: config.forceKeep,
    scoreThreshold: config.scoreThreshold,
    appliedRule: config.appliedRule,
  })

  if (detection.adTargetIds.size === 0) {
    if (config.logToConsole) {
      logger.info('[DASH-AdFilter] MPD no ads, url:', url.slice(0, 80))
    }
    return { mode: 'no-ads', summary: detection.summary }
  }

  await incAdDetected()

  let adPeriodIds = new Set(detection.adTargetIds)
  const adRanges = extractMpdAdRanges(mpd, detection)

  if (config.enableFingerprint) {
    adPeriodIds = await applyMpdFingerprintFilter(mpd, adPeriodIds, authHeaders)
  }

  if (adPeriodIds.size === 0) {
    return { mode: 'no-ads', summary: detection.summary }
  }

  const rebuild = rebuildMpd(mpd, adPeriodIds)

  if (!rebuild.success) {
    await incRebuildFail()
    return { mode: 'passthrough', summary: detection.summary, reason: rebuild.reason ?? 'rebuild-failed' }
  }

  if (config.autoLearnFingerprints) {
    await autoLearnMpdFingerprints(mpd, adPeriodIds, authHeaders)
  }

  const reasons: Record<number, string[]> = {}
  let idx = 0
  for (const d of detection.detections) {
    reasons[idx++] = [d.reason]
  }
  await consider(reasons, extractHost(url) || '', config.appliedRule?.id)

  const cleanedText = rebuild.cleanedXml ?? rawText
  await incCleanSuccess()

  if (config.logToConsole) {
    logger.info('[DASH-AdFilter] MPD cleaned:', adPeriodIds.size, 'ad periods removed, url:', url.slice(0, 80))
  }

  if (config.mode === 'data-url') {
    const dataUrl = `data:application/dash+xml;base64,${btoa(unescape(encodeURIComponent(cleanedText)))}`
    return { mode: 'data-url', dataUrl, cleanedText, summary: detection.summary, adRanges }
  }

  return { mode: 'manifest-file', cleanedText, summary: detection.summary, adRanges }
}

/**
 * 指纹二次过滤
 */
async function applyFingerprintFilter(
  manifest: JsonPlayurlManifest,
  adTrackIds: Set<string>,
  authHeaders: Record<string, string> | undefined,
  _config: DashAdFilterConfig,
): Promise<Set<string>> {
  const confirmed = new Set<string>()

  for (const trackId of adTrackIds) {
    const track = manifest.tracks.find((t) => t.id === trackId)
    if (!track) continue

    const resolved = resolveTrackFirstSegmentUrl(track)
    if (!resolved) {
      confirmed.add(trackId)
      continue
    }

    const hash = await computeFingerprint(resolved.url, { ...authHeaders, ...resolved.headers })
    if (hash) {
      const lookup = lookupFingerprint(hash)
      if (lookup.isAd) {
        confirmed.add(trackId)
        await incFingerprintHit()
      }
    } else {
      confirmed.add(trackId)
    }
  }

  return confirmed
}

/**
 * 自动学习指纹
 */
async function autoLearnFingerprints(
  manifest: JsonPlayurlManifest,
  adTrackIds: Set<string>,
  authHeaders: Record<string, string> | undefined,
): Promise<void> {
  for (const trackId of adTrackIds) {
    const track = manifest.tracks.find((t) => t.id === trackId)
    if (!track) continue

    const resolved = resolveTrackFirstSegmentUrl(track)
    if (!resolved) continue

    const hash = await computeFingerprint(resolved.url, { ...authHeaders, ...resolved.headers })
    if (hash) {
      await learnFingerprint(hash, {
        adName: `dash-track:${trackId}`,
        source: 'dash-auto-learn',
      })
    }
  }
}

/**
 * MPD XML 指纹二次过滤
 */
async function applyMpdFingerprintFilter(
  mpd: import('./types').MpdManifest,
  adPeriodIds: Set<string>,
  authHeaders: Record<string, string> | undefined,
): Promise<Set<string>> {
  const confirmed = new Set<string>()

  for (const periodId of adPeriodIds) {
    const period = mpd.periods.find((p) => p.id === periodId)
    if (!period) continue

    const resolved = resolvePeriodFirstSegmentUrl(period, mpd)
    if (!resolved) {
      confirmed.add(periodId)
      continue
    }

    const hash = await computeFingerprint(resolved.url, { ...authHeaders, ...resolved.headers })
    if (hash) {
      const lookup = lookupFingerprint(hash)
      if (lookup.isAd) {
        confirmed.add(periodId)
        await incFingerprintHit()
      }
    } else {
      confirmed.add(periodId)
    }
  }

  return confirmed
}

/**
 * MPD XML 自动学习指纹
 */
async function autoLearnMpdFingerprints(
  mpd: import('./types').MpdManifest,
  adPeriodIds: Set<string>,
  authHeaders: Record<string, string> | undefined,
): Promise<void> {
  for (const periodId of adPeriodIds) {
    const period = mpd.periods.find((p) => p.id === periodId)
    if (!period) continue

    const resolved = resolvePeriodFirstSegmentUrl(period, mpd)
    if (!resolved) continue

    const hash = await computeFingerprint(resolved.url, { ...authHeaders, ...resolved.headers })
    if (hash) {
      await learnFingerprint(hash, {
        adName: `dash-period:${periodId}`,
        source: 'dash-auto-learn',
      })
    }
  }
}

/**
 * DRM 检测
 */
export function detectDrm(rawText: string, type: 'json' | 'xml'): { hasDrm: boolean; scheme?: string } {
  if (type === 'xml') {
    const drmPatterns = [
      { pattern: /urn:mpeg:dash:mp4protection:2011/i, scheme: 'cenc' },
      { pattern: /urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed/i, scheme: 'widevine' },
      { pattern: /urn:uuid:9a04f079-9840-4ab8-a5e8-5ab0385f3852/i, scheme: 'playready' },
      { pattern: /urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2/i, scheme: 'fairplay' },
      { pattern: /ContentProtection/i, scheme: 'content-protection' },
    ]
    for (const { pattern, scheme } of drmPatterns) {
      if (pattern.test(rawText)) return { hasDrm: true, scheme }
    }
  } else {
    try {
      const json = JSON.parse(rawText)
      const text = JSON.stringify(json)
      if (/"encrypted"/i.test(text) || /"drm"/i.test(text) || /"contentProtection"/i.test(text)) {
        return { hasDrm: true, scheme: 'json-drm-field' }
      }
    } catch {
      // ignore
    }
  }
  return { hasDrm: false }
}

function extractHost(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

function emptySummary(): DashDetectionSummary {
  return { totalTargets: 0, adTargets: 0, signals: {} }
}