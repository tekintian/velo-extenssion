/**
 * 站点特殊嗅探器 — NDM bg.js + ct.js 100% 移植
 *
 * ## 概述
 * NDM（NeatDownloadManager）扩展针对 YouTube / Vimeo / Facebook / Periscope /
 * GoogleVideo 等站点有专门的嗅探逻辑，因为：
 *   - YouTube 的视频流 URL 在 `googlevideo.com/videoplayback`，但需要从 watch 页 HTML
 *     解析 `"formats"`/`"adaptiveFormats"` JSON 才能拿到完整的下载项列表
 *   - Vimeo 的 progressive MP4 URL 嵌在 `player.vimeo.com/video/{id}/json` 响应中
 *   - Facebook 的视频 URL 嵌在 `facebook.com/video/embed?video_id=ID` 页面 HTML 中
 *   - Periscope 的 HLS URL 在 `api.periscope.tv/api/v2/getAccessPublic` JSON 中
 *   - GoogleVideo 的 `videoplayback` URL 含 `range=` 参数，每个分片是独立 URL，
 *     需要去除 range 参数后才能配对成完整的 DASH 流
 *
 * ## 移植映射表
 *
 * | NDM 函数 | velo 等价物 | 触发条件 |
 * |----------|--------------|----------|
 * | bg.js `W.R` 中 YouTube 分支 | `sniffYouTubeWatchPage` | hostname 匹配 youtube/googlevideo/googleapis/docs.google + path 以 "player" 结尾 + POST + frameId!=0 |
 * | bg.js `W.R` 中 Vimeo 分支 | `sniffVimeoProgressiveJson` | hostname = player.vimeo.com + path 以 /video/ 开头 + Content-Type: application/json |
 * | bg.js `W.R` 中 Periscope 分支（X json 模式） | `sniffPeriscopeJson` | URL 匹配 `^https?://api.periscope.tv/api/v2/getAccessPublic` |
 * | bg.js `W.P` GoogleVideo DASH | `sniffGoogleVideoDash` | hostname 以 googlevideo.com 结尾 + path 含 /videoplayback + CT 是 video/webm 或 audio/webm + URL 含 signature= 或 sig= |
 * | ct.js `ga` Facebook embed | `sniffFacebookEmbed` | 由 content script 在 MutationObserver 检测到 `/videos/{id}/` 链接时调用 |
 * | ct.js `W` YouTube formats 解析 | `parseYouTubeScriptFormats` + `parseAndPushYouTubeFormats` | 由 content script 在 DOMContentLoaded 扫描 `<script>` 标签时调用 |
 * | ct.js Vimeo progressive 解析 | `parseVimeoScriptProgressive` | 由 content script 在 DOMContentLoaded 扫描 `<script>` 标签时调用 |
 *
 * ## 关键移植细节
 *
 * ### 1. YouTube watch 页 fetch
 * - 从 POST body 提取 `"videoId":"xxx"` 中的 xxx
 * - fetch `https://www.youtube.com/watch?v=xxx` HTML
 * - 在 HTML 中找 `"formats":[...]` 和 `"adaptiveFormats":[...]` 两个数组
 * - 跳过含 `"signatureCipher"` 的响应（避免误用加密流）
 * - 调用 `parseAndPushYouTubeFormats` 解析每个数组
 *
 * ### 2. parseAndPushYouTubeFormats（核心解析逻辑）
 * - 解码 `\uXXXX` 转义 + 移除所有反斜杠（NDM `M(a); a.replace(/\\/g, "")`）
 * - 按 `}` 分割条目
 * - 每条目提取 `"url":"..."` 中的 URL
 * - 解析 URL query 参数：`itag`、`dur`、`ei`
 * - URL 必须含 `signature=` 或 `sig=`（已签名 URL，可直接下载）
 * - adaptive（b=true）必须有 `dur`
 * - adaptive 视频 itag 必须在 `YOUTUBE_ADAPTIVE_VIDEO_ITAGS` 表中
 * - adaptive 音频 itag 必须在 `YOUTUBE_ADAPTIVE_AUDIO_ITAGS` 集合中
 * - 非 adaptive itag 必须在 `YOUTUBE_PROGRESSIVE_ITAGS` 表中
 * - adaptive 视/音频共享 `dashGroupId` = `yt-dash-${ei}`（用 ei 配对）
 *
 * ### 3. GoogleVideo DASH
 * - 拆分 URL 为 `baseUrl + query`
 * - 遍历 query 参数：保留 `dur`/`itag`/`ei`/其他，丢弃 `range`/`rbuf`/`rn`
 * - 重建 URL = `baseUrl + '?' + 保留参数 join('&')`
 * - 视频轨 itag 必须在 `YOUTUBE_ADAPTIVE_VIDEO_ITAGS` 表中
 * - 音频轨 itag 必须在 `YOUTUBE_ADAPTIVE_AUDIO_ITAGS` 集合中
 * - 用 ei 作为 dashGroupId 配对
 *
 * ### 4. Facebook embed
 * - fetch `https://www.facebook.com/video/embed?video_id=${videoId}` HTML
 * - 正则匹配 `"sd_src_no_ratelimit":"..."` 和 `"hd_src_no_ratelimit":"..."`（fallback 到 `sd_src`/`hd_src`）
 * - URL 中的 `\/` 转义需替换为 `/`
 * - 推送 HD 为 "MP4 File HQ"，SD 为 "MP4 File LQ"
 *
 * ### 5. Periscope JSON
 * - fetch URL → JSON.parse
 * - 提取 `hls_url`（http）和 `https_hls_url`（https）
 * - 根据 URL 是否 https 选择对应字段
 * - 推送为 HLS m3u8 文件
 */

