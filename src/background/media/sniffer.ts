/**
 * 媒体嗅探 — webRequest 拦截层
 *
 * 照搬 NDM bg.js 策略：嗅探所有可能的音视频资源，不预过滤
 * NDM 原版能嗅探任何 .mp4/.mkv/.mp3/.m3u8/.ts 等，用户手动选择下载
 *
 * 判定：满足任一条件即嗅探
 *   - 扩展名在 NDM 的 B 正则（媒体扩展名，含 TS）
 *   - Content-Disposition: attachment
 *   - Content-Type 是 video/audio/强制下载
 *   - m3u8 播放列表（视频流入口）
 *
 * 跳过：HTML/CSS/JS/图片/字体/JSON/manifest/favicon 等页面资源
 */

import { logger } from '@/lib/logger'
import { extractBaseName } from '@/lib/naming'
import type { MediaItem, DashPair, DashRole } from './types'
import { buildConfig, DEFAULT_CONFIG, processPlaylist } from '@/engine/hls/hls-filter'
import { persistentStorage } from '@/lib/storage'
import { settingsStore } from '@/lib/storage'
import { DEFAULT_SETTINGS } from '@/types'
import {
  isYouTubePlayerApiPost,
  isVimeoPlayerJsonUrl,
  isPeriscopeAccessUrl,
  isGoogleVideoPlaybackUrl,
  sniffYouTubeWatchPage,
  sniffVimeoProgressiveJson,
  sniffPeriscopeJson,
  sniffGoogleVideoDash,
} from './site-sniffers'
import { extFromContentType, mimeFromExt } from './mime-table'
import { isNonMediaDownloadExt } from './download-whitelist'
import { parseRequestBody } from './post-body-parser'
import { getDeleteKeyDown } from './delete-key-state'
import { sendToDownloadClient, getPushClient, getCachedDownloadConfig } from './download-client'

/** NDM 的 B 正则：媒体扩展名（嗅探所有音视频，但 .ts 分片除外 — 太多无意义） */
const MEDIA_EXT_RE = /^(?:FLV|SWF|MP3|MP4|M4V|F4F|F4V|M4A|M4S|MPG|MPEG|MPEG4|MPE|AVI|WMV|WMA|WAV|WAVE|ASF|RM|RAM|OGG|OGV|OGM|OGA|MOV|MID|MIDI|3GP|3GPP|QT|WEBM|TS|MKV|AAC|MP2T|MPEGTS|RMVB|VTT|SRT|M3U8|M3U)$/i

/** 非下载的页面资源扩展名 */
const NON_DOWNLOAD_EXT_RE = /^(?:HTM|HTML|MHT|MHTML|SHTML|SHTM|XHT|XHTM|XHTML|XML|TXT|CSS|JS|JSON|GIF|ICO|JPEG|JPG|PNG|WEBP|BMP|SVG|TIF|TIFF|PDF|PHP|ASP|ASPX|EOT|TTF|WOF|WOFF|WOFF2|MSG|PEM|BR|OTF|ACZ|AZC|CGI|TPL|OSD|DO|DICT)$/i

/**
 * NDM 的 da 正则：强制走 HLS 解析路径的扩展名
 *
 * NDM bg.js: `da=/^(?:F4F|MPEGTS|TS|MP2T)$/i`
 *
 * 这些扩展名虽然单独看是分片（.ts），但 NDM 视为 HLS 流的标志：
 *   - F4F: Adobe Flash HTTP Dynamic Streaming 分片
 *   - MPEGTS / TS: MPEG-2 Transport Stream，HLS 标准分片格式
 *   - MP2T: video/mp2t MIME 对应扩展名
 *
 * NDM 在 onHeadersReceived 用 `da.test(b.i)` 判断是否为 HLS 流。
 * velo-extension 旧实现只判断 'ts' 单一字符串，遗漏 F4F/MPEGTS/MP2T。
 */
const HLS_STREAMING_EXT_RE = /^(?:F4F|MPEGTS|TS|MP2T)$/i

/**
 * NDM 的 ba 数组：HTTP 重定向状态码（移植自 NDM bg.js `ba=[301,302,303,307,308]`）
 *
 * 这些状态码表示资源已重定向，应跳过嗅探（让浏览器跟随重定向到最终 URL 再嗅探）。
 * 避免对中间重定向响应重复触发 addMediaItem 导致重复嗅探。
 */
const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

/**
 * webRequest URL 过滤器（移植自 NDM bg.js）
 *
 * NDM bg.js:
 *   - onBeforeRequest: ['http', 'https', 'ftp'] all sub-paths
 *   - onHeadersReceived: all_urls（但我们用显式列表，便于审阅）
 *
 * velo-extension 增加 file scheme 以嗅探本地文件（NDM 未做但 task 要求）。
 */
const URL_FILTERS = [
  'http://*/*',
  'https://*/*',
  'ftp://*/*',
  'file:///*',
] as const

/** 强制下载的 Content-Type（不通过扩展名也能识别为下载） */
const FORCE_DOWNLOAD_CT_RE = /^(?:application\/x-apple-diskimage|application\/download|application\/force-download|application\/x-mveloload|binary\/octet-stream)$/i

/**
 * 页面类 Content-Type — 表示服务端返回的是 HTML/文本页面，不是真实文件下载
 *
 * 当 CT 命中此正则且无 Content-Disposition: attachment 时，即使 URL 扩展名在
 * 白名单中（如 .rar/.zip），也应跳过嗅探——这是"伪下载 URL"场景：
 * URL 路径带文件扩展名但实际返回 HTML 引导页（如 megaup.net、mediafire 等），
 * 真实下载链接嵌在页面内需用户点击。
 *
 * 不含 application/octet-stream：该 CT 虽然通用但确实表示二进制下载，
 * 且很多 CDN/对象存储对真实文件返回 octet-stream。
 */
const PAGE_CONTENT_TYPE_RE = /^(?:text\/html|text\/x-html|application\/xhtml\+xml|text\/xml|application\/xml|text\/plain(?:;\s*charset=utf-8)?)$/i

/** per-tab 媒体列表 */
const tabMediaMap = new Map<number, MediaItem[]>()

/**
 * 最近自动推送的非媒体下载 URL（移植自 NDM bg.js this.u）
 *
 * NDM V.V: 非媒体下载命中时设置 this.u = b["2"]（URL），然后推送 WebSocket
 * NDM V.X: downloads.onCreated 中若 URL 匹配 this.u 则 cancel + erase
 *
 * velo 用途：onHeadersReceived 检测到非媒体下载（白名单/attachment/force-download）
 * 时设置此变量，downloads.onCreated 中匹配则取消浏览器下载条目
 *
 * 使用 Set 存储最近推送的 URL 集合（含重定向链），避免重定向前后 URL 不匹配导致取消失败
 */
const pushedUrlSet = new Set<string>()
let lastPushedUrl = ''

/** 最大保留数 */
const MAX_PER_TAB = 100

/** per-tab 页面代际计数器：SPA 路由变化时递增，在途请求携带旧代际号会被丢弃 */
const tabGenerationMap = new Map<number, number>()

interface PendingRequest {
  readonly url: string
  readonly method: string
  readonly resourceType: string
  readonly tabId: number
  readonly frameId: number
  /** 请求发起时的页面代际号 */
  readonly generation: number
  /** Delete 键是否按下（onBeforeSendHeaders 阶段快照，移植自 NDM bg.js `b.isKeyDown = B`） */
  readonly isKeyDown: boolean
  /** 协议（http/https/ftp），用于 FTP 单独路径（NDM bg.js W.N） */
  readonly protocol: string
  /**
   * Chrome 原始 requestBody 对象（onBeforeRequest 阶段保存，onBeforeSendHeaders 阶段重解析）
   *
   * 因为 onBeforeSendHeaders 没有 requestBody 字段，但 formData 模式需要 Content-Type
   * 才能正确解析（boundary / urlencoded 编码），所以保留原始对象供 onBeforeSendHeaders
   * 在拿到 Content-Type 后重新调用 parseRequestBody。
   */
  readonly rawRequestBody?: { readonly error?: string; readonly formData?: { readonly [key: string]: readonly (string | ArrayBuffer)[] }; readonly raw?: readonly { readonly bytes?: ArrayBuffer }[] } | undefined
  /** 请求体（完整解析 multipart/urlencoded，移植自 NDM bg.js `ia()` 函数） */
  readonly requestBody?: string | undefined
  /** 请求体 MIME 类型（POST 时为 Content-Type，用于 multipart boundary 恢复） */
  readonly requestBodyContentType?: string | undefined
  /** 请求头（含 User-Agent / x-* / authorization / accept / accept-language） */
  readonly requestHeaders?: Record<string, string> | undefined
}

const pendingRequests = new Map<string, PendingRequest>()

type M3u8ProcessHandler = (
  m3u8Url: string,
  tabId: number,
  sniffedHeaders?: Record<string, string>,
) => Promise<void>

let _m3u8ProcessHandler: M3u8ProcessHandler | null = null

export function setM3u8ProcessHandler(handler: M3u8ProcessHandler | null): void {
  _m3u8ProcessHandler = handler
}

let initialized = false
let onBeforeRequestListener: ((details: chrome.webRequest.OnBeforeRequestDetails) => chrome.webRequest.BlockingResponse | undefined) | null = null
let onBeforeSendHeadersListener: ((details: chrome.webRequest.OnBeforeSendHeadersDetails) => undefined) | null = null
let onHeadersReceivedListener: ((details: chrome.webRequest.OnHeadersReceivedDetails) => undefined) | null = null

