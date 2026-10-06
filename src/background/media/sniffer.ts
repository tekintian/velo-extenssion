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
import type { MediaItem, DashPair, DashRole } from './types'
import { buildConfig, DEFAULT_CONFIG, processPlaylist } from '@/engine/hls/hls-filter'
import { persistentStorage } from '@/lib/storage'
import { settingsStore } from '@/lib/storage'
import { DEFAULT_SETTINGS } from '@/types'

/** NDM 的 B 正则：媒体扩展名（嗅探所有音视频，但 .ts 分片除外 — 太多无意义） */
const MEDIA_EXT_RE = /^(?:FLV|SWF|MP3|MP4|M4V|F4F|F4V|M4A|M4S|MPG|MPEG|MPEG4|MPE|AVI|WMV|WMA|WAV|WAVE|ASF|RM|RAM|OGG|OGV|OGM|OGA|MOV|MID|MIDI|3GP|3GPP|QT|WEBM|MKV|AAC|RMVB|VTT|SRT|M3U8|M3U)$/i

/** 非下载的页面资源扩展名 */
const NON_DOWNLOAD_EXT_RE = /^(?:HTM|HTML|MHT|MHTML|SHTML|SHTM|XHT|XHTM|XHTML|XML|TXT|CSS|JS|JSON|GIF|ICO|JPEG|JPG|PNG|WEBP|BMP|SVG|TIF|TIFF|PDF|PHP|ASP|ASPX|EOT|TTF|WOF|WOFF|WOFF2|MSG|PEM|BR|OTF|ACZ|AZC|CGI|TPL|OSD|DO|DICT)$/i

/** .ts 分片不嗅探（HLS 分片太多，单独下载无意义，应通过 m3u8 整体下载） */
const TS_EXT = 'ts'

/** NDM 的 ba 正则：强制下载的 Content-Type */
const FORCE_DOWNLOAD_CT_RE = /^(?:application\/x-apple-diskimage|application\/download|application\/force-download|application\/x-msdownload|binary\/octet-stream)$/i

/** 跳过的 URL 文件名片段（manifest / favicon 等） */
const SKIP_URL_FRAGMENTS = ['manif', 'favicon.ico', 'pem.msg', '.wasm', '.json', '.dict']

/** per-tab 媒体列表 */
const tabMediaMap = new Map<number, MediaItem[]>()

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
  readonly requestBody?: string | undefined
  readonly requestHeaders?: Record<string, string> | undefined
}

const pendingRequests = new Map<string, PendingRequest>()

type M3u8OutputHandler = (
  result: unknown,
  ctx: { m3u8Url: string; pageHost: string; tabId: number; sniffedHeaders?: Record<string, string> },
) => Promise<void> | void

let _m3u8OutputHandler: M3u8OutputHandler | null = null

export function setM3u8OutputHandler(handler: M3u8OutputHandler | null): void {
  _m3u8OutputHandler = handler
}

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
let onBeforeRequestListener: ((details: chrome.webRequest.OnBeforeRequestDetails) => undefined) | null = null
let onBeforeSendHeadersListener: ((details: chrome.webRequest.OnBeforeSendHeadersDetails) => undefined) | null = null
let onHeadersReceivedListener: ((details: chrome.webRequest.OnHeadersReceivedDetails) => undefined) | null = null