import { logger } from '@/lib/logger'
import { addMediaItemExternal } from './sniffer'
import type { DashRole } from './types'
import {
  YOUTUBE_PROGRESSIVE_ITAGS,
  isAdaptiveVideoItag,
  isAdaptiveAudioItag,
  getAdaptiveVideoResolution,
} from './youtube-itags'

// ============================================================================
// URL pattern matchers
// ============================================================================

/**
 * YouTube / Google 主机正则（NDM bg.js 行 31-32 base64 解码）
 *
 * NDM 原文：`^(?:[\w-]+\.)*(?:youtube.com|googlevideo.com|youtube.googleapis.com|docs.google.com)$`
 *
 * 匹配：
 *   - youtube.com / www.youtube.com / m.youtube.com
 *   - googlevideo.com / *.googlevideo.com（CDN 子域名）
 *   - youtube.googleapis.com
 *   - docs.google.com
 */
const YOUTUBE_HOST_RE = /^(?:[\w-]+\.)*(?:youtube\.com|googlevideo\.com|youtube\.googleapis\.com|docs\.google\.com)$/i

/**
 * Periscope getAccessPublic URL 正则（NDM bg.js 行 30 base64 解码）
 *
 * NDM 原文：`^https?://api\.periscope\.tv/api/v2/getAccessPublic`
 */
const PERISCOPE_ACCESS_RE = /^https?:\/\/api\.periscope\.tv\/api\/v2\/getAccessPublic/

/**
 * 判断 URL 是否为 YouTube player API POST 请求
 *
 * NDM bg.js 触发条件（行 32）：
 *   - hostname 匹配 YOUTUBE_HOST_RE
 *   - pathname 以 "player" 结尾（如 `/youtubei/v1/player`）
 *   - method === 'POST'
 *   - frameId !== 0（iframe 内的播放器，非顶层）
 *
 * @param url 请求 URL
 * @param method HTTP 方法
 * @param frameId 帧 ID（0 = 顶层）
 */
export function isYouTubePlayerApiPost(url: string, method: string, frameId: number): boolean {
  if (method.toUpperCase() !== 'POST') return false
  if (frameId === 0) return false
  try {
    const u = new URL(url)
    if (!YOUTUBE_HOST_RE.test(u.hostname)) return false
    if (!u.pathname.endsWith('player')) return false
    return true
  } catch {
    return false
  }
}

/**
 * 判断 URL 是否为 Vimeo player JSON 端点
 *
 * NDM bg.js 触发条件（行 33）：
 *   - hostname === 'player.vimeo.com'（精确匹配，非子域名）
 *   - pathname 以 '/video/' 开头
 *   - Content-Type 为 'application/json'
 */
export function isVimeoPlayerJsonUrl(url: string, contentType: string): boolean {
  try {
    const u = new URL(url)
    if (u.hostname !== 'player.vimeo.com') return false
    if (!u.pathname.startsWith('/video/')) return false
    if (!/application\/json/i.test(contentType)) return false
    return true
  } catch {
    return false
  }
}

/**
 * 判断 URL 是否为 Periscope getAccessPublic 端点
 *
 * NDM bg.js 触发条件（行 30）：URL 匹配 PERISCOPE_ACCESS_RE
 */
export function isPeriscopeAccessUrl(url: string): boolean {
  return PERISCOPE_ACCESS_RE.test(url)
}

/**
 * 判断 URL 是否为 GoogleVideo DASH videoplayback（NDM bg.js W.P 触发条件）
 *
 * NDM bg.js 触发条件（行 31）：
 *   - hostname 以 'googlevideo.com' 结尾
 *   - pathname 含 '/videoplayback'
 *
 * NDM W.P 内部条件（行 26-27）：
 *   - Content-Type 为 'video/webm' 或 'audio/webm'
 *   - URL 含 'signature=' 或 'sig='（已签名 URL）
 *
 * @param url 请求 URL
 * @param contentType Content-Type 头
 */