export function startSniffer(): void {
  if (initialized) return
  initialized = true

  onBeforeRequestListener = (details: chrome.webRequest.OnBeforeRequestDetails): chrome.webRequest.BlockingResponse | undefined => {
    if (details.tabId < 0 || details.frameId < 0) return undefined
    if (!details.url) return undefined

    const protocol = getProtocol(details.url)

    // === FTP 协议嗅探（NDM bg.js W.N 行 266-271 100% 移植） ===
    // NDM: if ("ftp" == R(a.url)) { if (K(a.url) && !B) { ...this.I(b); return {redirectUrl:"javascript:"} } }
    //
    // Chrome 已弃用原生 FTP，但扩展仍能拦截 ftp:// URL。我们把 FTP URL 当作
    // 普通下载项推送到 tabMediaMap（task 要求：将 FTP URL 当作普通下载项推送）。
    //   - 解析 URL 末段为 fileName（NDM K 函数：aa 正则提取 path 末段）
    //   - 取扩展名匹配 NDM H 正则 或 非媒体下载白名单
    //   - 命中即 addMediaItemExternal
    //   - Delete 键按下：不推送（让浏览器尝试打开 FTP 目录）
    //   - 不返回 redirectUrl（Chrome 不主动下载 FTP，无需取消）
    if (protocol === 'ftp') {
      if (getDeleteKeyDown()) return undefined
      handleFtpOrFileRequest(details, 'ftp')
      return undefined
    }

    // === file:// 本地文件嗅探（task 要求） ===
    // 与 FTP 同理：从 URL 解析 fileName + ext，推送到 tabMediaMap。
    // 不返回 redirectUrl（file:// 浏览器不会主动下载，只是页面加载）。
    if (protocol === 'file') {
      if (getDeleteKeyDown()) return undefined
      handleFtpOrFileRequest(details, 'file')
      return undefined
    }

    // === http/https 协议：记录 pending request ===
    // NDM bg.js W.N else 分支：b=a.requestId; c=this.j[b]||{...}; "POST"==method && (c.ea=requestBody); c.isKeyDown=B
    //
    // 这里我们保存原始 requestBody 对象供 onBeforeSendHeaders 阶段重解析
    // （formData 模式需要 Content-Type 才能正确解析 boundary / urlencoded 编码）
    if (protocol !== 'http' && protocol !== 'https') return undefined

    let requestBody: string | undefined
    const rawRequestBody = details.requestBody
    if (details.method === 'POST' && rawRequestBody) {
      // 先尝试用 undefined CT 解析（仅 raw 模式有效；formData 模式需 onBeforeSendHeaders 拿到 CT 后再解析）
      try {
        const parsed = parseRequestBody(rawRequestBody, undefined)
        if (parsed) requestBody = parsed
      } catch {
        // ignore parse error
      }
    }

    pendingRequests.set(details.requestId, {
      url: details.url,
      method: details.method,
      resourceType: details.type,
      tabId: details.tabId,
      frameId: details.frameId,
      generation: tabGenerationMap.get(details.tabId) ?? 0,
      isKeyDown: getDeleteKeyDown(),
      protocol,
      rawRequestBody,
      requestBody,
    })
    return undefined
  }
  chrome.webRequest.onBeforeRequest.addListener(
    onBeforeRequestListener as (details: chrome.webRequest.OnBeforeRequestDetails) => chrome.webRequest.BlockingResponse | undefined,
    { urls: [...URL_FILTERS] },
    ['requestBody'],
  )

  // 记录请求头 — 收集 User-Agent + x-* 自定义头 + 关键认证头供下载客户端使用
  // 确保推送下载时携带完整页面认证信息，使"看见即可下载"
  //
  // NDM bg.js W.O（行 264）：同时把全局 Delete 键状态 B 快照到 per-request 的 isKeyDown 字段
  // 这样请求中途 Delete 键状态变化不会影响该请求的拦截决策
  // （在 onHeadersReceived 阶段读取 pending.isKeyDown 决定是否跳过）
  onBeforeSendHeadersListener = (details: chrome.webRequest.OnBeforeSendHeadersDetails): undefined => {
    const pending = pendingRequests.get(details.requestId)
    if (!pending) return undefined
    const authHeaders: Record<string, string> = {}
    let requestContentType: string | undefined
    if (details.requestHeaders) {
      for (const h of details.requestHeaders) {
        const lower = h.name.toLowerCase()
        if (
          lower === 'user-agent'
          || lower.startsWith('x-')
          || lower === 'authorization'
          || lower === 'accept'
          || lower === 'accept-language'
        ) {
          authHeaders[h.name] = h.value ?? ''
        }
        // 提取 POST body 的 Content-Type（NDM bg.js T() 函数从请求头取 Content-Type）
        // 用于 multipart boundary 恢复
        if (lower === 'content-type') {
          requestContentType = h.value ?? undefined
        }
      }
    }
    const finalRequestBodyContentType = requestContentType ?? pending.requestBodyContentType
    let finalRequestBody = pending.requestBody
    // 如果 POST body 之前没解析成功（contentType 缺失），现在有 ContentType 时重新解析
    // （多见于 formData 模式，需要 ContentType 提取 boundary）
    if (details.method === 'POST' && !finalRequestBody && pending.rawRequestBody) {
      try {
        const reparsed = parseRequestBody(pending.rawRequestBody, finalRequestBodyContentType)
        if (reparsed) finalRequestBody = reparsed
      } catch {
        // ignore
      }
    }
    pendingRequests.set(details.requestId, {
      ...pending,
      isKeyDown: getDeleteKeyDown(),
      requestHeaders: Object.keys(authHeaders).length > 0 ? authHeaders : pending.requestHeaders,
      requestBodyContentType: finalRequestBodyContentType,
      requestBody: finalRequestBody ?? pending.requestBody,
    })
    return undefined
  }
  chrome.webRequest.onBeforeSendHeaders.addListener(
    onBeforeSendHeadersListener as (details: chrome.webRequest.OnBeforeSendHeadersDetails) => undefined,
    { urls: [...URL_FILTERS] },
    ['requestHeaders'],
  )

  onHeadersReceivedListener = (details: chrome.webRequest.OnHeadersReceivedDetails): undefined => {
      const pending = pendingRequests.get(details.requestId)
      if (!pending) return undefined

      const currentGen = tabGenerationMap.get(pending.tabId) ?? 0
      if (pending.generation < currentGen) {
        pendingRequests.delete(details.requestId)
        return undefined
      }

      try {
        const status = parseInt(details.statusLine?.split(' ')[1] ?? '0', 10) || 0

        // === NDM ba 重定向状态码跳过（301-308） ===
        // NDM bg.js: `ba=[301,302,303,307,308]`，行 194: `b.ca = 0 <= ba.indexOf(a)`
        // 命中重定向状态码时跳过唤探，避免对中间重定向响应重复触发 addMediaItem。
        // 旧实现对 3xx 也会触发 addMediaItem，可能重复唤探同一资源（301 → 200 两次唤探）。
        if (REDIRECT_STATUS_CODES.has(status)) {
          pendingRequests.delete(details.requestId)
          return undefined
        }

        if (status !== 200 && status !== 206) {
          pendingRequests.delete(details.requestId)
          return undefined
        }

        const headers = details.responseHeaders ?? []
        const contentType = getHeader(headers, 'Content-Type') ?? ''
        const contentDisposition = getHeader(headers, 'Content-Disposition') ?? ''
        const contentLength = getHeader(headers, 'Content-Length')
        const contentRange = getHeader(headers, 'Content-Range')

        let size = 0
        if (contentLength) size = parseInt(contentLength, 10) || 0
        if (contentRange) {
          const m = contentRange.match(/\/(\d+)$/)
          if (m) size = parseInt(m[1]!, 10) || size
        }

        const fileNameFromCD = extractFilenameFromCD(contentDisposition)
        const urlPath = getUrlPath(details.url)
        const urlFileName = extractFileNameFromPath(urlPath)

        // === NDM bg.js b.L = I[u] 取 MIME 表首个扩展名 ===
        // 从 Content-Type 反查扩展名（补足 URL/CD 无扩展名场景）
        // 例：URL 无后缀但 CT=application/pdf → ext=pdf
        const extFromCT = extFromContentType(contentType)

        // === 扩展名优先级：对齐 adclear_v6 (CD > URL)，MIME 仅作补充 ===
        // NDM 原版: b.g = b.O || b.P || b.s (MIME > CD > URL)
        // 但 MIME 优先对 m3u8 有致命问题：video/mp2t 映射到 TS|M3U8，
        // extFromContentType 返回 'ts'，导致 .m3u8 URL 被当作 TS 分片跳过。
        // adclear_v6 实际使用 CD > URL 优先级（不含 MIME），m3u8 始终正确识别。
        // 修复：URL 扩展名为 m3u8/m3u 时强制优先（这是 m3u8 检测最可靠的信号），
        // URL 扩展名为 m4s 时也强制优先（m4s 是 DASH CMAF 标志性扩展名，
        // CT 返回 video/mp4 会丢失 DASH 协议特征，导致 DASH 配对判定失败），
        // 其他情况仍用 MIME > CD > URL 优先级（对齐 NDM 原版）。
        const extFromCD = fileNameFromCD ? getExt(fileNameFromCD) : ''
        const extFromUrl = getExt(urlFileName)
        const isPlaylistUrlExt = /^(?:m3u8|m3u)$/i.test(extFromUrl)
        const isDashUrlExt = /^m4s$/i.test(extFromUrl)
        const ext = (isPlaylistUrlExt || isDashUrlExt) ? extFromUrl : (extFromCT || extFromCD || extFromUrl)

        // NDM shouldSkip 检查文件名末段 (req.l)，不是整个 pathname
        // 例：/json-assets/video.mp4 → urlFileName="video.mp4" → 不包含 ".json" → 跳过条件不命中
        // 例：/data.json → urlFileName="data.json" → 包含 ".json" → 命中跳过条件
        const lowerFileName = urlFileName.toLowerCase()
        if (
          lowerFileName.includes('manif') ||
          lowerFileName.includes('favicon.ico') ||
          lowerFileName.includes('pem.msg') ||
          lowerFileName.endsWith('.wasm') ||
          lowerFileName.includes('.json') ||
          lowerFileName.endsWith('.dict')
        ) {
          pendingRequests.delete(details.requestId)
          return undefined
        }
        if (pending.resourceType === 'image' && /^image\//i.test(contentType)) {
          pendingRequests.delete(details.requestId)
          return undefined
        }
        if (ext && !MEDIA_EXT_RE.test(ext) && NON_DOWNLOAD_EXT_RE.test(ext) && !isNonMediaDownloadExt(ext)) {
          pendingRequests.delete(details.requestId)
          return undefined
        }
        // === NDM bg.js: json 排除（扩展名 + MIME 反查 + CD 扩展名） ===
        // NDM: P(b.O.toLowerCase(), "json") || P(b.P.toLowerCase(), "json")
        // 即从 Content-Type 反查的扩展名或 Content-Disposition 中的扩展名是 json 也排除
        if ((ext && ext.toLowerCase() === 'json') || (extFromCT && extFromCT.toLowerCase() === 'json') || (extFromCD && extFromCD.toLowerCase() === 'json')) {
          pendingRequests.delete(details.requestId)
          return undefined
        }
        // === NDM bg.js: DCLK-AdSvr 排除（DoubleClick 广告服务器） ===
        // NDM: "DCLK-AdSvr" != L(b.B, "Server")
        const serverHeader = getHeader(headers, 'Server') ?? ''
        if (serverHeader === 'DCLK-AdSvr') {
          pendingRequests.delete(details.requestId)
          return undefined
        }

        const isAttachment = /attachment/i.test(contentDisposition)
        const isVideoAudioCT = /^(?:video|audio)\//i.test(contentType) || /mpegurl/i.test(contentType) || /m3u8/i.test(contentType)
        const isForceDownloadCT = FORCE_DOWNLOAD_CT_RE.test(contentType)
        const isMediaExt = ext && MEDIA_EXT_RE.test(ext)
        // === NDM da 正则：F4F/MPEGTS/TS/MP2T 视为 HLS 分片 ===
        // 旧实现只判断 'ts' 单一字符串，遗漏 F4F/MPEGTS/MP2T。
        const isHlsSegment = ext && HLS_STREAMING_EXT_RE.test(ext)
        const isWhitelistExt = ext && isNonMediaDownloadExt(ext)

        // === CT 矛盾过滤：伪下载 URL 防御 ===
        // URL 路径带文件扩展名（如 .rar/.zip）但服务端返回 text/html 等页面类型，
        // 且无 Content-Disposition: attachment → 这是 HTML 引导页，不是真实文件下载。
        // 典型场景：megaup.net/mediafire 等网盘的引导页 URL 带目标文件扩展名，
        // 但实际返回 HTML 页面，真实下载链接嵌在页面内需用户点击。
        // 不过滤 isAttachment=true 的情况：CD:attachment 是服务端明确表示"这是下载"的信号，
        // 即使 CT 是 text/html 也可能是动态生成的下载页（如 PHP 输出文件流但 CT 写错）。
        const isPageContentType = PAGE_CONTENT_TYPE_RE.test(contentType)
        if (isPageContentType && !isAttachment && isWhitelistExt) {
          logger.info('[sniffer] CT contradiction: URL ext=', ext, 'but CT=', contentType.split(';')[0], '— skipping (HTML landing page, not real download):', pending.url.slice(0, 80))
          pendingRequests.delete(details.requestId)
          return undefined
        }

        // === NDM da 正则：强制走 HLS 解析路径的扩展名（非分片） ===
        // NDM bg.js: `da=/^(?:FLV|AVI|MPG|MPE|WMV|QT|MOV|RM|RAM|WMA|MID|MIDI|AAC|MKV|RMVB)$/i`
        // 当 resourceType 是 _frame 或不在 z=["object","xmlhttprequest","media","other"] 中时，
        // da.test(ext) 命中也嗅探（如 iframe 中加载的 .flv/.avi 等）
        const DA_EXT_RE = /^(?:FLV|AVI|MPG|MPE|WMV|QT|MOV|RM|RAM|WMA|MID|MIDI|AAC|MKV|RMVB)$/i
        const isDaExt = ext && DA_EXT_RE.test(ext)

        // === NDM 嗅探条件链（完整移植自 bg.js V.V 行 775-776） ===
        // NDM: n || "other"==b.type && B.test(b.g) || (b.R||!g) && da.test(b.g) || (b.R||"other"==b.type) && (k&&!r || ba.test(p) || b.g&&!B.test(b.g)&&!ca.test(b.g))
        // 其中：
        //   n = main_frame && B.test(ext) && !C.test(ext) — 主帧加载的媒体
        //   b.R = O(f, "_frame") — resourceType 含 _frame
        //   g = 0 <= z.indexOf(f) — resourceType 在标准嗅探类型中
        //   k = VTT/SRT 字幕
        //   r = js/txt/dict 排除
        //   ba = 强制下载 CT
        //   ca = 非下载扩展名
        const isMainFrame = pending.resourceType === 'main_frame'
        const isSubFrame = pending.resourceType === 'sub_frame'
        // NDM req.R = O(f, "_frame") — resourceType 以 _frame 结尾，仅 sub_frame，不含 main_frame
        const isFrameOnly = isSubFrame
        const isStandardSniffType = ['object', 'xmlhttprequest', 'media', 'other'].includes(pending.resourceType)
        const isSubtitle = ext && /^(?:vtt|srt)$/i.test(ext)
        const isJsTxtDict = ext && /^(?:js|txt|dict)$/i.test(ext)
        const isUnknownExt = ext && !MEDIA_EXT_RE.test(ext) && !NON_DOWNLOAD_EXT_RE.test(ext) && !isNonMediaDownloadExt(ext)

        // NDM 条件 1: main_frame 媒体（直接打开 .mp4 URL 等）
        const condMainFrameMedia = isMainFrame && isMediaExt && !isHlsSegment
        // NDM 条件 2: other 类型 + 媒体扩展名
        const condOtherMedia = pending.resourceType === 'other' && isMediaExt
        // NDM 条件 3: (仅 sub_frame 或 非标准类型) + da 扩展名 — NDM req.R 仅含 sub_frame
        const condFrameDa = (isFrameOnly || !isStandardSniffType) && isDaExt
        // NDM 条件 4: (仅 sub_frame 或 other) + (字幕非js/txt/dict 或 强制下载CT 或 未知扩展名) — NDM req.R 仅含 sub_frame
        const condFrameMisc = (isFrameOnly || pending.resourceType === 'other') && (
          (isSubtitle && !isJsTxtDict) || isForceDownloadCT || isUnknownExt
        )

        const sniffable =
          !isHlsSegment &&
          (isMediaExt ||
            isAttachment ||
            isForceDownloadCT ||
            isVideoAudioCT ||
            isWhitelistExt ||
            condMainFrameMedia ||
            condOtherMedia ||
            condFrameDa ||
            condFrameMisc)

        if (!sniffable) {
          pendingRequests.delete(details.requestId)
          return undefined
        }

        // === NDM bg.js b.isKeyDown 检查（行 219） ===
        // Delete 键按下时跳过拦截，让浏览器原生下载（一次性绕过扩展）
        // NDM: `if(b.isKeyDown){delete this.j[c]; return}`
        if (pending.isKeyDown) {
          logger.info('[sniffer] Delete key pressed, skip interception:', pending.url.slice(0, 80))
          pendingRequests.delete(details.requestId)
          return undefined
        }

        // === 站点特殊嗅探器（NDM bg.js 100% 移植） ===
        // 这些 URL 模式由专门的嗅探器处理，不走常规媒体添加路径：
        //   - GoogleVideo /videoplayback：去除 range 参数后作为 DASH 流配对
        //   - YouTube player API POST：fetch watch 页提取 formats
        //   - Vimeo player JSON：fetch JSON 提取 progressive URL
        //   - Periscope JSON：fetch JSON 提取 hls_url
        // 命中后立即返回，避免重复添加为常规媒体项
        if (isGoogleVideoPlaybackUrl(pending.url, contentType)) {
          // NDM bg.js W.P：重建无 range 参数的 URL，按 ei 配对视/音频
          sniffGoogleVideoDash(pending.tabId, pending.url, contentType)
          logger.info('[sniffer] GoogleVideo DASH dispatched:', pending.url.slice(0, 80))
          pendingRequests.delete(details.requestId)
          return undefined
        }

        if (isYouTubePlayerApiPost(pending.url, pending.method, pending.frameId) && pending.requestBody) {
          // NDM bg.js：fetch watch 页提取 formats + adaptiveFormats
          void sniffYouTubeWatchPage(pending.tabId, pending.requestBody).catch((e) => {
            logger.warn('[sniffer] YouTube watch sniff failed:', (e as Error).message)
          })
          logger.info('[sniffer] YouTube watch page sniff dispatched:', pending.url.slice(0, 80))
          pendingRequests.delete(details.requestId)
          return undefined
        }

        if (isVimeoPlayerJsonUrl(pending.url, contentType)) {
          // NDM bg.js：fetch player.vimeo.com JSON 提取 progressive URL
          void sniffVimeoProgressiveJson(pending.tabId, pending.url).catch((e) => {
            logger.warn('[sniffer] Vimeo sniff failed:', (e as Error).message)
          })
          logger.info('[sniffer] Vimeo progressive JSON sniff dispatched:', pending.url.slice(0, 80))
          pendingRequests.delete(details.requestId)
          return undefined
        }

        if (isPeriscopeAccessUrl(pending.url)) {
          // NDM bg.js X json 模式：fetch JSON 提取 hls_url / https_hls_url
          void sniffPeriscopeJson(pending.tabId, pending.url).catch((e) => {
            logger.warn('[sniffer] Periscope sniff failed:', (e as Error).message)
          })
          logger.info('[sniffer] Periscope JSON sniff dispatched:', pending.url.slice(0, 80))
          pendingRequests.delete(details.requestId)
          return undefined
        }

        // === 非媒体下载自动推送（移植自 NDM bg.js V.V else 分支 + V.I WebSocket 推送） ===
        // NDM 行为：非媒体下载（白名单 ext / attachment / force-download CT）命中时：
        //   1. 设置 this.u = URL（供 V.X downloads.onCreated 匹配取消）
        //   2. 调用 this.I(v) 通过 WebSocket 推送到 NDM 客户端
        //   3. 不调用 this.A()（不显示角标/面板）
        //
        // velo 行为（与 NDM 一致）：
        //   - 非媒体下载不调用 addMediaItem（不显示角标，无实际意义）
        //   - 自动推送到下载客户端（PushClient 优先 → 配置的 aria2/ndm/velo）
        //   - 设置 lastPushedUrl 供 downloads.onCreated 匹配取消浏览器下载
        //   - 无可用客户端时让浏览器原生下载正常进行
        if (isWhitelistExt || isAttachment || isForceDownloadCT) {
          // 去重：同一 URL 已推送过，跳过（防止 onBeforeRequest 重定向后二次触发）
          if (pushedUrlSet.has(pending.url)) {
            logger.debug('[sniffer] non-media download already pushed, skipping:', ext, pending.url.slice(0, 80))
            pendingRequests.delete(details.requestId)
            return undefined
          }
          const hasPushClient = !!getPushClient()
          const cfg = getCachedDownloadConfig()
          const hasViableClient = hasPushClient || cfg.client !== 'native'

          if (hasViableClient) {
            lastPushedUrl = pending.url
            pushedUrlSet.add(pending.url)
            pushedUrlSet.add(details.url)
            logger.info('[sniffer] non-media download, auto-pushing to client:', ext, pending.url.slice(0, 80), 'client:', hasPushClient ? 'pushClient' : cfg.client)
            // === 获取 pageUrl + cookies（与 NDM bg.js V.J 对齐） ===
            // NDM 流程：V.V → chrome.cookies.getAll({url}, V.J) → V.J 设置 item.cookies → V.I 推送
            // 缺少 Cookie/Referer/Origin 时，服务端不认识会话，返回 HTML 登录/引导页而非真实文件
            const pushUrl = pending.url
            const pushFileName = fileNameFromCD || urlFileName
            const pushContentType = contentType.split(';')[0]!.trim()
            const pushMethod = pending.method
            const pushRequestBody = pending.requestBody
            const pushRequestHeaders = pending.requestHeaders
            const pushTabId = pending.tabId

            void (async () => {
              let pageUrl: string | undefined
              let cookies: string | undefined
              let title: string | undefined
              try {
                const tab = await chrome.tabs.get(pushTabId)
                pageUrl = tab.url
                title = tab.title
              } catch { /* tab may have been closed */ }

              // === NDM bg.js: openerTabId 处理（弹窗窗口的 pageUrl/title） ===
              // NDM: chrome.tabs.query({active:true, currentWindow:true}) →
              //   如果活动标签页 URL == 推送 URL 且有 openerTabId →
              //   从 opener 标签页获取 pageUrl 和 title
              // 场景：点击下载链接后打开新窗口（popup），新窗口的 URL 是下载 URL，
              // 但认证信息应从原始页面（opener）获取
              // NDM 额外逻辑：B.test(b.g) → chrome.tabs.remove(t[0].id) + v["6"]="media"
              // 即如果 URL 扩展名匹配媒体正则，删除弹窗标签页并设置 priority 为 "media"
              let pushPriority: string = 'normal'
              try {
                const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
                if (activeTab && (pushUrl === activeTab.pendingUrl || pushUrl === activeTab.url) && activeTab.openerTabId) {
                  const openerTab = await chrome.tabs.get(activeTab.openerTabId)
                  if (!pageUrl) {
                    pageUrl = openerTab.url
                    title = openerTab.title
                  }
                  // NDM: B.test(b.g) && (chrome.tabs.remove(t[0].id), v["6"] = "media")
                  if (ext && MEDIA_EXT_RE.test(ext) && activeTab.id != null) {
                    chrome.tabs.remove(activeTab.id).catch(() => {})
                    pushPriority = 'media'
                    logger.info('[sniffer] openerTabId + media ext: removing popup tab', activeTab.id, 'priority → media')
                  }
                }
              } catch { /* opener tab may not exist */ }
              try {
                const cookieList = await chrome.cookies.getAll({ url: pushUrl })
                if (cookieList.length > 0) {
                  cookies = cookieList.map((c) => `${c.name}=${c.value}`).join('; ')
                }
              } catch { /* cookies API may fail for some URLs */ }

              // NDM bg.js S(): POST 请求从 requestHeaders 提取 Content-Type/Content-Disposition
              // 覆盖到推送消息的 ["10"]/["11"] 字段（对应 velo 的 content_type/content_disposition）
              // 对于 POST 请求，请求体的 CT（如 multipart/form-data）比响应头 CT 更重要
              let effectiveContentType = pushContentType
              let effectiveContentDisposition = contentDisposition
              if (pushMethod === 'POST' && pushRequestHeaders) {
                for (const [name, value] of Object.entries(pushRequestHeaders)) {
                  const lower = name.toLowerCase()
                  if (lower === 'content-type' && value) effectiveContentType = value.trim()
                  if (lower === 'content-disposition' && value) effectiveContentDisposition = value.trim()
                }
              }

              const result = await sendToDownloadClient(
                pushUrl,
                pushFileName,
                {
                  contentType: effectiveContentType,
                  contentDisposition: effectiveContentDisposition,
                  method: pushMethod,
                  requestBody: pushRequestBody,
                  requestHeaders: pushRequestHeaders,
                  pageUrl,
                  cookies,
                  title,
                  contentLength: size > 0 ? String(size) : undefined,
                  priority: pushPriority,
                },
              )
              if (!result.success) {
                lastPushedUrl = ''
                pushedUrlSet.delete(pushUrl)
                pushedUrlSet.delete(details.url)
                logger.warn('[sniffer] auto-push failed, clearing lastPushedUrl:', result.message, 'url:', pushUrl.slice(0, 80))
              }
            })().catch((e) => {
              lastPushedUrl = ''
              pushedUrlSet.delete(pushUrl)
              pushedUrlSet.delete(details.url)
              logger.warn('[sniffer] auto-push error, clearing lastPushedUrl:', (e as Error).message, 'url:', pushUrl.slice(0, 80))
            })
          } else {
            logger.info('[sniffer] non-media download, no client available, letting browser handle:', ext, pending.url.slice(0, 80))
          }

          pendingRequests.delete(details.requestId)
          return undefined
        }

        // === NDM bg.js: 媒体大小阈值 — 小文件不嗅探 ===
        // NDM: `(!b["7"] || 512E3 < b["7"] || k)` — 媒体 < 512KB 不嗅探（字幕 k 除外）
        // 避免嗅探页面内嵌的短音频（如 UI 音效、提示音）等无意义的小媒体
        // NDM: `!("ASF" == b.g && 256E4 >= b["7"])` — ASF 且 < 2.5MB 也不嗅探
        // **关键豁免**: m3u8/m3u 播放列表通常只有几KB，必须始终嗅探，否则 HLS 广告过滤完全失效
        // **关键豁免**: m4s 是 DASH CMAF 标志性扩展名，B站等 audio m4s 可小至 100KB+，
        //   跳过会导致 DASH 音视频配对缺少 audio 轨，AV 合并下载项消失
        const isSubtitleExt = ext && /^(?:vtt|srt)$/i.test(ext)
        const isPlaylistExt = ext && /^(?:m3u8|m3u)$/i.test(ext)
        const isDashSegExt = ext && /^m4s$/i.test(ext)
        if (isMediaExt && !isSubtitleExt && !isPlaylistExt && !isDashSegExt && size > 0 && size < 512 * 1024) {
          logger.debug('[sniffer] media too small, skipping:', ext, size, 'bytes, url:', pending.url.slice(0, 80))
          pendingRequests.delete(details.requestId)
          return undefined
        }
        if (ext && ext.toUpperCase() === 'ASF' && size > 0 && size <= 2560000) {
          logger.debug('[sniffer] ASF too small, skipping:', size, 'bytes, url:', pending.url.slice(0, 80))
          pendingRequests.delete(details.requestId)
          return undefined
        }

        // === NDM bg.js: 非 m3u8 大文本 XHR 嗅探 ===
        // NDM: 非 m3u8/字幕/POST/vimeo/youtube/google，且是 txt/js XHR > 300KB 时也嗅探
        // 典型场景：某些网站通过 XHR 返回大段 JS/JSON 数据，实际是视频配置或播放列表
        const isTxtJsXhr = (ext && /^(?:txt|js)$/i.test(ext)) && pending.resourceType === 'xmlhttprequest'
        if (isTxtJsXhr && size > 0 && size <= 307200) {
          logger.debug('[sniffer] txt/js XHR too small, skipping:', ext, size, 'bytes, url:', pending.url.slice(0, 80))
          pendingRequests.delete(details.requestId)
          return undefined
        }

        // === 媒体下载：显示角标/面板，用户手动选择下载 ===
        const item: MediaItem = {
          id: details.requestId,
          url: pending.url,
          method: pending.method,
          resourceType: pending.resourceType,
          contentType: contentType.split(';')[0]!.trim(),
          contentDisposition: contentDisposition,
          size,
          fileName: fileNameFromCD || urlFileName,
          ext: ext.toLowerCase(),
          tabId: pending.tabId,
          detectedAt: Date.now(),
          requestBody: pending.requestBody,
          requestHeaders: pending.requestHeaders,
          generation: pending.generation,
        }

        addMediaItem(pending.tabId, item)
        logger.info('[sniffer] media detected:', item.ext, item.fileName, 'ct:', item.contentType, 'size:', item.size, 'tabId:', item.tabId, item.url.slice(0, 100))

        if ((ext.toLowerCase() === 'm3u8' || ext.toLowerCase() === 'm3u') && pending.tabId >= 0) {
          if (_m3u8ProcessHandler) {
            void _m3u8ProcessHandler(pending.url, pending.tabId, pending.requestHeaders)
          } else {
            void processM3u8InBackground(pending.url, pending.tabId, pending.requestHeaders)
          }
        }
      } catch (e) {
        logger.warn('[sniffer] onHeadersReceived failed:', (e as Error).message)
      } finally {
        pendingRequests.delete(details.requestId)
      }
      return undefined
    }
  chrome.webRequest.onHeadersReceived.addListener(
    onHeadersReceivedListener as (details: chrome.webRequest.OnHeadersReceivedDetails) => undefined,
    { urls: [...URL_FILTERS] },
    ['responseHeaders'],
  )

  chrome.webRequest.onCompleted.addListener(
    ((details: chrome.webRequest.OnCompletedDetails): undefined => {
      pendingRequests.delete(details.requestId)
      return undefined
    }) as (details: chrome.webRequest.OnCompletedDetails) => undefined,
    { urls: [...URL_FILTERS] },
  )
  chrome.webRequest.onErrorOccurred.addListener(
    ((details: chrome.webRequest.OnErrorOccurredDetails): undefined => {
      pendingRequests.delete(details.requestId)
      return undefined
    }) as (details: chrome.webRequest.OnErrorOccurredDetails) => undefined,
    { urls: [...URL_FILTERS] },
  )

  chrome.tabs.onRemoved.addListener(async (tabId) => {
    tabMediaMap.delete(tabId)
    tabGenerationMap.delete(tabId)
    // P1-6: 同步清理 hlsLastCleaned 中该 tab 的缓存，避免长期累积膨胀
    try {
      const CLEANED_KEY = 'hlsLastCleaned'
      const all = (await persistentStorage.get<Record<string, unknown>>(CLEANED_KEY)) ?? {}
      if (String(tabId) in all) {
        delete all[String(tabId)]
        await persistentStorage.set(CLEANED_KEY, all)
      }
    } catch { /* ignore */ }
  })

  // webNavigation.onCommitted — 全页面导航时清理该 tab 的 HLS cleaned context + 媒体列表
  // 覆盖：地址栏输入、链接点击、前进后退、JS location 赋值等所有导航类型
  // SPA pushState/replaceState 不触发 onCommitted，由下面的 onHistoryStateUpdated 处理
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.tabId >= 0 && details.frameId === 0) {
      const tabId = details.tabId
      const prevGen = tabGenerationMap.get(tabId) ?? 0
      tabGenerationMap.set(tabId, prevGen + 1)
      tabMediaMap.delete(tabId)
      void (async () => {
        try {
          const CLEANED_KEY = 'hlsLastCleaned'
          const all = (await persistentStorage.get<Record<string, unknown>>(CLEANED_KEY)) ?? {}
          if (String(tabId) in all) {
            delete all[String(tabId)]
            await persistentStorage.set(CLEANED_KEY, all)
          }
        } catch { /* ignore */ }
      })()
      logger.info('[sniffer] page navigation committed: tabId:', tabId, 'url:', details.url.slice(0, 80), 'generation:', prevGen, '→', prevGen + 1)
    }
  })

  // webNavigation.onHistoryStateUpdated — SPA 路由变化时递增代际号并通知 player-panel 刷新
  // **不再清空 tabMediaMap**：旧项保留在 map 中但标记为旧代际，pairDashItems/getMediaItems
  //   通过 generation 过滤只返回当前代际的项。这避免了 SPA 导航后浏览器不重新请求
  //   已缓存的 video m4s 导致只剩 1 个 audio 候选项无法配对的问题。
  //   旧代际项在 getMediaItems 返回时被过滤掉，对用户不可见。
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.tabId >= 0) {
      const tabId = details.tabId
      const prevGen = tabGenerationMap.get(tabId) ?? 0
      tabGenerationMap.set(tabId, prevGen + 1)
      // SPA 路由变化 → 清理该 tab 的 HLS cleaned context（旧页面的 m3u8 不再有效）
      void (async () => {
        try {
          const CLEANED_KEY = 'hlsLastCleaned'
          const all = (await persistentStorage.get<Record<string, unknown>>(CLEANED_KEY)) ?? {}
          if (String(tabId) in all) {
            delete all[String(tabId)]
            await persistentStorage.set(CLEANED_KEY, all)
          }
        } catch { /* ignore */ }
      })()
      logger.info('[sniffer] SPA navigation: tabId:', tabId, 'generation:', prevGen, '→', prevGen + 1)
      void chrome.tabs.sendMessage(tabId, { type: 'pageUrlChanged', url: details.url }).catch(() => {})
    }
  })

  // downloads.onCreated — 拦截浏览器原生下载（移植自 NDM bg.js V.X）
  // 两种匹配方式：
  //   1. URL 匹配 tabMediaMap 中的媒体项（用户在面板中点击下载的媒体）
  //   2. URL 匹配 lastPushedUrl（非媒体下载已自动推送到客户端，需取消浏览器下载）
  //
  // NDM V.X: `this.u != a.finalUrl && this.u != a.url ? this.u = "" : (this.u = "", cancel, erase)`
  chrome.downloads.onCreated.addListener((item) => {
    if (!item.url) return

    // 匹配 pushedUrlSet：非媒体下载已自动推送，取消浏览器下载条目
    // 使用 Set 匹配重定向链中任意 URL（对齐 NDM V.X this.u 匹配逻辑）
    if (pushedUrlSet.has(item.url) || pushedUrlSet.has(item.finalUrl || '') || (lastPushedUrl && (lastPushedUrl === item.url || lastPushedUrl === item.finalUrl))) {
      logger.info('[sniffer] downloads.onCreated: matching pushed URL, canceling browser download:', item.url.slice(0, 80))
      pushedUrlSet.delete(item.url)
      if (item.finalUrl) pushedUrlSet.delete(item.finalUrl)
      lastPushedUrl = ''
      chrome.downloads.cancel(item.id, () => {
        chrome.downloads.erase({ id: item.id })
      })
      return
    }

    // 匹配 tabMediaMap：媒体项已推送到客户端，取消浏览器下载
    for (const [, items] of tabMediaMap) {
      if (items.some((m) => m.url === item.url || m.url === item.finalUrl)) {
        chrome.downloads.cancel(item.id, () => {
          chrome.downloads.erase({ id: item.id })
        })
        return
      }
    }
  })

  // action.onClicked — 工具栏开关嗅探 (移植自 NDM bg.js V.M + task #8)
  // NDM 行为：点击图标 → 切换 badge 显隐 → 广播给当前 tab 所有 content script
  // velo-extension 有 popup 时此 listener 不触发；移除 popup 后才生效
  // 为兼容两种情况，同时提供：
  //   1. 此 listener（用户未配置 popup 时生效）
  //   2. popup 中 "切换显隐" 按钮通过 velo-toggle-visibility handler 调用相同逻辑
  chrome.action.onClicked.addListener(async (tab) => {
    if (!tab.id || tab.id < 0) return
    // 读取当前显隐状态（从 storage.local 读 ShowMediaPanel，与 NDM 一致）
    const stored = await chrome.storage.local.get(['ShowMediaPanel'])
    const currentVisible = stored.ShowMediaPanel !== -1
    const newVisible = !currentVisible
    await chrome.storage.local.set({ ShowMediaPanel: newVisible ? 1 : -1 })
    // 广播给当前 tab 所有 frames（task #8: 折叠/展开所有 badge）
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'veloVisibilityChanged',
        payload: { visible: newVisible },
      })
    } catch {
      // content script 未注入 — 忽略
    }
    logger.info('[sniffer] toolbar icon clicked, visibility toggled to:', newVisible, 'tabId:', tab.id)
  })

  // storage.onChanged — 配置变化实时响应 (移植自 NDM bg.js)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.hlsFilterConfig) {
      logger.info('[sniffer] hlsFilterConfig changed, will use new config on next m3u8')
    }
  })

  logger.info('[sniffer] webRequest + webNavigation + downloads listeners started')
}