export function startSniffer(): void {
  if (initialized) return
  initialized = true

  onBeforeRequestListener = (details: chrome.webRequest.OnBeforeRequestDetails): undefined => {
    if (details.tabId < 0 || details.frameId < 0) return undefined
    if (!details.url || !/^https?:\/\//.test(details.url)) return undefined
    let requestBody: string | undefined
    if (details.method === 'POST' && details.requestBody) {
      const raw = details.requestBody.raw
      if (raw && raw.length > 0) {
        try {
          const dec = new TextDecoder()
          requestBody = dec.decode(raw[0]!.bytes)
        } catch {
          // ignore
        }
      }
    }
    pendingRequests.set(details.requestId, {
      url: details.url,
      method: details.method,
      resourceType: details.type,
      tabId: details.tabId,
      frameId: details.frameId,
      generation: tabGenerationMap.get(details.tabId) ?? 0,
      requestBody,
    })
    return undefined
  }
  chrome.webRequest.onBeforeRequest.addListener(
    onBeforeRequestListener as (details: chrome.webRequest.OnBeforeRequestDetails) => undefined,
    { urls: ['http://*/*', 'https://*/*'] },
    ['requestBody'],
  )

  // 记录请求头 — 收集 User-Agent + x-* 自定义头 + 关键认证头供下载客户端使用
  // 确保推送下载时携带完整页面认证信息，使"看见即可下载"
  onBeforeSendHeadersListener = (details: chrome.webRequest.OnBeforeSendHeadersDetails): undefined => {
    const pending = pendingRequests.get(details.requestId)
    if (!pending) return undefined
    const authHeaders: Record<string, string> = {}
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
      }
    }
    if (Object.keys(authHeaders).length > 0) {
      pendingRequests.set(details.requestId, { ...pending, requestHeaders: authHeaders })
    }
    return undefined
  }
  chrome.webRequest.onBeforeSendHeaders.addListener(
    onBeforeSendHeadersListener as (details: chrome.webRequest.OnBeforeSendHeadersDetails) => undefined,
    { urls: ['http://*/*', 'https://*/*'] },
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
        const ext = (fileNameFromCD ? getExt(fileNameFromCD) : '') || getExt(urlFileName)

        if (SKIP_URL_FRAGMENTS.some((f) => urlPath.toLowerCase().includes(f))) {
          pendingRequests.delete(details.requestId)
          return undefined
        }
        if (pending.resourceType === 'image' && /^image\//i.test(contentType)) {
          pendingRequests.delete(details.requestId)
          return undefined
        }
        if (ext && !MEDIA_EXT_RE.test(ext) && NON_DOWNLOAD_EXT_RE.test(ext)) {
          pendingRequests.delete(details.requestId)
          return undefined
        }

        const isAttachment = /attachment/i.test(contentDisposition)
        const isVideoAudioCT = /^(?:video|audio)\//i.test(contentType) || /mpegurl/i.test(contentType) || /m3u8/i.test(contentType)
        const isForceDownloadCT = FORCE_DOWNLOAD_CT_RE.test(contentType)
        const isMediaExt = ext && MEDIA_EXT_RE.test(ext)
        const isTsSegment = ext.toLowerCase() === TS_EXT

        const sniffable =
          !isTsSegment &&
          (isMediaExt ||
            isAttachment ||
            isForceDownloadCT ||
            isVideoAudioCT)

        if (!sniffable) {
          pendingRequests.delete(details.requestId)
          return undefined
        }

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
    { urls: ['http://*/*', 'https://*/*'] },
    ['responseHeaders'],
  )

  chrome.webRequest.onCompleted.addListener(
    ((details: chrome.webRequest.OnCompletedDetails): undefined => {
      pendingRequests.delete(details.requestId)
      return undefined
    }) as (details: chrome.webRequest.OnCompletedDetails) => undefined,
    { urls: ['http://*/*', 'https://*/*'] },
  )
  chrome.webRequest.onErrorOccurred.addListener(
    ((details: chrome.webRequest.OnErrorOccurredDetails): undefined => {
      pendingRequests.delete(details.requestId)
      return undefined
    }) as (details: chrome.webRequest.OnErrorOccurredDetails) => undefined,
    { urls: ['http://*/*', 'https://*/*'] },
  )

  chrome.tabs.onRemoved.addListener((tabId) => {
    tabMediaMap.delete(tabId)
    tabGenerationMap.delete(tabId)
  })

  // webNavigation.onHistoryStateUpdated — SPA 路由变化时清理旧媒体项、递增代际号并通知 player-panel 刷新
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.tabId >= 0) {
      tabMediaMap.delete(details.tabId)
      const prevGen = tabGenerationMap.get(details.tabId) ?? 0
      tabGenerationMap.set(details.tabId, prevGen + 1)
      logger.info('[sniffer] SPA navigation: tabId:', details.tabId, 'generation:', prevGen, '→', prevGen + 1)
      void chrome.tabs.sendMessage(details.tabId, { type: 'pageUrlChanged', url: details.url }).catch(() => {})
    }
  })

  // downloads.onCreated — 拦截浏览器原生下载，如果 URL 匹配嗅探到的媒体 (移植自 NDM bg.js V.X)
  chrome.downloads.onCreated.addListener((item) => {
    if (!item.url) return
    // 检查是否是嗅探到的媒体 URL（匹配所有 tab 的 media items）
    for (const [, items] of tabMediaMap) {
      if (items.some((m) => m.url === item.url || m.url === item.finalUrl)) {
        // 取消浏览器下载（让 NDM/Motrix 处理）
        chrome.downloads.cancel(item.id, () => {
          chrome.downloads.erase({ id: item.id })
        })
        return
      }
    }
  })

  // action.onClicked — 工具栏开关嗅探 (移植自 NDM bg.js V.M)
  chrome.action.onClicked.addListener((tab) => {
    // 只在没有 popup 时才用 action.onClicked（有 popup 时点击打开 popup）
    // 这里不实现，因为我们有 popup
    void tab
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
      onBeforeRequestListener as (details: chrome.webRequest.OnBeforeRequestDetails) => undefined,
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
    const res = await fetch(m3u8Url, fetchInit)
    if (!res.ok) {
      logger.warn('[sniffer] fetch m3u8 failed:', res.status)
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
        mode: ((fpCfg.mode as string) ?? 'm3u8-file') as 'data-url' | 'enumerate' | 'passthrough' | 'm3u8-file' | 'disabled',
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

    // 5. 输出阶段 — 如果有注入的 handler，完全由 handler 接管；否则走默认流程
    if (_m3u8OutputHandler) {
      const ctx: { m3u8Url: string; pageHost: string; tabId: number; sniffedHeaders?: Record<string, string> } = { m3u8Url, pageHost, tabId }
      if (sniffedHeaders) ctx.sniffedHeaders = sniffedHeaders
      await _m3u8OutputHandler(result, ctx)
      return
    }

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

function extractBaseName(m3u8Url: string): string {
  const BAD_SEG_RE = /^(?:index|home|homepage|main|default|start|top|bottom|left|right|middle|center|content|body|page|p|menu|header|footer|sidebar|aside|section|wrapper|container|app|root|layout|component|video|player|online|play|h5|web|mixed|playlist|master|vod|hls|dash|audio|segment|segments|ts|m3u8|mp4|flv|3gp|img|images|image|photo|pic|thumb|thumbnail|cdn|static|public|assets|resource|resources|file|files|stream|streams|media|live|origin|backup|temp|tmp|cache|downloads|download|upload|uploads|api|admin|user|login|register|auth|profile|search|list|all|new|create|edit|delete|update|view|show|add|remove)$/i
  try {
    const u = new URL(m3u8Url)
    const segs = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
    let name = segs
      .map((s) => s.replace(/\.[^.]+$/, ''))
      .filter((s) => s.length >= 2 && !BAD_SEG_RE.test(s))
      .join('_')
    if (!name) name = u.hostname.replace(/^www\./, '')
    name = name.replace(/[\\/:*?"<>|\s]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
    if (name.length > 50) name = name.slice(-50)
    return name || 'video'
  } catch {
    return 'video'
  }
}

export function getMediaItems(tabId: number): MediaItem[] {
  return tabMediaMap.get(tabId) ?? []
}

export function clearMediaItems(tabId: number): void {
  tabMediaMap.delete(tabId)
}

/**
 * 外部添加媒体项（站点特殊抓取 content script 调用）
 */
export function addMediaItemExternal(tabId: number, url: string, label: string, ext: string): void {
  const item: MediaItem = {
    id: `external-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url,
    method: 'GET',
    resourceType: 'external',
    contentType: '',
    contentDisposition: '',
    size: 0,
    fileName: label,
    ext: ext.toLowerCase(),
    tabId,
    detectedAt: Date.now(),
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
function isDashVideoCT(ct: string, ext?: string, url?: string): boolean {
  if (/^video\/(mp4|mp2t|webm|iso\.mp4)/i.test(ct)) return true
  if (ext && url && /^m4s$/i.test(ext) && /(?:playvideo|video\/)/i.test(url)) return true
  return false
}

/**
 * 判断 Content-Type 是否为 DASH 音频轨
 *
 * 匹配规则（按优先级）:
 *   1. 标准 audio/* Content-Type (audio/mp4, audio/aac 等)
 *   2. 扩展名 m4s 且 URL 含 audio 路径/域名关键字（排除 biliaudio 等误匹配）
 */
function isDashAudioCT(ct: string, ext?: string, url?: string): boolean {
  if (/^audio\/(mp4|mp2t|webm|aac|opus|iso\.mp4)/i.test(ct)) return true
  if (ext && url && /^m4s$/i.test(ext) && /(?:playaudio|audio\/)/i.test(url)) return true
  return false
}

/**
 * 判断是否为 DASH 候选项（可能是 video 或 audio 轨）
 *
 * 综合判断：Content-Type 匹配 或 扩展名为 m4s（DASH 协议标志性扩展名）
 */
function isDashCandidate(item: MediaItem): boolean {
  const ct = item.contentType
  if (isDashVideoCT(ct, item.ext, item.url) || isDashAudioCT(ct, item.ext, item.url)) return true
  if (/^m4s$/i.test(item.ext)) return true
  return false
}

/**
 * 对指定 tab 的媒体列表执行 DASH 音视频配对
 *
 * 配对算法:
 *   1. 筛选 DASH 候选项：contentType 为 video/* 或 audio/* 或 m4s+octet-stream
 *   2. 对候选项分类：基于 CT+URL关键字 判断 video/audio 角色
 *   3. 无法通过 CT/URL 区分角色时，按大小启发式：大文件→video，小文件→audio
 *   4. 在同组内按 URL 路径前缀相似度 + 时间窗口配对
 *   5. 标记 dashRole + dashGroupId
 *
 * @returns 配对组列表
 */
export function pairDashItems(tabId: number): DashPair[] {
  const items = tabMediaMap.get(tabId)
  if (!items || items.length === 0) return []

  const candidates = items.filter((item) => {
    if (item.dashGroupId) return false
    return isDashCandidate(item)
  })

  if (candidates.length === 0) {
    logger.info('[sniffer] DASH pair: no candidates, tabId:', tabId)
    return []
  }

  logger.info('[sniffer] DASH pair: candidates:', candidates.length, 'tabId:', tabId,
    candidates.map((c) => ({ ext: c.ext, ct: c.contentType, size: c.size, url: c.url.slice(0, 60) })))

  const videoItemsBase = candidates.filter((item) => isDashVideoCT(item.contentType, item.ext, item.url))
  const audioItemsBase = candidates.filter((item) => isDashAudioCT(item.contentType, item.ext, item.url))

  // 对无法通过 CT/URL 区分角色的候选项，按大小启发式分类
  const unclassified = candidates.filter(
    (item) => !videoItemsBase.includes(item) && !audioItemsBase.includes(item),
  )
  const videoItems = [...videoItemsBase]
  const audioItems = [...audioItemsBase]
  if (unclassified.length > 0) {
    logger.info('[sniffer] DASH pair: unclassified items:', unclassified.length,
      unclassified.map((u) => ({ size: u.size, url: u.url.slice(0, 60) })))
    // 按大小降序排列，最大的视为 video，其余视为 audio
    const sorted = [...unclassified].sort((a, b) => b.size - a.size)
    for (let i = 0; i < sorted.length; i++) {
      if (i === 0 && sorted.length > 1) {
        videoItems.push(sorted[i]!)
      } else {
        audioItems.push(sorted[i]!)
      }
    }
  }

  if (videoItems.length === 0 || audioItems.length === 0) {
    logger.info('[sniffer] DASH pair: no video/audio pair possible, video:', videoItems.length, 'audio:', audioItems.length)
    return []
  }

  const pairs: DashPair[] = []
  const matchedVideoIds = new Set<string>()
  const matchedAudioIds = new Set<string>()
  let pairCounter = 0

  // 简单情况：同 tab 内只有 1 个 video + 1 个 audio → 直接配对
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

  // 策略1: 文件名前缀配对（最可靠，B站: {cid}-{quality}- 前缀相同 → 同一视频）
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

  // 策略2: URL 路径前缀相似度配对（对未配对的候选项）
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

  // 如果 URL 前缀配对失败，尝试按时间窗口内最近的 video+audio 配对
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