export function isGoogleVideoPlaybackUrl(url: string, contentType: string): boolean {
  try {
    const u = new URL(url)
    if (!u.hostname.endsWith('googlevideo.com')) return false
    if (!u.pathname.includes('/videoplayback')) return false
    const ct = contentType.toLowerCase()
    if (ct !== 'video/webm' && ct !== 'audio/webm') return false
    if (!url.includes('signature=') && !url.includes('sig=')) return false
    return true
  } catch {
    return false
  }
}

// ============================================================================
// 1. YouTube watch page fetch + formats 解析
// ============================================================================

/** YouTube watch 页 URL 前缀（NDM bg.js 行 32 base64 解码） */
const YOUTUBE_WATCH_URL_PREFIX = 'https://www.youtube.com/watch?v='

/**
 * 嗅探 YouTube watch 页 — 提取 formats + adaptiveFormats JSON
 *
 * 移植自 NDM bg.js 行 32-33。
 *
 * @param tabId 当前 tab ID
 * @param requestBody POST 请求体（含 `"videoId":"xxx"`）
 */
export async function sniffYouTubeWatchPage(
  tabId: number,
  requestBody: string | undefined,
): Promise<void> {
  if (!requestBody) {
    logger.info('[site-sniffer] YouTube POST: empty body, skip')
    return
  }

  const videoId = extractYouTubeVideoId(requestBody)
  if (!videoId) {
    logger.info('[site-sniffer] YouTube POST: no videoId found in body')
    return
  }

  const watchUrl = YOUTUBE_WATCH_URL_PREFIX + videoId
  logger.info('[site-sniffer] YouTube watch page fetch: videoId=', videoId)

  let html: string
  try {
    const res = await fetch(watchUrl, {
      credentials: 'include',
      headers: { 'Accept-Language': 'en-US,en;q=0.9' },
      cache: 'no-store',
    })
    if (!res.ok) {
      logger.warn('[site-sniffer] YouTube watch fetch failed:', res.status)
      return
    }
    html = await res.text()
  } catch (e) {
    logger.warn('[site-sniffer] YouTube watch fetch error:', (e as Error).message)
    return
  }

  // NDM bg.js: 跳过含 signatureCipher 的响应
  if (html.indexOf('signatureCipher') >= 0) {
    logger.info('[site-sniffer] YouTube HTML contains signatureCipher, skipping (encrypted streams)')
    return
  }

  // 解析 formats（progressive, combined）和 adaptiveFormats（DASH, video+audio 分轨）
  let pushedCount = 0
  for (let i = 0; i < 2; i++) {
    const key = i === 0 ? 'formats' : 'adaptiveFormats'
    const isAdaptive = i === 1
    const formatsStr = extractJsonArrayForKey(html, key)
    if (!formatsStr) continue
    pushedCount += parseAndPushYouTubeFormats(tabId, formatsStr, isAdaptive)
  }
  logger.info('[site-sniffer] YouTube formats parsed, pushed:', pushedCount, 'items, videoId=', videoId)
}

/**
 * 从 POST body 提取 YouTube videoId
 *
 * NDM bg.js 行 32 实现：
 *   - 找 `"videoId"` 字符串
 *   - 跳过 9 字符（`"videoId"` 长度 9 + 后面紧跟 `:`）
 *   - 实际上 NDM 是 `l.substr(k + 9)` 跳过 `"videoId"`（9 字符）后的内容
 *   - 然后找两个 `"` 之间的内容作为 videoId
 *
 * 注：POST body 是 JSON，格式如 `{"videoId":"abc123","context":{...}}`，
 *     NDM 用字符串搜索而非 JSON.parse，因为 body 可能含尾部碎片。
 *
 * @param postData POST 请求体字符串
 * @returns videoId 或 null
 */
function extractYouTubeVideoId(postData: string): string | null {
  const key = '"videoId"'
  const k = postData.indexOf(key)
  if (k < 0) return null
  const after = postData.slice(k + key.length)
  // 找 videoId 值的起始 `"`
  const openQuote = after.indexOf('"')
  if (openQuote < 0) return null
  // 找 videoId 值的结束 `"`
  const closeQuote = after.indexOf('"', openQuote + 1)
  if (closeQuote < openQuote) return null
  const videoId = after.slice(openQuote + 1, closeQuote)
  return videoId || null
}