export function stopSniffer(): void {
  if (!initialized) return
  initialized = false

  if (onBeforeRequestListener) {
    chrome.webRequest.onBeforeRequest.removeListener(
      onBeforeRequestListener as (details: chrome.webRequest.OnBeforeRequestDetails) => chrome.webRequest.BlockingResponse | undefined,
    )
    onBeforeRequestListener = null
  }
  if (onBeforeSendHeadersListener) {
    chrome.webRequest.onBeforeSendHeaders.removeListener(
      onBeforeSendHeadersListener as (details: chrome.webRequest.OnBeforeSendHeadersDetails) => undefined,
    )
    onBeforeSendHeadersListener = null
  }
  if (onHeadersReceivedListener) {
    chrome.webRequest.onHeadersReceived.removeListener(
      onHeadersReceivedListener as (details: chrome.webRequest.OnHeadersReceivedDetails) => undefined,
    )
    onHeadersReceivedListener = null
  }

  pendingRequests.clear()
  logger.info('[sniffer] webRequest listeners removed, sniffer stopped')
}

export function isSnifferRunning(): boolean {
  return initialized
}

/**
 * 后台处理 m3u8（不替换播放流，只清洗 + 广播报告给 badge）
 *
 * MV3 限制：webRequest 不能修改响应体，所以无法替换播放流。
 * 方案：sniffer 检测到 m3u8 请求后，后台 fetch m3u8 文本 → processPlaylist
 *      → 存 cleaned context → 广播 hlsFilterReport + hlsFilterResult 给 badge
 *      badge 显示广告检测结果 + 下载按钮 + AdSkipper
 */
