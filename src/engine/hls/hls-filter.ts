/**
 * HLS 广告分片过滤 — 主入口
 *
 * 移植自 NDM ad-filter.js processPlaylist
 *
 * 算法分层：
 *   1) parsePlaylist()      — 完整解析 m3u8
 *   2) detectAds()          — 7 信号加权识别广告分片
 *   3) [可选] fingerprint   — 指纹库二次过滤（无标签但内容是广告）
 *   4) rebuildPlaylist()    — 剔除广告后重建 m3u8
 *   5) processPlaylist()    — 对外入口，返回 {mode, url|segments|cleaned, report}
 */

import { detectAds } from './ad-detector'
import { computeFingerprint, initFingerprint, learnFingerprint, lookupFingerprint } from './fingerprint'
import { getSiteRule } from './hls-rules'
import { isMasterPlaylist, parseMasterPlaylist, parsePlaylist } from './playlist-parser'
import { rebuildPlaylist } from './playlist-rebuilder'
import type { AdFilterConfig, ProcessResult } from './types'
import { logger } from '@/lib/logger'

/** 默认 URL 广告正则 */
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

/** 默认配置 */
export const DEFAULT_CONFIG: AdFilterConfig = {
  enabled: true,
  mode: 'm3u8-file', // 保存清洗后 m3u8（绝对 URL）为本地文件，ffmpeg/Motrix 下载合并
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

/**
 * 构建运行时配置（合并默认 + 用户 + 站点规则）
 */
export async function buildConfig(
  userConfig: Partial<AdFilterConfig>,
  pageHostOrUrl: string,
): Promise<AdFilterConfig> {
  const base: AdFilterConfig = { ...DEFAULT_CONFIG, ...userConfig }

  // 站点规则叠加（pageHost 需与花样域/站点清单使用同一 host 口径）
  const ruleHost = toRuleHost(pageHostOrUrl)
  const { rule, patterns: sitePatterns, forceKeep } = await getSiteRule(ruleHost)

  // 合并 URL 正则：默认 + 用户 + 站点规则
  const userPats = base.urlPatterns
    .map((s) => {
      try {
        return new RegExp(s, 'i')
      } catch {
        return null
      }
    })
    .filter((p): p is RegExp => p !== null)

  const allPatterns = [...DEFAULT_AD_URL_PATTERNS, ...userPats, ...sitePatterns]

  // 站点规则可覆盖阈值与模式
  const scoreThreshold = rule?.scoreThreshold ?? base.scoreThreshold
  const mode = (rule?.mode as import('./types').AdDeliveryMode | undefined) ?? base.mode

  return {
    ...base,
    scoreThreshold,
    mode,
    _patterns: allPatterns,
    _forceKeep: forceKeep,
    _appliedRule: rule,
  }
}

/** 把 pageHost / pageUrl 统一成 host 口径 */
function toRuleHost(input: string): string {
  if (!input) return ''
  try {
    return new URL(input).hostname.toLowerCase()
  } catch {
    return input.toLowerCase()
  }
}

/**
 * 对外主入口 — 给定 m3u8 文本 + 基准 URL，产出清洗结果
 *
 * @param text      m3u8 原文
 * @param baseUrl   用于解析相对 URL 的基准
 * @param pageUrl   观看页 URL（提取 host 用于站点规则匹配，由 buildConfig 已处理，此处保留参数兼容）
 * @param config    已构建的运行时配置（含 _patterns / _forceKeep / _appliedRule）
 * @param authHeaders 可选认证头（Cookie/User-Agent 等），传递给 computeFingerprint 的 fetch
 */
export async function processPlaylist(
  text: string,
  baseUrl: string,
  pageUrl: string,
  config: AdFilterConfig,
  authHeaders?: Record<string, string>,
): Promise<ProcessResult> {
  void pageUrl // pageHost 已在 buildConfig 阶段处理
  if (!config.enabled) {
    return { mode: 'disabled', url: baseUrl, report: null }
  }

  const appliedRule = config._appliedRule ?? null

  // master 播放列表：广告在子（variant）播放列表里，这里不下手，由递归处理
  if (isMasterPlaylist(text)) {
    const variants = parseMasterPlaylist(text, baseUrl)
    if (config.logToConsole) {
      logger.info('[HLS-AdFilter] master playlist', baseUrl, '→', variants.length, 'variants (recurse)', appliedRule ? `· rule=${appliedRule.id}` : '')
    }
    return {
      mode: 'master',
      url: baseUrl,
      report: { master: true, variants: variants.length, appliedRule },
    }
  }

  const parsed = parsePlaylist(text, baseUrl)
  const detection = detectAds(parsed, config)

  // 指纹库二次过滤：对未被标签信号命中的分片，取首 64KB SHA-256 查库
  // threshold=0 = 用户明确要求不过滤（detectAds 已早返回空，指纹库也不跑）
  if (config.scoreThreshold > 0 && config.enableFingerprint && config.fingerprintMode !== 'off') {
    await initFingerprint(config.remoteFingerprintsUrl)

    // 多数派 origin（suspicious-only 模式判定跨域用）
    const oc = new Map<string, number>()
    for (const s of parsed.segments) {
      try {
        const u = new URL(s.url)
        oc.set(u.origin, (oc.get(u.origin) ?? 0) + 1)
      } catch {
        // ignore
      }
    }
    let majO: string | null = null
    for (const [o, c] of oc) {
      if (majO === null || c > (oc.get(majO) ?? 0)) majO = o
    }

    // 选候选：未被判广告 + 满足 suspicious 条件
    const candidates = parsed.segments.filter((s) => {
      if (detection.adSegments.has(s.index)) return false
      if (config.fingerprintMode === 'all') return true
      if (config.fingerprintMode === 'suspicious-only') {
        if (s.discontinuity) return true
        try {
          const u = new URL(s.url)
          if (majO && u.origin !== majO) return true
        } catch {
          // ignore
        }
      }
      return false
    })

    const cap = Math.min(candidates.length, config.maxFingerprintPerPlaylist || 9999)
    if (config.logToConsole && candidates.length > 0) {
      logger.info('[HLS-AdFilter] fp pass:', config.fingerprintMode, 'candidates:', candidates.length, 'cap:', cap)
    }

    // 并行化：10 个一批
    const batchSize = 10
    for (let bi = 0; bi < cap; bi += batchSize) {
      const batch = candidates.slice(bi, Math.min(bi + batchSize, cap))
      const hashes = await Promise.all(batch.map((s) => computeFingerprint(s.url, authHeaders)))
      for (let hi = 0; hi < batch.length; hi++) {
        const hit = hashes[hi] ? lookupFingerprint(hashes[hi]!) : null
        if (hit && hit.isAd) {
          detection.adSegments.add(batch[hi]!.index)
          detection.reasons.set(batch[hi]!.index, [
            `fingerprint-match(${hit.adName ?? hit.source ?? 'lib'})`,
          ])
        }
      }
    }

    // 重算 report（指纹可能新增广告）
    let ad2 = 0
    let con2 = 0
    for (const s of parsed.segments) {
      if (detection.adSegments.has(s.index)) ad2 += s.duration
      else con2 += s.duration
    }
    detection.report = {
      ...detection.report,
      ads: detection.adSegments.size,
      adDuration: Math.round(ad2),
      contentDuration: Math.round(con2),
    }

    // auto-learn：对已被判广告的分片记录指纹入库
    if (config.autoLearnFingerprints) {
      const learnList = parsed.segments.filter((s) => detection.adSegments.has(s.index))
      const lcap = Math.min(learnList.length, config.maxFingerprintPerPlaylist || 9999)
      let learnedNew = 0
      for (let lb = 0; lb < lcap; lb += batchSize) {
        const lbatch = learnList.slice(lb, Math.min(lb + batchSize, lcap))
        const lhashes = await Promise.all(lbatch.map((s) => computeFingerprint(s.url, authHeaders)))
        for (let lh = 0; lh < lbatch.length; lh++) {
          if (lhashes[lh]) {
            const added = await learnFingerprint(lhashes[lh]!, {
              adName: `auto:${appliedRule ? appliedRule.id : 'unknown'}`,
              source: 'auto-learned',
            })
            if (added) learnedNew++
          }
        }
      }
      if (config.logToConsole && learnedNew > 0) {
        logger.info('[HLS-AdFilter] auto-learned', learnedNew, 'new ad fingerprints')
      }
    }
  }

  // 无广告
  if (detection.report.ads === 0) {
    if (config.logToConsole) {
      logger.info('[HLS-AdFilter] no ads in', baseUrl, '(total segs:', detection.report.total, ')', appliedRule ? `· rule=${appliedRule.id}` : '')
    }
    return {
      mode: 'no-ads',
      url: baseUrl,
      report: detection.report,
      segments: parsed.segments,
    }
  }

  // 导出 reasons + adSegmentUrls
  const reasonsExport: Record<number, string[]> = {}
  const adSegmentUrls: string[] = []
  for (const [idx, rs] of detection.reasons) {
    reasonsExport[idx] = rs
    const seg = parsed.segments.find((s) => s.index === idx)
    if (seg) adSegmentUrls.push(seg.url)
  }

  // 广告时间区间（原始时间轴坐标，含广告分片在内累加）
  // 页面播放与下载推送是两条独立路径：
  //   下载推送 → 使用 cleaned 列表，广告分片已被物理剔除
  //   页面播放 → 若播放器拿到的是原始列表，广告仍在时间轴上，必须按此区间 seek 跳过
  // 因此各模式都返回原始坐标区间，由 badge 依据视频实际时长判定时间轴是否已清洗
  const adRanges = computeAdRangesFromSegments(parsed.segments, detection.adSegments)

  if (config.logToConsole) {
    logger.info(
      `[HLS-AdFilter] ${detection.report.ads}/${detection.report.total} ad segs in`,
      baseUrl,
      `(ad ${detection.report.adDuration}s, content ${detection.report.contentDuration}s)`,
      appliedRule ? `· rule=${appliedRule.id}` : '',
    )
    for (const [idx, rs] of detection.reasons) {
      const seg = parsed.segments.find((s) => s.index === idx)
      logger.info(`  • ad seg#${idx}`, seg ? seg.url : '?', rs)
    }
  }

  if (config.mode === 'passthrough') {
    return {
      mode: 'passthrough',
      url: baseUrl,
      report: detection.report,
      reasons: reasonsExport,
      adSegmentUrls,
      segments: parsed.segments,
      adRanges,
    }
  }

  // m3u8-file / data-url 都需要 cleaned m3u8 文本
  const cleaned = rebuildPlaylist(parsed, detection.adSegments, baseUrl, config)

  if (config.mode === 'm3u8-file') {
    return {
      mode: 'm3u8-file',
      cleaned,
      report: detection.report,
      reasons: reasonsExport,
      adSegmentUrls,
      segments: parsed.segments,
      adRanges,
    }
  }

  // 默认 data-url（不用 unescape，SW 环境可能无 unescape）
  const b64 = base64Encode(cleaned)
  const dataUrl = `data:application/vnd.apple.mpegurl;base64,${b64}`
  return {
    mode: 'data-url',
    url: dataUrl,
    cleaned,
    report: detection.report,
    reasons: reasonsExport,
    adSegmentUrls,
    segments: parsed.segments,
    adRanges,
  }
}

/**
 * master 播放列表递归处理 — 广告都在变体媒体列表里，主列表本身只有索引
 *
 * 站点常见结构：播放器先拿 index.m3u8（master，几十字节），再按带宽拉取
 * 实际分片列表。只检测 master 永远得到 "0 广告"，因此必须下钻变体。
 *
 * 选片策略：优先带宽最高的变体（分辨率最高、广告信号最完整），
 * 失败则依次回退到其余变体；全部失败返回 null，调用方按无广告处理。
 *
 * @param masterText    master m3u8 原文
 * @param masterUrl     master 的绝对 URL（解析变体相对路径的基准）
 * @param pageUrl       观看页 URL
 * @param config        运行时配置
 * @param authHeaders   认证头（Cookie/Referer/UA 等）
 * @param fetcher       拉取文本的注入函数（便于单测；默认 fetch）
 */
export async function processMasterPlaylist(
  masterText: string,
  masterUrl: string,
  pageUrl: string,
  config: AdFilterConfig,
  authHeaders?: Record<string, string>,
  fetcher?: (url: string) => Promise<string>,
): Promise<ProcessResult | null> {
  const selected = await resolveMediaVariant(masterText, masterUrl, config, authHeaders, fetcher)
  if (!selected) return null
  return await processPlaylist(selected.text, selected.url, pageUrl, config, authHeaders)
}

/** 解析 master 并下钻到实际媒体列表（返回选中变体的地址与原文） */
export async function resolveMediaVariant(
  masterText: string,
  masterUrl: string,
  config: AdFilterConfig,
  authHeaders?: Record<string, string>,
  fetcher?: (url: string) => Promise<string>,
): Promise<{ url: string; text: string } | null> {
  const variants = parseMasterPlaylist(masterText, masterUrl)
  if (variants.length === 0) return null

  const ordered = [...variants].sort((a, b) => b.bandwidth - a.bandwidth)
  const fetchText = fetcher ?? ((url: string) => fetchPlaylistText(url, authHeaders))

  for (const variant of ordered) {
    try {
      const text = await fetchText(variant.url)
      if (!text || !/#EXTINF:/i.test(text)) continue
      if (config.logToConsole) {
        logger.info('[HLS-AdFilter] master variant chosen:', variant.url, 'bw:', variant.bandwidth)
      }
      return { url: variant.url, text }
    } catch (e) {
      logger.warn('[HLS-AdFilter] master variant fetch failed:', variant.url, (e as Error).message)
    }
  }
  return null
}

/** 拉取 m3u8 文本（带认证头，供 master 变体下钻使用） */
async function fetchPlaylistText(
  url: string,
  authHeaders?: Record<string, string>,
): Promise<string> {
  const init: RequestInit = { cache: 'no-store' }
  if (authHeaders && Object.keys(authHeaders).length > 0) init.headers = authHeaders
  const resp = await fetch(url, init)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return await resp.text()
}

/** 兼容性 base64 编码（非浏览器环境） */
function base64Encode(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return typeof Buffer !== 'undefined'
    ? Buffer.from(bin, 'binary').toString('base64')
    : btoa(bin)
}

/** 内部用：计算广告时间区间 */
function computeAdRangesFromSegments(
  segments: readonly { index: number; duration: number }[],
  adSet: Set<number>,
): Array<{ start: number; end: number; duration: number }> {
  const ranges: Array<{ start: number; end: number; duration: number }> = []
  if (segments.length === 0 || adSet.size === 0) return ranges
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

/** 重新导出子模块（便于测试） */
export * from './playlist-parser'
export * from './ad-detector'
export * from './playlist-rebuilder'
export * from './hls-rules'
export * from './fingerprint'
export type { SiteRule } from './types'