/**
 * 从 HTML 中提取指定 key 对应的 JSON 数组字符串
 *
 * NDM bg.js 行 32-33 实现：
 *   - 找 key（如 "formats"）的位置
 *   - 跳到 key 后，找第一个 `[` 和 `]`
 *   - 返回 `[` 和 `]` 之间的内容（不含方括号本身）
 *
 * @param html 完整 HTML 文本
 * @param key JSON 键名（如 'formats' / 'adaptiveFormats'）
 * @returns 数组内容字符串，或 null（未找到 / 顺序错误）
 */
function extractJsonArrayForKey(html: string, key: string): string | null {
  const k = html.indexOf(key)
  if (k < 0) return null
  const after = html.slice(k)
  const open = after.indexOf('[')
  const close = after.indexOf(']')
  if (open < 0 || close < 0 || close <= open) return null
  return after.slice(open + 1, close)
}

/**
 * 解析 YouTube formats 数组字符串并推送媒体项
 *
 * 严格移植 NDM ct.js W() 函数（行 21-24）。
 *
 * ## 解析流程
 * 1. `M(a)` 解码 `\uXXXX` 转义
 * 2. `a.replace(/\\/g, "")` 移除所有反斜杠（`\/` → `/`、`\\` → `\`、`\"` → `"`）
 * 3. `a.split("}")` 按 `}` 分割条目
 * 4. 每条目找 `"url"` 字段，提取 URL
 * 5. 解析 URL query 参数：`itag`、`dur`、`ei`
 * 6. 校验：
 *    - URL 必须含 `signature=` 或 `sig=`（已签名）
 *    - adaptive 必须有 `dur`
 *    - 非 adaptive itag 必须在 `YOUTUBE_PROGRESSIVE_ITAGS` 表中
 *    - adaptive 视频 itag 必须在 `YOUTUBE_ADAPTIVE_VIDEO_ITAGS` 表中
 *    - adaptive 音频 itag 必须在 `YOUTUBE_ADAPTIVE_AUDIO_ITAGS` 集合中
 * 7. 推送媒体项（adaptive 视/音频共享 `dashGroupId`，由 ei 决定）
 *
 * @param tabId 当前 tab ID
 * @param formatsStr formats 数组字符串（不含方括号）
 * @param isAdaptive true = adaptiveFormats (DASH 分轨)；false = formats (progressive combined)
 * @returns 推送的媒体项数量
 */
function parseAndPushYouTubeFormats(
  tabId: number,
  formatsStr: string,
  isAdaptive: boolean,
): number {
  // M(a) + replace(/\\/g, "")
  const decoded = decodeUnicodeEscapes(formatsStr).replace(/\\/g, '')
  const entries = decoded.split('}')
  let pushed = 0

  for (const entry of entries) {
    const trimmed = entry.trim()
    // 跳过不含 itag 的条目
    if (!trimmed || trimmed.indexOf('itag') < 0) continue

    // 提取 "url":"..." 中的 URL
    const url = extractUrlFromEntry(trimmed)
    if (!url) continue

    // URL 必须有 query 部分
    const qIdx = url.indexOf('?')
    if (qIdx < 0) continue

    // 解析 query 参数
    const params = url.slice(qIdx + 1).split('&')
    let itag = 0
    let dur = 0
    let ei = ''

    for (const p of params) {
      if (p.startsWith('itag=')) {
        const v = p.slice(5)
        itag = parseInt(v, 10) || 0
      } else if (p.startsWith('dur=')) {
        const v = p.slice(4)
        dur = parseFloat(v) || 0
      } else if (p.startsWith('ei=')) {
        ei = p.slice(3)
      }
    }

    if (!itag) continue

    // URL 必须含 signature= 或 sig=（NDM 条件：0 < url.indexOf("signature=") || 0 < url.indexOf("sig=")）
    // indexOf > 0 表示存在且不在开头
    if (url.indexOf('signature=') <= 0 && url.indexOf('sig=') <= 0) continue

    if (isAdaptive) {
      // adaptive 必须有 dur
      if (!dur) continue
      const durStr = formatDuration(dur)

      if (isAdaptiveVideoItag(itag)) {
        // adaptive 视频轨
        const res = getAdaptiveVideoResolution(itag)!
        // 用 ei 配对视/音频（同一视频流的视/音频共享 ei）
        const groupId = ei ? `yt-dash-${ei}` : `yt-dash-video-${itag}-${tabId}`
        addMediaItemExternal(tabId, url, `MKV File ${res}, ${durStr}`, 'mkv', {
          dashRole: 'video' as DashRole,
          dashGroupId: groupId,
          contentType: 'video/webm',
        })
        pushed++
      } else if (isAdaptiveAudioItag(itag)) {
        // adaptive 音频轨
        const groupId = ei ? `yt-dash-${ei}` : `yt-dash-audio-${itag}-${tabId}`
        addMediaItemExternal(tabId, url, `MKV File Audio, ${durStr}`, 'm4a', {
          dashRole: 'audio' as DashRole,
          dashGroupId: groupId,
          contentType: 'audio/webm',
        })
        pushed++
      }
      // 其他 itag 跳过（NDM 同样跳过）
    } else {
      // progressive combined — itag 必须在 YOUTUBE_PROGRESSIVE_ITAGS 表中
      const info = YOUTUBE_PROGRESSIVE_ITAGS[itag]
      if (!info) continue
      const durStr = dur ? formatDuration(dur) : ''
      const label = `${info.container} File ${info.resolution}${durStr ? ', ' + durStr : ''}`
      addMediaItemExternal(tabId, url, label, info.container.toLowerCase())
      pushed++
    }
  }

  return pushed
}