async function processM3u8InBackground(m3u8Url: string, tabId: number, sniffedHeaders?: Record<string, string>): Promise<void> {
  try {
    // 0. 检查 HLS 过滤是否启用（合并 DEFAULT_SETTINGS 防止旧版 settings 缺字段）
    const stored = await settingsStore.get<typeof DEFAULT_SETTINGS>()
    const settings = { ...DEFAULT_SETTINGS, ...stored }
    if (!settings.enableHlsAdFilter) {
      logger.info('[sniffer] HLS filter disabled, skip m3u8 processing')
      return
    }

    // 1. fetch m3u8 文本（携带认证头：Referer + Cookie + requestHeaders）
    const fetchHeaders: Record<string, string> = {}
    try {
      const cookieList = await chrome.cookies.getAll({ url: m3u8Url })
      if (cookieList.length > 0) {
        fetchHeaders['Cookie'] = cookieList.map((c) => `${c.name}=${c.value}`).join('; ')
      }
    } catch { /* ignore */ }
    if (sniffedHeaders) {
      for (const [name, value] of Object.entries(sniffedHeaders)) {
        fetchHeaders[name] = value
      }
    }
    const fetchInit: RequestInit = { cache: 'no-store' }
    if (Object.keys(fetchHeaders).length > 0) {
      fetchInit.headers = fetchHeaders
    }
    const MAX_FETCH_RETRIES = 3
    const FETCH_RETRY_BASE_MS = 500
    let res: Response | null = null
    for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt++) {
      try {
        res = await fetch(m3u8Url, fetchInit)
        if (res.ok) break
        logger.warn('[sniffer] fetch m3u8 failed:', res.status, 'attempt:', attempt)
        res = null
      } catch (fetchErr) {
        logger.warn('[sniffer] fetch m3u8 threw:', (fetchErr as Error).message, 'attempt:', attempt)
        res = null
      }
      if (attempt < MAX_FETCH_RETRIES) {
        const delay = FETCH_RETRY_BASE_MS * Math.pow(2, attempt - 1)
        await new Promise((r) => setTimeout(r, delay))
      }
    }
    if (!res) {
      logger.error('[sniffer] fetch m3u8 failed after', MAX_FETCH_RETRIES, 'retries, url:', m3u8Url.slice(0, 120))
      return
    }
    const text = await res.text()
    logger.info('[sniffer] m3u8 fetched, len:', text.length, 'url:', m3u8Url.slice(0, 80))

    // 2. 构建 pageHost
    let pageHost = ''
    try {
      pageHost = new URL(m3u8Url).host
    } catch {
      // ignore
    }

    // 3. 构建运行时配置（合并全部用户配置）— 静态 import 避免 SW import() 限制
    logger.info('[sniffer] step 3: buildConfig...')
    const fpCfg = (await persistentStorage.get<Record<string, unknown>>('hlsFilterConfig')) ?? {}
    const cfg = await buildConfig(
      {
        ...DEFAULT_CONFIG,
        enabled: true,
        logToConsole: (fpCfg.logToConsole as boolean) ?? false,
        enableFingerprint: (fpCfg.enableFingerprint as boolean) ?? false,
        fingerprintMode: ((fpCfg.fingerprintMode as string) ?? 'suspicious-only') as 'off' | 'suspicious-only' | 'all',
        autoLearnFingerprints: (fpCfg.autoLearnFingerprints as boolean) ?? true,
        remoteFingerprintsUrl: (fpCfg.remoteFingerprintsUrl as string) ?? '',
        scoreThreshold: (fpCfg.scoreThreshold as number) ?? 3,
        mode: ((fpCfg.mode as string) ?? 'm3u8-file') as import('@/engine/hls/types').AdDeliveryMode,
        urlPatterns: (fpCfg.urlPatterns as string[]) ?? [],
        keepDiscontinuityOnGap: (fpCfg.keepDiscontinuityOnGap as boolean) ?? true,
      },
      pageHost,
    )
    logger.info('[sniffer] step 3 done: buildConfig')

    // 4. processPlaylist
    logger.info('[sniffer] step 4: processPlaylist...')
    const result = await processPlaylist(text, m3u8Url, m3u8Url, cfg)
    logger.info('[sniffer] step 4 done: mode:', result.mode, 'ads:', 'report' in result ? (result.report as { ads?: number })?.ads ?? 0 : 0)

    // 5. 输出阶段 — 由 _m3u8ProcessHandler 接管（background.ts 注入的 veloProcessM3u8）
    // 注：原 _m3u8OutputHandler 分支已删除（setM3u8OutputHandler 从未被调用，始终为 null）

    // --- 默认输出流程 ---

    // 5a. 广播报告给 badge
    if (result.report) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'hlsFilterReport',
          report: result.report,
        })
      } catch {
        // badge 未注入 — 忽略
      }
    }

    // 5b. 如果有 cleaned m3u8（检测到广告或可下载），广播给 badge 显示下载按钮 + AdSkipper
    if ('cleaned' in result && typeof result.cleaned === 'string') {
      const baseName = extractBaseName(m3u8Url)
      const adRanges = 'adRanges' in result ? result.adRanges : []
      let pageTitle = ''
      try {
        const tab = await chrome.tabs.get(tabId)
        pageTitle = tab?.title?.trim() || ''
      } catch { /* ignore */ }
      try {
        const ctx = {
          cleaned: result.cleaned,
          baseName,
          pageTitle,
          report: result.report,
          segments: 'segments' in result ? result.segments : [],
          reasons: 'reasons' in result ? result.reasons : {},
          pageHost,
          baseUrl: m3u8Url,
          detectedAt: Date.now(),
        }
        const CLEANED_KEY = 'hlsLastCleaned'
        const all = (await persistentStorage.get<Record<string, typeof ctx>>(CLEANED_KEY)) ?? {}
        all[String(tabId)] = ctx
        await persistentStorage.set(CLEANED_KEY, all)

        await chrome.tabs.sendMessage(tabId, {
          type: 'hlsFilterResult',
          adRanges: adRanges,
          baseName,
          pageTitle,
          report: result.report,
        })
        logger.info('[sniffer] hlsFilterResult broadcasted:', adRanges?.length ?? 0, 'ad ranges, baseName:', baseName, 'pageTitle:', pageTitle ? pageTitle.slice(0, 40) : '(empty)')
      } catch (e) {
        logger.warn('[sniffer] broadcast hlsFilterResult failed:', (e as Error).message)
      }
    }
  } catch (e) {
    logger.error('[sniffer] processM3u8InBackground failed:', (e as Error).message, (e as Error).stack)
  }
}

export function getMediaItems(tabId: number): MediaItem[] {
  const items = tabMediaMap.get(tabId)
  if (!items) return []
  const currentGen = tabGenerationMap.get(tabId) ?? 0
  // 过滤旧代际项：SPA 导航后旧代际项对用户不可见
  // 延迟清理：仅当当前代际有新项时才清理旧项，避免 SPA 导航后新请求未到达时面板闪空
  const currentGenItems = items.filter((item) => item.generation === undefined || item.generation >= currentGen)
  if (currentGen > 0 && currentGenItems.length > 0) {
    // 当前代际已有新项，可以安全清理旧代际项
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!
      if (item.generation !== undefined && item.generation < currentGen) {
        items.splice(i, 1)
      }
    }
  }
  return currentGenItems
}

export function clearMediaItems(tabId: number): void {
  tabMediaMap.delete(tabId)
}

/**
 * 外部添加媒体项的可选元数据
 *
 * 用于站点特殊嗅探器（YouTube DASH / GoogleVideo DASH）标记音视频角色，
 * 使 player-panel 能正确显示"合并下载 (V+A)"按钮。
 */
export interface AddMediaItemOptions {
  /** DASH 音视频角色（video/audio），设置后会被 player-panel 当作 DASH 配对项 */
  readonly dashRole?: DashRole | undefined
  /** DASH 配对组 ID，同一视频的视/音频共享同一 groupId */
  readonly dashGroupId?: string | undefined
  /** Content-Type（可选，用于下载客户端的认证头构建） */
  readonly contentType?: string | undefined
  /** 文件大小（可选） */
  readonly size?: number | undefined
}