/**
 * 从 formats 数组条目中提取 `"url":"..."` 的 URL 值
 *
 * NDM ct.js W() 行 22 实现：
 *   - 找 `"url"` 字符串
 *   - 跳过 5 字符（`"url"` 长度 5）
 *   - 找起始 `"` 和结束 `"`，取两者之间的内容
 *   - decodeURIComponent 解码
 */
function extractUrlFromEntry(entry: string): string | null {
  const key = '"url"'
  const k = entry.indexOf(key)
  if (k < 0) return null
  // NDM: l = h.indexOf('"', l + 5) — 跳过 "url" 后找第一个 "
  const open = entry.indexOf('"', k + key.length)
  if (open < 0) return null
  const close = entry.indexOf('"', open + 1)
  if (close < open) return null
  const raw = entry.slice(open + 1, close)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * 解码 `\uXXXX` 转义为实际字符
 *
 * 移植自 NDM ct.js M() 函数（行 2）。
 */
function decodeUnicodeEscapes(s: string): string {
  return s.replace(/\\u([\d\w]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

/**
 * 格式化时长（秒 → "X min Y sec" / "X sec"）
 *
 * 移植自 NDM ct.js W() 中 timeStr 计算：
 *   60 > h ? h + " sec" : parseInt(h/60) + " min " + (parseInt(h%60) ? parseInt(h%60) + " sec" : "")
 */
function formatDuration(durSec: number): string {
  const h = Math.round(durSec)
  if (h < 60) return `${h} sec`
  const min = Math.floor(h / 60)
  const sec = h % 60
  return sec ? `${min} min ${sec} sec` : `${min} min`
}

// ============================================================================
// 2. Vimeo progressive JSON 解析
// ============================================================================

/**
 * 嗅探 Vimeo progressive MP4 URL
 *
 * 移植自 NDM bg.js 行 33-34。
 *
 * ## 流程
 * 1. fetch player.vimeo.com/video/{id}/json（携带 credentials）
 * 2. JSON.parse
 * 3. 遍历 `request.files.progressive` 数组
 * 4. 每项推送到媒体列表，标签 "MP4 File {quality}"
 *
 * @param tabId 当前 tab ID
 * @param url player.vimeo.com JSON URL
 */
export async function sniffVimeoProgressiveJson(
  tabId: number,
  url: string,
): Promise<void> {
  logger.info('[site-sniffer] Vimeo player JSON fetch:', url.slice(0, 80))
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' })
    if (!res.ok) {
      logger.warn('[site-sniffer] Vimeo fetch failed:', res.status)
      return
    }
    const text = await res.text()

    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      logger.warn('[site-sniffer] Vimeo JSON parse failed')
      return
    }

    const progressive = (json as {
      request?: { files?: { progressive?: Array<{ url: string; quality?: string }> } }
    })?.request?.files?.progressive

    if (!Array.isArray(progressive)) {
      logger.info('[site-sniffer] Vimeo: no progressive array found in JSON')
      return
    }

    let pushed = 0
    for (const p of progressive) {
      if (!p?.url) continue
      const quality = p.quality ?? ''
      const label = `MP4 File ${quality}`.trim()
      addMediaItemExternal(tabId, p.url, label, 'mp4')
      pushed++
    }
    logger.info('[site-sniffer] Vimeo: pushed', pushed, 'progressive items')
  } catch (e) {
    logger.warn('[site-sniffer] Vimeo fetch error:', (e as Error).message)
  }
}

// ============================================================================
// 3. Facebook 视频嵌入抓取
// ============================================================================

/** Facebook embed URL 前缀（NDM ct.js ga 函数） */
const FB_EMBED_URL_PREFIX = 'https://www.facebook.com/video/embed?video_id='

/**
 * 嗅探 Facebook 视频嵌入页 — 提取 sd_src/hd_src
 *
 * 移植自 NDM ct.js ga() 函数（行 18-19）。
 *
 * ## 流程
 * 1. fetch `https://www.facebook.com/video/embed?video_id=${videoId}` HTML
 * 2. 正则匹配 `"sd_src_no_ratelimit":"(.*?)"` 和 `"hd_src_no_ratelimit":"(.*?)"`
 * 3. fallback 到 `"sd_src":"(.*?)"` 和 `"hd_src":"(.*?)"`
 * 4. URL 中的 `\/` 转义替换为 `/`（移除所有 `\`）
 * 5. 推送 HD 为 "MP4 File HQ"，SD 为 "MP4 File LQ"
 *
 * ## 触发场景
 * - content script MutationObserver 检测到 `<a href*="/videos/{id}/">` 链接
 * - content script 提取 videoId 后调 background handler `sniffFacebookEmbed`
 *
 * @param tabId 当前 tab ID
 * @param videoId Facebook 视频 ID（数字字符串）
 */
export async function sniffFacebookEmbed(
  tabId: number,
  videoId: string,
): Promise<void> {
  if (!videoId) return
  const embedUrl = FB_EMBED_URL_PREFIX + videoId
  logger.info('[site-sniffer] Facebook embed fetch: videoId=', videoId)

  try {
    const res = await fetch(embedUrl, { credentials: 'include', cache: 'no-store' })
    if (!res.ok) {
      logger.warn('[site-sniffer] Facebook fetch failed:', res.status)
      return
    }
    const html = await res.text()

    // 优先 _no_ratelimit 版本（无速率限制），fallback 到普通 sd_src/hd_src
    let sd = matchFirst(html, /"sd_src_no_ratelimit":"(.*?)"/) ?? matchFirst(html, /"sd_src":"(.*?)"/)
    let hd = matchFirst(html, /"hd_src_no_ratelimit":"(.*?)"/) ?? matchFirst(html, /"hd_src":"(.*?)"/)

    // URL 中的 \/ 转义 → /（NDM ct.js: e[1].replace(/\\/g, "")）
    if (sd) sd = sd.replace(/\\/g, '')
    if (hd) hd = hd.replace(/\\/g, '')

    if (hd) {
      addMediaItemExternal(tabId, hd, 'MP4 File HQ', 'mp4')
      logger.info('[site-sniffer] Facebook: pushed HD URL')
    }
    if (sd) {
      addMediaItemExternal(tabId, sd, 'MP4 File LQ', 'mp4')
      logger.info('[site-sniffer] Facebook: pushed SD URL')
    }
    if (!hd && !sd) {
      logger.info('[site-sniffer] Facebook: no sd_src/hd_src found in embed HTML')
    }
  } catch (e) {
    logger.warn('[site-sniffer] Facebook fetch error:', (e as Error).message)
  }
}

/** 执行正则匹配并返回第一个捕获组，无匹配返回 null */
function matchFirst(s: string, re: RegExp): string | null {
  const m = re.exec(s)
  return m?.[1] ?? null
}

// ============================================================================
// 4. Periscope JSON 解析
// ============================================================================

/**
 * 嗅探 Periscope getAccessPublic JSON — 提取 hls_url / https_hls_url
 *
 * 移植自 NDM bg.js ha() 函数 json 模式（行 20）。
 *
 * ## 流程
 * 1. fetch api.periscope.tv/api/v2/getAccessPublic?...=...（携带 credentials）
 * 2. JSON.parse
 * 3. 根据 URL 是否 https 选择 https_hls_url 或 hls_url
 * 4. 推送为 HLS m3u8 文件
 *
 * ## NDM 原逻辑
 * ```js
 * var g = 0 == b["2"].indexOf("https"),  // 是否 https
 *     n = JSON.parse(c);
 * n.hls_url && !g && e.push({2: n.hls_url, tags: {}});  // http 时用 hls_url
 * n.https_hls_url && g && e.push({2: n.https_hls_url, tags: {}});  // https 时用 https_hls_url
 * ```
 *
 * @param tabId 当前 tab ID
 * @param url api.periscope.tv URL
 */
export async function sniffPeriscopeJson(
  tabId: number,
  url: string,
): Promise<void> {
  logger.info('[site-sniffer] Periscope JSON fetch:', url.slice(0, 80))
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' })
    if (!res.ok) {
      logger.warn('[site-sniffer] Periscope fetch failed:', res.status)
      return
    }
    const text = await res.text()

    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      logger.warn('[site-sniffer] Periscope JSON parse failed')
      return
    }

    const obj = json as { hls_url?: string; https_hls_url?: string } | null
    if (!obj) return

    // NDM: g = url.startsWith('https')
    const isHttps = url.startsWith('https')
    // https 时用 https_hls_url，http 时用 hls_url
    const targetUrl = isHttps ? obj.https_hls_url : obj.hls_url

    if (!targetUrl) {
      logger.info('[site-sniffer] Periscope: no', isHttps ? 'https_hls_url' : 'hls_url', 'in JSON')
      return
    }

    addMediaItemExternal(tabId, targetUrl, 'HLS File', 'm3u8')
    logger.info('[site-sniffer] Periscope: pushed HLS URL')
  } catch (e) {
    logger.warn('[site-sniffer] Periscope fetch error:', (e as Error).message)
  }
}