/**
 * 外部添加媒体项（站点特殊抓取 content script 调用）
 *
 * 用于 NDM bg.js + ct.js 移植的站点嗅探器（YouTube / Vimeo / Facebook / Periscope /
 * GoogleVideo DASH）将解析出的媒体项推送到 tab 媒体列表。
 *
 * 与 webRequest 路径的 `addMediaItem` 区别：
 *   - 无 Content-Disposition / Content-Length 等响应头信息
 *   - 可携带 dashRole + dashGroupId 标记 DASH 配对关系（YouTube / GoogleVideo DASH）
 *
 * 去重策略：精确 URL 匹配（与 addMediaItem 一致），同一 URL 不重复添加。
 */
export function addMediaItemExternal(
  tabId: number,
  url: string,
  label: string,
  ext: string,
  options?: AddMediaItemOptions,
): void {
  const item: MediaItem = {
    id: `external-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url,
    method: 'GET',
    resourceType: 'external',
    contentType: options?.contentType ?? '',
    contentDisposition: '',
    size: options?.size ?? 0,
    fileName: label,
    ext: ext.toLowerCase(),
    tabId,
    detectedAt: Date.now(),
    dashRole: options?.dashRole,
    dashGroupId: options?.dashGroupId,
    generation: tabGenerationMap.get(tabId) ?? 0,
  }
  let list = tabMediaMap.get(tabId)
  if (!list) {
    list = []
    tabMediaMap.set(tabId, list)
  }
  if (list.some((m) => m.url === url)) return
  list.push(item)
  if (list.length > MAX_PER_TAB) {
    list.splice(0, list.length - MAX_PER_TAB)
  }
}

function addMediaItem(tabId: number, item: MediaItem): void {
  let list = tabMediaMap.get(tabId)
  if (!list) {
    list = []
    tabMediaMap.set(tabId, list)
  }
  // 精确 URL 去重
  if (list.some((m) => m.url === item.url)) {
    logger.info('[sniffer] dedup: exact URL match, skipped:', item.url.slice(0, 80))
    return
  }
  // URL 路径去重（忽略 query 参数差异，避免同一资源因 CDN 参数不同被重复嗅探）
  try {
    const itemPath = new URL(item.url).pathname
    if (list.some((m) => {
      try { return new URL(m.url).pathname === itemPath } catch { return false }
    })) {
      logger.info('[sniffer] dedup: URL pathname match, skipped:', itemPath)
      return
    }
  } catch {
    // URL 解析失败，保留精确去重结果
  }
  // DASH 文件名去重：同一非通用文件名的 m4s 视为同一资源的不同 CDN 副本
  // 通用文件名（如 index.m4s）不去重，因为 video/audio 轨可能共享相同通用名
  if (item.ext === 'm4s' && item.fileName && !/^(?:index|video|audio|media)\.m4s$/i.test(item.fileName)) {
    if (list.some((m) => m.ext === 'm4s' && m.fileName === item.fileName)) {
      logger.info('[sniffer] dedup: m4s fileName match, skipped:', item.fileName)
      return
    }
  }
  list.push(item)
  if (list.length > MAX_PER_TAB) {
    list.splice(0, list.length - MAX_PER_TAB)
  }
}

function getHeader(headers: chrome.webRequest.HttpHeader[], name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const h of headers) {
    if (h.name.toLowerCase() === lower) return h.value
  }
  return undefined
}

/**
 * 提取 URL 协议（小写，无 `:`）
 *
 * 移植自 NDM bg.js `R(a)` 函数：
 * ```js
 * function R(a) {
 *   return Q(a, "://") ? a.split("://", 1).shift().toLowerCase() || "" : "http"
 * }
 * ```
 *
 * NDM 行 22: 默认返回 "http"（兼容无协议前缀的相对 URL）
 * 我们用 URL 构造器解析，失败时回退到字符串 split（兼容 NDM 的 split("://") 行为）
 *
 * @param url 完整 URL
 * @returns 协议名（小写，如 'http'/'https'/'ftp'/'file'），失败返回 'http'
 */
function getProtocol(url: string): string {
  if (!url) return 'http'
  // 优先用 URL 解析（更严格，处理标准 URL）
  try {
    return new URL(url).protocol.replace(':', '').toLowerCase() || 'http'
  } catch {
    // 回退到 NDM 的 split("://") 方式（兼容非标准 URL）
    const idx = url.indexOf('://')
    if (idx > 0) {
      const proto = url.substring(0, idx).toLowerCase()
      return proto || 'http'
    }
    return 'http'
  }
}

/**
 * 处理 FTP / file:// 请求（在 onBeforeRequest 阶段直接推送，不走 onHeadersReceived）
 *
 * NDM bg.js W.N（行 266-271）FTP 分支：
 *   - 从 URL 提取 fileName（K 函数 = aa 正则提取 path 末段）
 *   - 创建下载描述符 + 推送到 NDM
 *   - 返回 {redirectUrl:"javascript:"} 取消浏览器请求
 *
 * velo-extension 实现（task 要求"将 FTP URL 当作普通下载项推送"）：
 *   - 提取 fileName + ext
 *   - 若 ext 在媒体扩展名 OR 非媒体下载白名单 → addMediaItemExternal 推送到 tabMediaMap
 *   - 不返回 redirectUrl（Chrome 不会原生下载 FTP/file://，无需取消）
 *
 * @param details onBeforeRequest 事件详情
 * @param protocol 协议名（'ftp' 或 'file'）
 */
function handleFtpOrFileRequest(
  details: chrome.webRequest.OnBeforeRequestDetails,
  protocol: 'ftp' | 'file',
): void {
  try {
    const urlPath = getUrlPath(details.url)
    const fileName = extractFileNameFromPath(urlPath)
    const ext = getExt(fileName)

    if (!ext) {
      logger.debug('[sniffer]', protocol, 'URL has no ext, skip:', details.url.slice(0, 100))
      return
    }

    if (!MEDIA_EXT_RE.test(ext) && !isNonMediaDownloadExt(ext)) {
      logger.debug('[sniffer]', protocol, 'URL ext not in whitelist, skip:', ext)
      return
    }

    const contentType = mimeFromExt(ext)
    const tabId = details.tabId
    const isNonMedia = isNonMediaDownloadExt(ext)

    if (isNonMedia) {
      if (pushedUrlSet.has(details.url)) {
        logger.debug('[sniffer]', protocol, 'non-media download already pushed, skipping:', ext, details.url.slice(0, 80))
        return
      }
      const hasPushClient = !!getPushClient()
      const cfg = getCachedDownloadConfig()
      const hasViableClient = hasPushClient || cfg.client !== 'native'

      if (hasViableClient) {
        lastPushedUrl = details.url
        pushedUrlSet.add(details.url)
        logger.info('[sniffer]', protocol, 'non-media download, auto-pushing to client:', ext, details.url.slice(0, 80))
        // NDM V.T FTP: 从 content script port 获取 pageUrl + title
        void (async () => {
          let pageUrl: string | undefined
          let cookies: string | undefined
          let title: string | undefined
          try {
            const tab = await chrome.tabs.get(tabId)
            pageUrl = tab.url
            title = tab.title
          } catch { /* tab may have been closed */ }
          try {
            const cookieList = await chrome.cookies.getAll({ url: details.url })
            if (cookieList.length > 0) {
              cookies = cookieList.map((c) => `${c.name}=${c.value}`).join('; ')
            }
          } catch { /* cookies API may fail */ }
          const result = await sendToDownloadClient(
            details.url,
            fileName,
            { contentType: contentType || undefined, pageUrl, cookies, title },
          )
          if (!result.success) {
            lastPushedUrl = ''
            pushedUrlSet.delete(details.url)
            logger.warn('[sniffer]', protocol, 'auto-push failed, clearing lastPushedUrl:', result.message)
          }
        })().catch((e: unknown) => {
          lastPushedUrl = ''
          pushedUrlSet.delete(details.url)
          logger.warn('[sniffer]', protocol, 'auto-push error, clearing lastPushedUrl:', (e as Error).message)
        })
      } else {
        logger.info('[sniffer]', protocol, 'non-media download, no client, letting browser handle:', ext, details.url.slice(0, 80))
      }
      return
    }

    addMediaItemExternal(tabId, details.url, fileName, ext.toLowerCase(), {
      contentType: contentType || undefined,
    })

    logger.info(
      '[sniffer]', protocol, 'URL added as media item:',
      'ext:', ext,
      'fileName:', fileName,
      'tabId:', tabId,
      'url:', details.url.slice(0, 100),
    )
  } catch (e) {
    logger.warn('[sniffer] handleFtpOrFileRequest failed:', (e as Error).message)
  }
}

function extractFilenameFromCD(cd: string): string {
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
  return m ? m[1]! : ''
}

function getUrlPath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

function extractFileNameFromPath(path: string): string {
  const lastSlash = path.lastIndexOf('/')
  if (lastSlash < 0) return path
  const name = path.slice(lastSlash + 1)
  try {
    return decodeURIComponent(name.split('?')[0] ?? '')
  } catch {
    return name.split('?')[0] ?? ''
  }
}

function getExt(fileName: string): string {
  if (!fileName) return ''
  const dot = fileName.lastIndexOf('.')
  if (dot < 0) return ''
  return fileName.slice(dot + 1)
}

// ============================================================================
// DASH 音视频配对
// ============================================================================

/** DASH 配对时间窗口（ms）：同一视频的音视频在 30 秒内嗅探到（B站等可能间隔较长） */
const DASH_PAIR_WINDOW_MS = 30000

/** URL 路径前缀相似度：取到倒数第 N 段作为前缀 */
const DASH_PREFIX_SEGMENTS = 3

/**
 * 提取 DASH 文件名前缀用于配对
 *
 * B站 DASH 文件名格式: {cid}-{quality}-{size}.m4s
 *   例: 42133030094-1-100026.m4s (audio) + 42133030094-1-30232.m4s (video)
 *   前缀: 42133030094-1 (cid + quality 相同 → 同一视频的音视频对)
 *
 * 通用格式: 取文件名中最后一个 `-` 之前的部分作为前缀
 *   例: xxx-yyy-zzz.m4s → xxx-yyy
 */
function getDashFileNamePrefix(fileName: string): string {
  const name = fileName.replace(/\.[^.]+$/, '')
  const lastDash = name.lastIndexOf('-')
  if (lastDash > 0) {
    return name.substring(0, lastDash)
  }
  return name
}

/**
 * 获取 URL 的路径前缀（去掉最后 N 段，用于配对相似度匹配）
 *
 * B站 DASH URL 示例:
 *   video: https://xy111xxyxplayvideo.bilivideo.com/xxx/xxx/xxx/index.m4s?...
 *   audio: https://xy111xxyxplayaudio.bilivideo.com/xxx/xxx/xxx/index.m4s?...
 * 共享前缀: /xxx/xxx/xxx (去掉域名差异和最后一段文件名)
 */
function getUrlPathPrefix(url: string, segments: number): string {
  try {
    const pathname = new URL(url).pathname
    const parts = pathname.split('/').filter(Boolean)
    const prefixParts = parts.slice(0, Math.max(0, parts.length - segments))
    return '/' + prefixParts.join('/')
  } catch {
    return ''
  }
}

/**
 * 判断 Content-Type 是否为 DASH 视频轨
 *
 * 匹配规则（按优先级）:
 *   1. 标准 video/* Content-Type (video/mp4, video/webm 等)
 *   2. 扩展名 m4s 且 URL 含 video 路径/域名关键字（排除 bilivideo.com 等误匹配）
 */
/**
 * 判断是否为 DASH 候选项（可能是 video 或 audio 轨）
 *
 * 严格判定：只有真正具备 DASH 协议特征的媒体才进入配对池。
 * 普通音视频文件（.mp4/.m4a/.mp3）和 HLS 分片（.ts/.m3u8）不参与配对。
 *
 * DASH 协议特征：
 *   1. 扩展名为 m4s — DASH CMAF (Common Media Application Format) 分片的标志性扩展名
 *   2. URL 明确含 DASH 特征（如 YouTube /videoplayback?itag=XXX）
 */
function isDashCandidate(item: MediaItem): boolean {
  const ct = item.contentType
  if (isDashVideoCT(ct, item.ext, item.url) || isDashAudioCT(ct, item.ext, item.url)) return true
  if (/^m4s$/i.test(item.ext)) return true
  if (item.url && /videoplayback/i.test(item.url) && /itag=\d+/i.test(item.url)) return true
  return false
}

/**
 * 判断 DASH 候选项的角色是否为 video 轨
 *
 * 仅在 isDashCandidate 为 true 的前提下调用。
 * 通过 CT + URL quality ID 区分音视频角色。
 * 注意：独立 .mp4 文件不经过此函数（isDashCandidate 已排除）。
 *
 * B站 DASH quality ID 规则：
 *   - 视频：100xxx（AV1）、200xxx（HEVC）、300xxx（AVC）
 *   - 音频：30xxx（AAC/FLAC/杜比全景声）
 *   URL 格式：.../{cid}-{qualityID}.m4s?...
 */
function isDashVideoCT(ct: string, ext?: string, url?: string): boolean {
  if (/^video\/(mp4|mp2t|webm|iso\.mp4)/i.test(ct)) {
    // B站 m4s 全部返回 video/mp4，需进一步检查 URL 中的 quality ID
    // 若 URL 含音频 quality ID (30xxx)，则 CT 的 video/mp4 是误判，应返回 false
    if (ext && url && /^m4s$/i.test(ext) && isBilibiliAudioQualityId(url)) {
      return false
    }
    return true
  }
  // m4s + URL 含 video 路径关键字
  if (ext && url && /^m4s$/i.test(ext) && /(?:playvideo|video\/)/i.test(url)) return true
  // m4s + URL 含 B站 视频 quality ID (100xxx/200xxx/300xxx)
  if (ext && url && /^m4s$/i.test(ext) && isBilibiliVideoQualityId(url)) return true
  return false
}

/**
 * 判断 DASH 候选项的角色是否为 audio 轨
 *
 * 仅在 isDashCandidate 为 true 的前提下调用。
 * 通过 CT + URL quality ID 区分音视频角色。独立 .m4a/.mp3 不经过此函数。
 *
 * B站 DASH quality ID 规则：
 *   - 音频：30280(HQ AAC)、30232(FLAC)、30216(杜比全景声) 等 30xxx
 *   URL 格式：.../{cid}-{qualityID}.m4s?...
 */
function isDashAudioCT(ct: string, ext?: string, url?: string): boolean {
  if (/^audio\/(mp4|mp2t|webm|aac|opus|iso\.mp4)/i.test(ct)) return true
  // m4s + URL 含 audio 路径关键字
  if (ext && url && /^m4s$/i.test(ext) && /(?:playaudio|audio\/)/i.test(url)) return true
  // m4s + URL 含 B站 音频 quality ID (30xxx)
  if (ext && url && /^m4s$/i.test(ext) && isBilibiliAudioQualityId(url)) return true
  return false
}

/**
 * 检测 URL 中是否含 B站 视频 quality ID
 *
 * B站 DASH 视频 quality ID 范围：
 *   - 100xxx: AV1 编码（如 100023=480P AV1, 100024=720P AV1, 100025=1080P AV1）
 *   - 200xxx: HEVC 编码（如 200023=480P HEVC, 200024=720P HEVC）
 *   - 300xxx: AVC 编码（如 300023=480P AVC, 300024=720P AVC）
 *
 * URL 格式示例：/upgcxcode/32/79/42651487932/42651487932-1-100023.m4s
 */
function isBilibiliVideoQualityId(url: string): boolean {
  // 匹配 URL 路径中的 {cid}-{part}-{qualityID}.m4s 模式
  const m = /(\d{3,})\.m4s/i.exec(url)
  if (!m) return false
  const qid = parseInt(m[1]!, 10)
  return (qid >= 100000 && qid < 400000)
}

/**
 * 检测 URL 中是否含 B站 音频 quality ID
 *
 * B站 DASH 音频 quality ID 范围：
 *   - 30xxx: 所有音频 quality（30280=HQ AAC, 30232=FLAC, 30216=杜比全景声, 30250=Hi-Res）
 *
 * URL 格式示例：/upgcxcode/32/79/42651487932/42651487932-1-30280.m4s
 */
function isBilibiliAudioQualityId(url: string): boolean {
  const m = /(\d{3,})\.m4s/i.exec(url)
  if (!m) return false
  const qid = parseInt(m[1]!, 10)
  return (qid >= 30000 && qid < 40000)
}

/**
 * 对指定 tab 的媒体列表执行 DASH 音视频配对
 *
 * DASH 流（B 站/YouTube 等）将音视频分轨传输：一个视频文件 + 一个音频文件，
 * 下载后需 FFmpeg 合并。本函数从同 tab 嗅探到的媒体项中找出配对的 video+audio。
 *
 * ┌─ 三级回退配对策略（按可靠性递降） ────────────────────────────────────────┐
 * │                                                                          │
 * │ ① 1v1 直配（行 786-802）                                                │
 * │    同 tab 只有 1 个 video + 1 个 audio → 直接配对                       │
 * │    最快路径，覆盖简单场景                                                │
 * │                                                                          │
 * │ ② 文件名前缀配对（行 804-847，策略 1）                                   │
 * │    B 站 DASH 文件名格式：{cid}-{quality}-{size}.m4s                     │
 * │    取最后一个 `-` 之前的部分作前缀，前缀相同 → 同一视频的音视频          │
 * │    最可靠，覆盖 B 站等大站                                              │
 * │                                                                          │
 * │ ③ URL 路径前缀相似度 + 时间窗口（行 849-896，策略 2）                    │
 * │    取 URL path 前 N 段（DASH_PREFIX_SEGMENTS=3），逐段比较相似度        │
 * │    相似度阈值：候选 ≤4 时 0.1（宽松），>4 时 0.3（严格，避免误并轨）     │
 * │    时间窗口 DASH_PAIR_WINDOW_MS=30s 内才配对                             │
 * │    覆盖 YouTube 等无文件名规律但 URL 路径相似的站点                      │
 * │                                                                          │
 * │ ④ 时间窗口最近邻兜底（行 898-929）                                       │
 * │    前三种都失败时，在 30s 窗口内找时间最近的 video+audio 配对            │
 * │    最后防线，可能误配但优于完全不配对                                    │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * 配对后会在 MediaItem 上标记 dashRole + dashGroupId，player-panel 据此显示
 * "合并下载 (V+A)" 按钮。
 *
 * 候选项分类规则（行 739-773）：
 *   - isDashCandidate：CT 为 video/audio/* 或扩展名 m4s
 *   - isDashVideoCT / isDashAudioCT：按 CT + URL 关键字（playvideo/playaudio）区分角色
 *   - 无法区分时按大小启发式：最大文件 → video，其余 → audio
 *
 * @returns 配对组列表（每组含一个 video MediaItem + 一个 audio MediaItem）
 */
export function pairDashItems(tabId: number): DashPair[] {
  const items = tabMediaMap.get(tabId)
  if (!items || items.length === 0) return []

  // ── 阶段 1：筛选 DASH 候选项（已配对的跳过，旧代际的跳过） ──────────────
  const currentGen = tabGenerationMap.get(tabId) ?? 0
  const candidates = items.filter((item) => {
    if (item.dashGroupId) return false
    if (item.generation !== undefined && item.generation < currentGen) return false
    return isDashCandidate(item)
  })

  if (candidates.length === 0) {
    logger.info('[sniffer] DASH pair: no candidates, tabId:', tabId)
    return []
  }

  logger.info('[sniffer] DASH pair: candidates:', candidates.length, 'tabId:', tabId,
    candidates.map((c) => ({ ext: c.ext, ct: c.contentType, size: c.size, url: c.url.slice(0, 60) })))

  // ── 阶段 2：按 CT/URL 关键字分类 video/audio，未分类项按大小启发式归类 ──
  let videoItemsBase = candidates.filter((item) => isDashVideoCT(item.contentType, item.ext, item.url))
  let audioItemsBase = candidates.filter((item) => isDashAudioCT(item.contentType, item.ext, item.url))

  // 对无法通过 CT/URL 区分角色的候选项，按大小启发式分类
  let unclassified = candidates.filter(
    (item) => !videoItemsBase.includes(item) && !audioItemsBase.includes(item),
  )

  // 同角色回退：当 CT 把所有候选项分为同一角色且无 unclassified 时
  // （如 B站 m4s 全部 CT=video/mp4），视为 CT 无法区分角色，
  // 全部降级为 unclassified 由 size 启发式重新分类
  if (unclassified.length === 0 && videoItemsBase.length > 1 && audioItemsBase.length === 0) {
    logger.info('[sniffer] DASH pair: all candidates classified as video by CT, falling back to size heuristic')
    unclassified = [...videoItemsBase]
    videoItemsBase = []
    audioItemsBase = []
  }
  if (unclassified.length === 0 && audioItemsBase.length > 1 && videoItemsBase.length === 0) {
    logger.info('[sniffer] DASH pair: all candidates classified as audio by CT, falling back to size heuristic')
    unclassified = [...audioItemsBase]
    videoItemsBase = []
    audioItemsBase = []
  }
  const videoItems = [...videoItemsBase]
  const audioItems = [...audioItemsBase]
  if (unclassified.length > 0) {
    logger.info('[sniffer] DASH pair: unclassified items:', unclassified.length,
      unclassified.map((u) => ({ size: u.size, url: u.url.slice(0, 60) })))
    // 按大小降序排列，最大的视为 video，其余视为 audio
    // 额外安全检查：若候选项 URL 含视频 quality ID，不应被分类为 audio
    const sorted = [...unclassified].sort((a, b) => b.size - a.size)
    for (let i = 0; i < sorted.length; i++) {
      if (i === 0 && sorted.length > 1) {
        videoItems.push(sorted[i]!)
      } else {
        // 安全检查：URL 含视频 quality ID 的候选项不应被当作 audio
        if (sorted[i]!.url && isBilibiliVideoQualityId(sorted[i]!.url)) {
          logger.warn('[sniffer] DASH pair: size heuristic classified item as audio, but URL contains video quality ID — skipping as audio candidate:', sorted[i]!.url.slice(0, 80))
          videoItems.push(sorted[i]!)
        } else {
          audioItems.push(sorted[i]!)
        }
      }
    }
  }

  logger.info('[sniffer] DASH pair: classified video:', videoItems.length, 'audio:', audioItems.length,
    'unclassified:', unclassified.length)

  if (videoItems.length === 0 || audioItems.length === 0) {
    logger.info('[sniffer] DASH pair: no video/audio pair possible, video:', videoItems.length, 'audio:', audioItems.length)
    return []
  }

  const pairs: DashPair[] = []
  const matchedVideoIds = new Set<string>()
  const matchedAudioIds = new Set<string>()
  let pairCounter = 0

  // ── 策略 ①：1v1 直配（同 tab 只有 1 个 video + 1 个 audio） ─────────
  if (videoItems.length === 1 && audioItems.length === 1) {
    const video = videoItems[0]!
    const audio = audioItems[0]!
    pairCounter++
    const groupId = `dash-${tabId}-${pairCounter}`
    const videoIdx = items.indexOf(video)
    const audioIdx = items.indexOf(audio)
    if (videoIdx >= 0) {
      items[videoIdx] = { ...video, dashRole: 'video' as DashRole, dashGroupId: groupId }
    }
    if (audioIdx >= 0) {
      items[audioIdx] = { ...audio, dashRole: 'audio' as DashRole, dashGroupId: groupId }
    }
    pairs.push({ groupId, video: items[videoIdx]!, audio: items[audioIdx]! })
    logger.info('[sniffer] DASH pair: simple 1v1 match, tabId:', tabId)
    return pairs
  }

  // ── 策略 ②：文件名前缀配对（B 站 {cid}-{quality}- 格式） ───────────
  //   取文件名最后一个 `-` 之前的部分作前缀，前缀相同视为同一视频的音视频
  const videoByPrefix = new Map<string, MediaItem[]>()
  const audioByPrefix = new Map<string, MediaItem[]>()
  for (const v of videoItems) {
    const prefix = getDashFileNamePrefix(v.fileName)
    let arr = videoByPrefix.get(prefix)
    if (!arr) { arr = []; videoByPrefix.set(prefix, arr) }
    arr.push(v)
  }
  for (const a of audioItems) {
    const prefix = getDashFileNamePrefix(a.fileName)
    let arr = audioByPrefix.get(prefix)
    if (!arr) { arr = []; audioByPrefix.set(prefix, arr) }
    arr.push(a)
  }

  for (const [prefix, vList] of videoByPrefix) {
    const aList = audioByPrefix.get(prefix)
    if (!aList || aList.length === 0) continue
    for (const video of vList) {
      if (matchedVideoIds.has(video.id)) continue
      for (const audio of aList) {
        if (matchedAudioIds.has(audio.id)) continue
        pairCounter++
        const groupId = `dash-${tabId}-${pairCounter}`
        const videoIdx = items.indexOf(video)
        const audioIdx = items.indexOf(audio)
        if (videoIdx >= 0) {
          items[videoIdx] = { ...video, dashRole: 'video' as DashRole, dashGroupId: groupId }
        }
        if (audioIdx >= 0) {
          items[audioIdx] = { ...audio, dashRole: 'audio' as DashRole, dashGroupId: groupId }
        }
        matchedVideoIds.add(video.id)
        matchedAudioIds.add(audio.id)
        pairs.push({ groupId, video: items[videoIdx]!, audio: items[audioIdx]! })
        break
      }
    }
  }

  if (pairs.length > 0) {
    logger.info('[sniffer] DASH pair: filename-prefix matched:', pairs.length, 'tabId:', tabId)
  }

  // ── 策略 ③：URL 路径前缀相似度 + 时间窗口配对（对未配对的候选项） ───
  //   取 URL path 前 N-3 段作前缀，逐段比较相似度
  //   阈值：候选 ≤4 时 0.1（宽松），>4 时 0.3（严格，避免误并轨）
  for (const video of videoItems) {
    if (matchedVideoIds.has(video.id)) continue

    const videoPrefix = getUrlPathPrefix(video.url, DASH_PREFIX_SEGMENTS)

    let bestAudio: MediaItem | null = null
    let bestScore = -1

    for (const audio of audioItems) {
      if (matchedAudioIds.has(audio.id)) continue

      const timeDiff = Math.abs(video.detectedAt - audio.detectedAt)
      if (timeDiff > DASH_PAIR_WINDOW_MS) continue

      const audioPrefix = getUrlPathPrefix(audio.url, DASH_PREFIX_SEGMENTS)
      const score = computePrefixSimilarity(videoPrefix, audioPrefix)
      if (score > bestScore) {
        bestScore = score
        bestAudio = audio
      }
    }

    const threshold = (videoItems.length + audioItems.length) <= 4 ? 0.1 : 0.3

    if (bestAudio && bestScore > threshold) {
      pairCounter++
      const groupId = `dash-${tabId}-${pairCounter}`

      const videoIdx = items.indexOf(video)
      if (videoIdx >= 0) {
        items[videoIdx] = { ...video, dashRole: 'video' as DashRole, dashGroupId: groupId }
      }
      const audioIdx = items.indexOf(bestAudio)
      if (audioIdx >= 0) {
        items[audioIdx] = { ...bestAudio, dashRole: 'audio' as DashRole, dashGroupId: groupId }
      }

      matchedVideoIds.add(video.id)
      matchedAudioIds.add(bestAudio.id)

      pairs.push({
        groupId,
        video: items[videoIdx]!,
        audio: items[audioIdx]!,
      })
    }
  }

  // ── 策略 ④：时间窗口最近邻兜底（前三种都失败时） ─────────────────
  //   在 30s 窗口内找时间最近的 video+audio 配对，可能误配但优于完全不配对
  if (pairs.length === 0 && videoItems.length > 0 && audioItems.length > 0) {
    logger.info('[sniffer] DASH pair: URL prefix matching failed, trying time-based fallback')
    for (const video of videoItems) {
      if (matchedVideoIds.has(video.id)) continue
      let bestAudio: MediaItem | null = null
      let minTimeDiff = Infinity
      for (const audio of audioItems) {
        if (matchedAudioIds.has(audio.id)) continue
        const timeDiff = Math.abs(video.detectedAt - audio.detectedAt)
        if (timeDiff < minTimeDiff && timeDiff <= DASH_PAIR_WINDOW_MS) {
          minTimeDiff = timeDiff
          bestAudio = audio
        }
      }
      if (bestAudio) {
        pairCounter++
        const groupId = `dash-${tabId}-${pairCounter}`
        const videoIdx = items.indexOf(video)
        const audioIdx = items.indexOf(bestAudio)
        if (videoIdx >= 0) {
          items[videoIdx] = { ...video, dashRole: 'video' as DashRole, dashGroupId: groupId }
        }
        if (audioIdx >= 0) {
          items[audioIdx] = { ...bestAudio, dashRole: 'audio' as DashRole, dashGroupId: groupId }
        }
        matchedVideoIds.add(video.id)
        matchedAudioIds.add(bestAudio.id)
        pairs.push({ groupId, video: items[videoIdx]!, audio: items[audioIdx]! })
      }
    }
  }

  if (pairs.length > 0) {
    logger.info('[sniffer] DASH pairs found:', pairs.length, 'tabId:', tabId)
  } else {
    logger.info('[sniffer] DASH pair: no pairs formed, video:', videoItems.length, 'audio:', audioItems.length, 'tabId:', tabId)
  }

  return pairs
}

/**
 * 计算两个路径前缀的相似度 (0~1)
 *
 * 逐段比较，相同段越多分数越高
 */
function computePrefixSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const segA = a.split('/').filter(Boolean)
  const segB = b.split('/').filter(Boolean)
  const minLen = Math.min(segA.length, segB.length)
  if (minLen === 0) return 0
  let match = 0
  for (let i = 0; i < minLen; i++) {
    if (segA[i] === segB[i]) {
      match++
    } else {
      const lenA = segA[i]!.length
      const lenB = segB[i]!.length
      const commonLen = longestCommonPrefix(segA[i]!, segB[i]!)
      if (commonLen > Math.max(lenA, lenB) * 0.5) {
        match += 0.5
      }
    }
  }
  return match / Math.max(segA.length, segB.length)
}

function longestCommonPrefix(a: string, b: string): number {
  const min = Math.min(a.length, b.length)
  let i = 0
  while (i < min && a[i] === b[i]) i++
  return i
}

/**
 * 获取指定 tab 的 DASH 配对组
 */
export function getDashPairs(tabId: number): DashPair[] {
  const items = tabMediaMap.get(tabId)
  if (!items || items.length === 0) return []

  const groupMap = new Map<string, { video?: MediaItem; audio?: MediaItem }>()
  for (const item of items) {
    if (!item.dashGroupId) continue
    let group = groupMap.get(item.dashGroupId)
    if (!group) {
      group = {}
      groupMap.set(item.dashGroupId, group)
    }
    if (item.dashRole === 'video') group.video = item
    else if (item.dashRole === 'audio') group.audio = item
  }

  const pairs: DashPair[] = []
  for (const [groupId, group] of groupMap) {
    if (group.video && group.audio) {
      pairs.push({ groupId, video: group.video, audio: group.audio })
    }
  }
  return pairs
}