// ============================================================================
// 5. GoogleVideo videoplayback DASH URL 解析
// ============================================================================

/**
 * 嗅探 GoogleVideo videoplayback DASH URL — 重建无 range 参数的 URL
 *
 * 移植自 NDM bg.js W.P() 函数（行 26-27）。
 *
 * ## 流程
 * 1. 拆分 URL 为 `baseUrl + query`
 * 2. 遍历 query 参数：
 *    - 保留 `dur`/`itag`/`ei`/其他
 *    - 丢弃 `range`/`rbuf`/`rn`（range 参数使每个分片是独立 URL，无法配对）
 * 3. 提取 `dur` → `du`、`itag` → `ig`、`ei` → `mK`
 * 4. 重建 URL = `baseUrl + '?' + 保留参数 join('&')`
 * 5. 根据 Content-Type 判定 video / audio 轨
 * 6. 视频 itag 必须在 YOUTUBE_ADAPTIVE_VIDEO_ITAGS 表中
 * 7. 音频 itag 必须在 YOUTUBE_ADAPTIVE_AUDIO_ITAGS 集合中
 * 8. 用 ei 作为 dashGroupId 配对视/音频
 *
 * ## 为什么需要重建 URL
 * GoogleVideo 的 videoplayback URL 含 `range=start-end` 参数，每个分片是独立的 URL。
 * 如果直接嗅探，每个分片都会被添加为一个媒体项，用户看到几十个相同视频的分片。
 * 去除 range 参数后，所有分片归并为一个 URL，可以作为完整的 DASH 流下载。
 *
 * @param tabId 当前 tab ID
 * @param url googlevideo.com/videoplayback URL
 * @param contentType video/webm 或 audio/webm
 */
export function sniffGoogleVideoDash(
  tabId: number,
  url: string,
  contentType: string,
): void {
  // NDM W.P: 必须有 query 部分
  const qIdx = url.indexOf('?')
  if (qIdx < 0) return

  const baseUrl = url.slice(0, qIdx)
  const params = url.slice(qIdx + 1).split('&')

  let dur = 0
  let itag = 0
  let ei = ''
  const keptParams: string[] = []

  for (const p of params) {
    if (p.startsWith('dur=')) {
      dur = parseFloat(p.slice(4)) || 0
      keptParams.push(p)
    } else if (p.startsWith('itag=')) {
      const v = p.slice(5)
      itag = parseInt(v, 10) || 0
      keptParams.push(p)
    } else if (p.startsWith('ei=')) {
      ei = p.slice(3)
      keptParams.push(p)
    } else if (p.startsWith('range=') || p.startsWith('rbuf=') || p.startsWith('rn=')) {
      // NDM W.P: 丢弃 range/rbuf/rn 参数（这些是分片范围参数，阻止 DASH 配对）
      continue
    } else {
      keptParams.push(p)
    }
  }

  // NDM W.P: 必须 dur && itag
  if (!dur || !itag) {
    logger.info('[site-sniffer] GoogleVideo DASH: missing dur/itag, skip')
    return
  }

  const rebuiltUrl = baseUrl + '?' + keptParams.join('&')
  // mme = Content-Type 的第一段（"video" 或 "audio"）
  const mme = contentType.split('/')[0]?.toLowerCase() ?? ''
  const durStr = formatDuration(dur)

  if (mme === 'video' && isAdaptiveVideoItag(itag)) {
    const res = getAdaptiveVideoResolution(itag)!
    // 用 ei 配对视/音频（同一视频流的视/音频共享 ei）
    const groupId = ei ? `gv-dash-${ei}` : `gv-dash-video-${itag}-${tabId}`
    addMediaItemExternal(tabId, rebuiltUrl, `MKV File ${res}, ${durStr}`, 'mkv', {
      dashRole: 'video' as DashRole,
      dashGroupId: groupId,
      contentType: 'video/webm',
    })
    logger.info('[site-sniffer] GoogleVideo DASH video: itag=', itag, 'res=', res, 'dur=', dur)
  } else if (mme === 'audio' && isAdaptiveAudioItag(itag)) {
    const groupId = ei ? `gv-dash-${ei}` : `gv-dash-audio-${itag}-${tabId}`
    addMediaItemExternal(tabId, rebuiltUrl, `MKV File Audio, ${durStr}`, 'm4a', {
      dashRole: 'audio' as DashRole,
      dashGroupId: groupId,
      contentType: 'audio/webm',
    })
    logger.info('[site-sniffer] GoogleVideo DASH audio: itag=', itag, 'dur=', dur)
  } else {
    logger.info('[site-sniffer] GoogleVideo DASH: itag', itag, 'not in adaptive tables, skip')
  }
}

// ============================================================================
// 6. <script> 标签内嵌 formats 解析（content script 调用）
// ============================================================================

/**
 * 解析 YouTube 页面 <script> 标签中的 formats/adaptiveFormats JSON 数组
 *
 * 移植自 NDM ct.js za() 函数（行 19-23）YouTube 分支。
 *
 * ## 触发场景
 * content script 在 DOMContentLoaded 时扫描所有 `<script>` 标签 innerText，
 * 若发现含 `"itag"` 且不含 `"signatureCipher"` 的脚本，发送给 background
 * 调用本函数解析。
 *
 * ## 与 sniffYouTubeWatchPage 的关系
 * - sniffYouTubeWatchPage：被动触发（player API POST 后），主动 fetch watch 页
 * - parseYouTubeScriptFormats：主动扫描（DOMContentLoaded），从已加载的页面脚本提取
 *
 * 两者互补：用户直接打开 watch 页时不会触发 player API POST，
 * 此时 content script 的扫描能捕获到 formats。
 *
 * @param tabId 当前 tab ID
 * @param scriptText 单个 <script> 标签的 innerText
 * @returns 是否成功解析出至少一个媒体项
 */
export function parseYouTubeScriptFormats(
  tabId: number,
  scriptText: string,
): boolean {
  if (scriptText.indexOf('itag') < 0) return false
  // NDM ct.js: 跳过含 signatureCipher 的脚本（加密流无法直接下载）
  if (scriptText.indexOf('signatureCipher') >= 0) return false

  let totalPushed = 0
  for (let i = 0; i < 2; i++) {
    const key = i === 0 ? 'formats' : 'adaptiveFormats'
    const isAdaptive = i === 1
    const formatsStr = extractJsonArrayForKey(scriptText, key)
    if (!formatsStr) continue
    totalPushed += parseAndPushYouTubeFormats(tabId, formatsStr, isAdaptive)
  }

  if (totalPushed > 0) {
    logger.info('[site-sniffer] YouTube script scan: pushed', totalPushed, 'items from <script> tags')
  }
  return totalPushed > 0
}

/**
 * 解析 Vimeo 页面 <script> 标签中的 progressive JSON 数组
 *
 * 移植自 NDM ct.js za() 函数（行 19-22）Vimeo 分支。
 *
 * ## 触发场景
 * content script 在 DOMContentLoaded 时扫描所有 `<script>` 标签 innerText，
 * 若 hostname 含 "vimeo" 且脚本含 `"progressive":\s*\[`，发送给 background
 * 调用本函数解析。
 *
 * ## 解析流程
 * 1. 找 `"progressive"` 位置
 * 2. 从该位置向后找 `]`
 * 3. 截取 `"progressive":[...]` 子串
 * 4. 用 `{...}` 包裹后 JSON.parse
 * 5. 遍历 `progressive` 数组，推送每项为 MP4 媒体
 *
 * @param tabId 当前 tab ID
 * @param scriptText 单个 <script> 标签的 innerText
 * @returns 是否成功解析出至少一个媒体项
 */
export function parseVimeoScriptProgressive(
  tabId: number,
  scriptText: string,
): boolean {
  // NDM ct.js: p = new RegExp('"progressive":\\s*\\[')
  const re = /"progressive":\s*\[/
  if (!re.test(scriptText)) return false

  const start = scriptText.indexOf('"progressive"')
  if (start < 0) return false
  const close = scriptText.indexOf(']', start)
  if (close < 0) return false

  // NDM ct.js: e = e.substr(f, g - f + 1) — 从 "progressive" 到 ]（含）
  const slice = scriptText.slice(start, close + 1)

  let json: unknown
  try {
    // NDM ct.js: JSON.parse("{" + e + "}")
    json = JSON.parse('{' + slice + '}')
  } catch {
    return false
  }

  const progressive = (json as { progressive?: Array<{ url: string; quality?: string }> })?.progressive
  if (!Array.isArray(progressive)) return false

  let pushed = 0
  for (const p of progressive) {
    if (!p?.url) continue
    const quality = p.quality ?? ''
    const label = `MP4 File ${quality}`.trim()
    addMediaItemExternal(tabId, p.url, label, 'mp4')
    pushed++
  }
  if (pushed > 0) {
    logger.info('[site-sniffer] Vimeo script scan: pushed', pushed, 'progressive items')
  }
  return pushed > 0
}