/**
 * 下载客户端集成 — aria2 RPC + NDM WebSocket + velo push + 浏览器原生
 *
 * 移植自 NDM bg.js 的 _sendToAria2 + WebSocket 协议
 *
 * 四种客户端:
 *   aria2   - HTTP POST JSON-RPC 到 http://host:port/jsonrpc (Motrix/aria2/FDM 通用)
 *   ndm     - WebSocket ws://127.0.0.1:10007/download 子协议 neatextension.v1
 *   velo   - WebSocket ws://host:port JSON HlsPushMessage (velo/Motrix Lite 推送协议)
 *   native  - chrome.downloads.download (浏览器自带)
 */

import { logger } from '@/lib/logger'
import { persistentStorage } from '@/lib/storage'
import { DEFAULT_DOWNLOAD_CONFIG } from './types'
import type { DownloadClientConfig, HeaderForwardLevel } from './types'
import type { MediaDescriptor } from '@/types'
import { createPushClient } from '@/background/push-client'

const DOWNLOAD_CONFIG_KEY = 'downloadClientConfig'

/**
 * 加载下载客户端配置
 */
export async function getDownloadConfig(): Promise<DownloadClientConfig> {
  try {
    const stored = await persistentStorage.get<DownloadClientConfig>(DOWNLOAD_CONFIG_KEY)
    if (!stored) return DEFAULT_DOWNLOAD_CONFIG
    if (!stored.veloToken) {
      return { ...stored, veloToken: DEFAULT_DOWNLOAD_CONFIG.veloToken }
    }
    return stored
  } catch {
    return DEFAULT_DOWNLOAD_CONFIG
  }
}

/**
 * 保存下载客户端配置
 */
export async function setDownloadConfig(cfg: DownloadClientConfig): Promise<void> {
  await persistentStorage.set(DOWNLOAD_CONFIG_KEY, cfg)
}

/**
 * 发送 URL 到下载客户端
 *
 * @returns { success: boolean, message?: string }
 */
export async function sendToDownloadClient(
  url: string,
  fileName?: string,
  extra?: {
    pageUrl?: string | undefined
    contentType?: string | undefined
    contentDisposition?: string | undefined
    method?: string | undefined
    cookies?: string | undefined
    requestBody?: string | undefined
    requestHeaders?: Record<string, string> | undefined
    title?: string | undefined
    contentLength?: string | undefined
    priority?: string | undefined
  },
): Promise<{ success: boolean; message?: string }> {
  const cfg = await getDownloadConfig()

  if (pushClientInstance) {
    try {
      const headers = buildVeloHeaders(extra, cfg.headerLevel)
      const isM3u8 = isHlsMedia(url, extra?.contentType)
      const msg = {
        action: (isM3u8 ? 'push_url' : 'push_normal') as 'push_url' | 'push_normal',
        url,
        m3u8_text: undefined as string | undefined,
        base_url: undefined as string | undefined,
        content_type: extra?.contentType,
        content_disposition: extra?.contentDisposition,
        method: extra?.method ?? 'GET',
        post_data: extra?.requestBody,
        headers,
        options: {
          filename: fileName || extra?.title,
          output_dir: undefined as string | undefined,
          merge_format: isM3u8 ? cfg.mergeFormat : '',
          extra_headers: undefined as Record<string, string> | undefined,
        },
      }
      await pushClientInstance.push(msg)
      logger.info('[download] pushed via PushClient:', url.slice(0, 80))
      return { success: true }
    } catch (e) {
      logger.warn('[download] PushClient push failed, falling back to config:', (e as Error).message)
    }
  }

  try {
    switch (cfg.client) {
      case 'aria2':
        return await sendToAria2(url, fileName, cfg, extra)
      case 'ndm':
        return await sendToNdm(url, fileName, cfg, extra)
      case 'velo':
        return await sendToVelo(url, fileName, cfg, extra)
      case 'native':
      default:
        return await sendToNative(url, fileName)
    }
  } catch (e) {
    const msg = (e as Error).message
    logger.warn('[download] send failed:', msg)
    return { success: false, message: msg }
  }
}

/**
 * aria2 RPC (JSON-RPC 2.0)
 *
 * 兼容 Motrix / aria2 / FDM 等所有 aria2 协议客户端
 * POST http://host:port/jsonrpc
 *   method: aria2.addUri
 *   params: [token?, [url], { out: fileName }]
 *
 * 特殊处理：
 *   - `data:` URL → 落地为本地 .m3u8 文件，转 file:// 走 addUri（aria2 不支持 data: scheme）
 *   - m3u8 URL（HLS 媒体）→ 优先走 velo push 协议（让 velo 桌面端走 HLS 解析链路：
 *     fetch manifest → 解析分片 → 广告过滤 → aria2 下载每个 .ts → FFmpeg 合并）。
 *     velo push 不可用时回退 aria2 直传（让 Motrix/aria2 客户端自行处理 m3u8 合并）。
 */
export async function sendToAria2(
  url: string,
  fileName: string | undefined,
  cfg: DownloadClientConfig,
  extra?: {
    pageUrl?: string | undefined
    cookies?: string | undefined
    contentType?: string | undefined
    contentDisposition?: string | undefined
    method?: string | undefined
    requestBody?: string | undefined
    requestHeaders?: Record<string, string> | undefined
    title?: string | undefined
    contentLength?: string | undefined
    priority?: string | undefined
  },
  /** 跳过 m3u8 → velo push 分流（内部 data URL 落地后已是 file:// m3u8，无需再分流） */
  skipVeloRedirect?: boolean,
): Promise<{ success: boolean; message?: string }> {
  // m3u8 URL（非 data URL）→ 优先走 velo push 协议（HLS 解析链路）
  // 跳过条件：调用方明确要求（如 data URL 已落地为 file:// m3u8，velo 桌面端无法访问本机 file 路径）
  if (!skipVeloRedirect && !url.startsWith('data:') && isHlsMedia(url, extra?.contentType)) {
    logger.info('[download] m3u8 检测到，优先走 velo push 协议（HLS 解析链路）:', url.slice(0, 80))
    const veloResult = await sendToVelo(url, fileName, cfg, extra).catch((e) => ({
      success: false as const,
      message: (e as Error).message,
    }))
    if (veloResult.success) return veloResult
    // velo 不可用 → 回退 aria2 直传（下游客户端自行处理 m3u8）
    logger.warn('[download] velo push 失败，回退 aria2 直传:', veloResult.message, '— 下游需自行处理 m3u8 合并')
  }

  // data: URL → 落地为本地 file:// URL（aria2 不支持 data: scheme）
  let aria2Url = url
  if (url.startsWith('data:')) {
    // 落地文件名固定用 .m3u8 后缀（data URL 编码的是 m3u8 文本，不是合并后的 .ts）
    // aria2 的 out 参数仍用调用方传的 fileName（通常 .ts / .mp4），作为最终合并输出名
    const baseName = (fileName ?? 'velo_cleaned').replace(/\.[^.]+$/, '')
    const materialized = await materializeDataUrl(url, `${baseName}.m3u8`)
    if (!materialized.ok) return { success: false, message: materialized.error }
    aria2Url = materialized.fileUrl
    logger.info('[download] data URL 已落地为', aria2Url, '→ aria2.addUri')
  }

  const rpcUrl = cfg.rpcUrl
  const params: unknown[] = []
  if (cfg.rpcSecret) params.push(`token:${cfg.rpcSecret}`)
  params.push([aria2Url])
  const opts: Record<string, string | string[]> = {}
  if (fileName) opts.out = fileName

  // 构建 HTTP 头：根据 headerLevel 控制转发范围
  const level = cfg.headerLevel ?? 'full'
  const headers: string[] = []
  if (level !== 'none' && extra?.pageUrl) {
    try {
      headers.push(`Origin: ${new URL(extra.pageUrl).origin}`)
      let referer = extra.pageUrl.trim()
      const hashIdx = referer.lastIndexOf('#')
      referer = hashIdx < 0 || hashIdx < referer.indexOf('?') ? referer : referer.substring(0, hashIdx)
      headers.push(`Referer: ${referer}`)
    } catch { /* ignore */ }
  }
  if (level === 'full' && extra?.cookies) {
    headers.push(`Cookie: ${extra.cookies}`)
  }
  if (level !== 'none' && extra?.requestHeaders) {
    for (const [name, value] of Object.entries(extra.requestHeaders)) {
      // 过滤请求体相关头（这些是 POST body 的元数据，不应作为下载请求头透传）
      const lower = name.toLowerCase()
      if (lower === 'content-type' || lower === 'content-length' || lower === 'content-disposition') {
        continue
      }
      if (level === 'partial') {
        if (lower === 'cookie' || lower === 'authorization') {
          continue
        }
      }
      headers.push(`${name}: ${value}`)
    }
  }
  if (headers.length > 0) {
    opts.header = headers
  }

  params.push(opts)

  const rpcBody = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'aria2.addUri',
    params,
  })
  const MAX_RPC_RETRIES = 2
  const RPC_RETRY_BASE_MS = 500
  for (let attempt = 1; attempt <= MAX_RPC_RETRIES; attempt++) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: rpcBody,
      })
      if (!res.ok) {
        if (attempt < MAX_RPC_RETRIES) {
          await new Promise((r) => setTimeout(r, RPC_RETRY_BASE_MS * attempt))
          continue
        }
        return { success: false, message: `aria2 RPC HTTP ${res.status}` }
      }
      const json = (await res.json()) as { error?: { message: string }; result?: string }
      if (json.error) {
        return { success: false, message: json.error.message }
      }
      logger.info('[download] aria2.addUri →', json.result ?? '(no gid)')
      return { success: true }
    } catch (e) {
      if (attempt < MAX_RPC_RETRIES) {
        await new Promise((r) => setTimeout(r, RPC_RETRY_BASE_MS * attempt))
        continue
      }
      return { success: false, message: (e as Error).message }
    }
  }
  return { success: false, message: 'aria2 RPC failed after retries' }
}

/**
 * 判断 URL / Content-Type 是否为 HLS 媒体（m3u8 播放列表）
 *
 * 用于 aria2 模式下的 HLS 链路分流：
 *   - URL 后缀 .m3u8 / .m3u
 *   - Content-Type 含 mpegurl / m3u8（application/vnd.apple.mpegurl 等）
 */
export function isHlsMedia(url: string, contentType?: string): boolean {
  if (/\.m3u8?(\?|#|$)/i.test(url)) return true
  if (contentType && /(?:mpegurl|m3u8)/i.test(contentType)) return true
  return false
}

/**
 * data URL 落地为本地文件，返回 file:// URL
 *
 * aria2 不支持 `data:` scheme，需先用 chrome.downloads.download 把 data URL 写入下载目录，
 * 等下载完成后通过 chrome.downloads.search 取实际文件路径，构造 file:// URL。
 *
 * @param dataUrl  data: URL（base64 或 percent-encoded）
 * @param fileName 落地文件名（如 `xxx_cleaned.m3u8`）
 * @returns ok=true 时 fileUrl 为 `file:///abs/path/xxx_cleaned.m3u8`
 */
export function materializeDataUrl(
  dataUrl: string,
  fileName: string,
): Promise<{ ok: true; fileUrl: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    chrome.downloads.download(
      { url: dataUrl, filename: fileName, saveAs: false },
      (did) => {
        if (chrome.runtime.lastError || !did) {
          resolve({ ok: false, error: chrome.runtime.lastError?.message ?? '保存 data URL 失败' })
          return
        }
        const listener = (delta: chrome.downloads.DownloadDelta) => {
          if (delta.id !== did) return
          // 完成 → 取文件路径
          if (delta.state && delta.state.current === 'complete') {
            chrome.downloads.search({ id: did }, (items) => {
              chrome.downloads.onChanged.removeListener(listener)
              const fp = items[0]?.filename?.replace(/\\/g, '/')
              if (!fp) {
                resolve({ ok: false, error: '无法获取下载文件路径' })
                return
              }
              const fileUrl = `file://${fp.startsWith('/') ? '' : '/'}${fp}`
              resolve({ ok: true, fileUrl })
            })
            return
          }
          // 中断/失败
          if (delta.state && (delta.state.current === 'interrupted' || delta.state.current === 'error')) {
            chrome.downloads.onChanged.removeListener(listener)
            resolve({ ok: false, error: `data URL 落地失败: ${delta.state.current}` })
          }
        }
        chrome.downloads.onChanged.addListener(listener)
      },
    )
  })
}

/**
 * NDM WebSocket
 *
 * ws://127.0.0.1:10007/download 子协议 neatextension.v1
 * 协议：连上后发送 URL + headers，NDM 桌面端接收后开始下载
 */
let ndmWs: WebSocket | null = null
let ndmWsReady = false

export async function sendToNdm(
  url: string,
  fileName: string | undefined,
  cfg: DownloadClientConfig,
  extra?: { pageUrl?: string | undefined; contentType?: string | undefined; contentDisposition?: string | undefined; method?: string | undefined; cookies?: string | undefined; requestBody?: string | undefined; requestHeaders?: Record<string, string> | undefined; contentLength?: string | undefined; priority?: string | undefined },
): Promise<{ success: boolean; message?: string }> {
  return new Promise((resolve) => {
    try {
      if (ndmWs && ndmWsReady && ndmWs.readyState === WebSocket.OPEN) {
        ndmSendPayload(ndmWs, url, fileName, extra, cfg.headerLevel)
        resolve({ success: true })
        return
      }
      // 建立连接
      const ws = new WebSocket('ws://127.0.0.1:10007/download', 'neatextension.v1')
      const timeout = setTimeout(() => {
        ws.close()
        resolve({ success: false, message: 'NDM 连接超时（确保 NDM 桌面端已启动）' })
      }, 3000)
      ws.onopen = () => {
        clearTimeout(timeout)
        ndmWs = ws
        ndmWsReady = true
        ndmSendPayload(ws, url, fileName, extra, cfg.headerLevel)
        resolve({ success: true })
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        ndmWs = null
        ndmWsReady = false
        resolve({ success: false, message: 'NDM 连接失败（确保 NDM 桌面端已启动 + 端口 10007 开放）' })
      }
      ws.onclose = () => {
        ndmWs = null
        ndmWsReady = false
      }
    } catch (e) {
      resolve({ success: false, message: (e as Error).message })
    }
  })
}

function ndmSendPayload(ws: WebSocket, url: string, fileName: string | undefined, extra?: { pageUrl?: string | undefined; contentType?: string | undefined; contentDisposition?: string | undefined; method?: string | undefined; cookies?: string | undefined; requestBody?: string | undefined; requestHeaders?: Record<string, string> | undefined; contentLength?: string | undefined; priority?: string | undefined }, headerLevel?: HeaderForwardLevel): void {
  // NDM WebSocket 协议（多行键值，移植自 bg.js V.I）:
  const level = headerLevel ?? 'full'
  const method = extra?.method || 'GET'
  const pageUrl = extra?.pageUrl || ''
  const contentType = extra?.contentType || ''
  const contentDisposition = extra?.contentDisposition || ''
  const cookies = extra?.cookies || ''
  const requestBody = extra?.requestBody
  const requestHeaders = extra?.requestHeaders
  const contentLength = extra?.contentLength
  const priority = extra?.priority || 'normal'

  let b = `1:${method}\r\n`
  b += `2:${url}\r\n`
  // === NDM V.I: 6: priority (normal/media/hls) ===
  b += `6:${priority}\r\n`
  if (fileName) b += `4:${fileName}\r\n`
  // === NDM V.I: 5: pageUrl ===
  if (pageUrl) b += `5:${pageUrl}\r\n`
  if (level !== 'none' && pageUrl) {
    let c = pageUrl.trim()
    if (c) {
      try { b += `Origin: ${new URL(c).origin}\r\n` } catch { /* ignore */ }
      const d = c.lastIndexOf('#')
      c = d < 0 || d < c.indexOf('?') ? c : c.substring(0, d)
      b += `Referer: ${c}\r\n`
    }
  }
  if (level === 'full' && cookies) b += `Cookie: ${cookies}\r\n`
  if (contentType) b += `Content-Type: ${contentType}\r\n`
  if (contentDisposition) {
    b += `Content-Disposition: ${contentDisposition}\r\n`
  } else if (fileName) {
    b += `Content-Disposition: attachment; filename="${fileName}"\r\n`
  }
  // === NDM V.I: x-* 自定义头（只推送 x- 开头的头） ===
  // NDM: for (e in a) N(e.toLowerCase(),"x-") && (b += e + ": " + a[e] + "\r\n")
  if (level !== 'none' && requestHeaders) {
    for (const [name, value] of Object.entries(requestHeaders)) {
      const lower = name.toLowerCase()
      if (!lower.startsWith('x-')) continue
      if (level === 'partial' && (lower === 'x-cookie' || lower === 'x-authorization')) continue
      b += `${name}: ${value}\r\n`
    }
  }
  // POST body (移植自 NDM bg.js V.I: a.postData ? "__0NeatPostData9__:" + a.postData : "Content-Length: 0\r\n")
  // === NDM V.I: POST 时推送 7:(contentLength) + 8:(contentType) ===
  if (method === 'POST') {
    if (contentLength) b += `7:${contentLength}\r\n`
    if (contentType) b += `8:${contentType}\r\n`
    if (requestBody) {
      b += `__0NeatPostData9__:${requestBody}\r\n`
    } else {
      b += 'Content-Length: 0\r\n'
    }
  } else {
    // === NDM V.I: 非 POST + nowaiting 时也推送 7:(contentLength) + 8:(contentType) ===
    // NDM: "POST"!=a["1"] && this.C && (b+="8:"+a["8"]+"\r\n", b+="7:"+a["7"]+"\r\n")
    // velo 始终推送（无 waiting 协议，始终 nowaiting），让桌面端拿到完整元数据
    if (contentType) b += `8:${contentType}\r\n`
    if (contentLength) b += `7:${contentLength}\r\n`
    b += 'Content-Length: 0\r\n'
  }

  // === NDM bg.js V.I: payload 大小限制 ===
  // NDM: `!(118784 < b.length)` — 超过 ~116KB 不发送（防止超大 POST body 导致 WS 帧过大）
  if (b.length > 118784) {
    logger.warn('[download] NDM payload too large (' + b.length + ' bytes), skipping send — url:', url.slice(0, 80))
    return
  }

  logger.info('[download] NDM payload:\n', b)
  ws.send(b)
}

/**
 * 浏览器原生下载 (chrome.downloads.download)
 */
export async function sendToNative(
  url: string,
  fileName: string | undefined,
): Promise<{ success: boolean; message?: string }> {
  return new Promise((resolve) => {
    try {
      const opts: chrome.downloads.DownloadOptions = { url }
      if (fileName) opts.filename = fileName
      chrome.downloads.download(opts, (downloadId) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, message: chrome.runtime.lastError.message ?? 'unknown error' })
          return
        }
        logger.info('[download] native download started, id:', downloadId)
        resolve({ success: true })
      })
    } catch (e) {
      resolve({ success: false, message: (e as Error).message })
    }
  })
}

/**
 * velo push server (WebSocket JSON HlsPushMessage)
 *
 * 协议：ws://host:port，发送 JSON { token, action, url, ... }
 * velo (Motrix Lite) 接收后创建 HLS 下载任务
 *
 * 对应 velo velo-core HlsPushMessage 结构
 */
let veloWs: WebSocket | null = null
let veloWsReady = false

export async function sendToVelo(
  url: string,
  fileName: string | undefined,
  cfg: DownloadClientConfig,
  extra?: {
    pageUrl?: string | undefined
    contentType?: string | undefined
    contentDisposition?: string | undefined
    method?: string | undefined
    requestBody?: string | undefined
    cookies?: string | undefined
    requestHeaders?: Record<string, string> | undefined
    title?: string | undefined
    contentLength?: string | undefined
    priority?: string | undefined
  },
): Promise<{ success: boolean; message?: string }> {
  // === HEAD 预检（task 6） ===
  // 当 contentType 缺失 且 URL 是 http(s) 非 m3u8 非 data: 时，发 HEAD 请求获取元数据
  // 移植自 NDM bg.js W.I 行 86-91 的 HEAD 分支（velo 没有显式 waiting 协议，但我们
  // 始终在 CT 缺失时 HEAD 预检，让桌面端拿到完整 Content-Type/Disposition/Length）
  let finalExtra = extra
  if (
    extra
    && !extra.contentType
    && (url.startsWith('http://') || url.startsWith('https://'))
    && !isHlsMedia(url, extra.contentType)
    && !url.startsWith('data:')
  ) {
    const headInfo = await headPreflight(url, extra, cfg.headerLevel)
    if (headInfo) {
      finalExtra = {
        ...extra,
        contentType: headInfo.contentType ?? extra.contentType,
        contentDisposition: headInfo.contentDisposition ?? extra.contentDisposition,
      }
      logger.info(
        '[download] HEAD preflight completed: ct=', headInfo.contentType ?? '(none)',
        'size=', headInfo.size ?? '(unknown)',
        'url=', url.slice(0, 80),
      )
    }
  }

  const wsUrl = cfg.veloUrl
  return new Promise((resolve) => {
    try {
      if (veloWs && veloWsReady && veloWs.readyState === WebSocket.OPEN) {
        veloWsSendUrl(veloWs, url, fileName, cfg.veloToken, finalExtra, cfg.headerLevel)
        resolve({ success: true })
        return
      }
      const ws = new WebSocket(wsUrl)
      const timeout = setTimeout(() => {
        ws.close()
        resolve({ success: false, message: 'velo 连接超时（确保 velo 已启动并开启推送服务）' })
      }, 5000)
      ws.onopen = () => {
        clearTimeout(timeout)
        veloWs = ws
        veloWsReady = true
        veloWsSendUrl(ws, url, fileName, cfg.veloToken, finalExtra, cfg.headerLevel)
        resolve({ success: true })
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        veloWs = null
        veloWsReady = false
        resolve({ success: false, message: `velo 连接失败（确保 velo 已启动 + URL 可访问）` })
      }
      ws.onclose = () => {
        veloWs = null
        veloWsReady = false
      }
    } catch (e) {
      resolve({ success: false, message: (e as Error).message })
    }
  })
}

/**
 * velo 推送内联 m3u8 文本（data-url 投递模式专用）
 *
 * action: "push_m3u8" → velo 解析为 HlsSource::Inline
 * 直接推送 cleaned m3u8 文本，无需 data URL 编码
 */
export async function sendToVeloM3u8(
  m3u8Text: string,
  baseUrl: string,
  fileName: string | undefined,
  cfg: DownloadClientConfig,
  extra?: {
    pageUrl?: string | undefined
    cookies?: string | undefined
    requestHeaders?: Record<string, string> | undefined
  },
): Promise<{ success: boolean; message?: string }> {
  const wsUrl = cfg.veloUrl
  return new Promise((resolve) => {
    try {
      if (veloWs && veloWsReady && veloWs.readyState === WebSocket.OPEN) {
        veloWsSendM3u8(veloWs, m3u8Text, baseUrl, fileName, cfg.veloToken, extra, cfg.headerLevel)
        resolve({ success: true })
        return
      }
      const ws = new WebSocket(wsUrl)
      const timeout = setTimeout(() => {
        ws.close()
        resolve({ success: false, message: 'velo 连接超时（确保 velo 已启动并开启推送服务）' })
      }, 5000)
      ws.onopen = () => {
        clearTimeout(timeout)
        veloWs = ws
        veloWsReady = true
        veloWsSendM3u8(ws, m3u8Text, baseUrl, fileName, cfg.veloToken, extra, cfg.headerLevel)
        resolve({ success: true })
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        veloWs = null
        veloWsReady = false
        resolve({ success: false, message: `velo 连接失败（确保 velo 已启动 + URL 可访问）` })
      }
      ws.onclose = () => {
        veloWs = null
        veloWsReady = false
      }
    } catch (e) {
      resolve({ success: false, message: (e as Error).message })
    }
  })
}

/** 构建认证头集合（导出供测试用） */
/**
 * 从 MediaDescriptor 构建文件名（对齐 NDM bg.js V.V 中 b.fileName 构建逻辑）
 *
 * 优先级：Content-Disposition filename > URL 路径最后一段 > ext 回退
 * 去掉查询参数，保留扩展名
 */
function buildFileName(descriptor: MediaDescriptor): string {
  // 1. 从 Content-Disposition 提取 filename
  if (descriptor.contentDisposition) {
    const match = descriptor.contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)
    if (match?.[1]) {
      const name = match[1].replace(/['"]/g, '').trim()
      if (name) return name
    }
  }
  // 2. 从 URL 路径提取
  try {
    const pathname = new URL(descriptor.url).pathname
    const lastSegment = pathname.split('/').pop()?.split('?')[0]?.trim()
    if (lastSegment && lastSegment.includes('.')) return lastSegment
  } catch { /* ignore */ }
  // 3. 用 ext 回退
  if (descriptor.ext) return `download${descriptor.ext}`
  return ''
}

export function buildVeloHeaders(
  extra?: {
    pageUrl?: string | undefined
    cookies?: string | undefined
    requestHeaders?: Record<string, string> | undefined
  },
  level?: HeaderForwardLevel,
): Record<string, string> | undefined {
  const headers: Record<string, string> = {}
  const effectiveLevel = level ?? 'full'

  if (effectiveLevel === 'none') {
    return undefined
  }

  if (extra?.pageUrl) {
    try {
      headers['Origin'] = new URL(extra.pageUrl).origin
      let referer = extra.pageUrl.trim()
      const hashIdx = referer.lastIndexOf('#')
      referer = hashIdx < 0 || hashIdx < referer.indexOf('?') ? referer : referer.substring(0, hashIdx)
      headers['Referer'] = referer
    } catch { /* ignore */ }
  }

  if (effectiveLevel === 'full' && extra?.cookies) {
    headers['Cookie'] = extra.cookies
  }

  if (extra?.requestHeaders) {
    for (const [name, value] of Object.entries(extra.requestHeaders)) {
      const lower = name.toLowerCase()
      if (lower === 'content-type' || lower === 'content-length' || lower === 'content-disposition') {
        continue
      }
      if (effectiveLevel === 'partial') {
        if (lower === 'cookie' || lower === 'authorization') {
          continue
        }
      }
      headers[name] = value
    }
  }

  return Object.keys(headers).length > 0 ? headers : undefined
}

/**
 * HEAD 预检请求（移植自 NDM bg.js W.I 行 86-91 的 HEAD 分支）
 *
 * ## NDM 行为
 * NDM WS 服务器返回 "waiting" 时，对 GET 请求（无 Content-Type/Length）先发 HEAD
 * 获取响应头，再推送。对应 NDM bg.js:
 * ```js
 * var d = new XMLHttpRequest;
 * d.open("HEAD", a["2"], !0);
 * d.onreadystatechange = function() {
 *   4==d.readyState && (
 *     a["8"] = a["8"] || d.getResponseHeader("Content-Type") || "",
 *     a["7"] = a["7"] || d.getResponseHeader("Content-Length") || 0,
 *     c += "8:" + a["8"] + "\r\n", c += "7:" + a["7"] + "\r\n",
 *     b.B.send(c), b.h = null
 *   )
 * };
 * d.timeout = 8E3;
 * d.send()
 * ```
 *
 * ## velo 实现
 * velo-extension 没有显式的 "waiting" 协议消息，但我们仍然在 Content-Type 缺失时
 * 主动 HEAD 预检，让桌面端拿到完整元数据，避免桌面端重复探测。
 *
 * @param url 目标 URL（必须是 http/https）
 * @param extra 携带认证信息的 extra 对象（与 sendToVelo 一致）
 * @returns { contentType, contentDisposition, size } 或 null（HEAD 失败时）
 */
export async function headPreflight(
  url: string,
  extra?: { pageUrl?: string | undefined; cookies?: string | undefined; requestHeaders?: Record<string, string> | undefined },
  level?: HeaderForwardLevel,
): Promise<{ contentType?: string | undefined; contentDisposition?: string | undefined; size?: number | undefined } | null> {
  try {
    const init: RequestInit = {
      method: 'HEAD',
      cache: 'no-store',
      redirect: 'follow',
    }
    const headers: Record<string, string> = {}
    // 复用 buildVeloHeaders 的认证头集合（Origin/Referer/Cookie/x-*）
    const authHeaders = buildVeloHeaders(extra, level)
    if (authHeaders) {
      for (const [name, value] of Object.entries(authHeaders)) {
        headers[name] = value
      }
    }
    if (Object.keys(headers).length > 0) {
      init.headers = headers
    }
    // HEAD 请求超时 8s（与 NDM bg.js d.timeout = 8E3 一致）
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    init.signal = controller.signal
    try {
      const res = await fetch(url, init)
      if (!res.ok) {
        return null
      }
      const contentType = res.headers.get('Content-Type') ?? undefined
      const contentDisposition = res.headers.get('Content-Disposition') ?? undefined
      const lenStr = res.headers.get('Content-Length')
      const size = lenStr ? (parseInt(lenStr, 10) || undefined) : undefined
      return { contentType, contentDisposition, size }
    } finally {
      clearTimeout(timeout)
    }
  } catch (e) {
    logger.warn('[download] HEAD preflight failed:', (e as Error).message, 'url:', url.slice(0, 80))
    return null
  }
}

function veloWsSendUrl(ws: WebSocket, url: string, fileName: string | undefined, token: string, extra?: {
  pageUrl?: string | undefined
  contentType?: string | undefined
  contentDisposition?: string | undefined
  method?: string | undefined
  requestBody?: string | undefined
  cookies?: string | undefined
  requestHeaders?: Record<string, string> | undefined
}, headerLevel?: HeaderForwardLevel): void {
  const isM3u8 = /\.m3u8/i.test(url)
    || /mpegurl/i.test(extra?.contentType ?? '')
    || /m3u8/i.test(extra?.contentType ?? '')
  const action = isM3u8 ? 'push_url' : 'push_normal'
  const msg = {
    version: 1,
    token,
    action,
    url,
    base_url: undefined as string | undefined,
    // === Content-Type/Disposition 透传（移植自 NDM bg.js T() 函数 b["10"]/b["11"]） ===
    // velo 桌面端可优先使用这些字段而非自己探测，避免重复 HEAD 请求
    content_type: extra?.contentType ?? undefined,
    content_disposition: extra?.contentDisposition ?? undefined,
    // === HTTP 方法 + POST body 透传（移植自 NDM bg.js V.I __0NeatPostData9__） ===
    method: extra?.method ?? undefined,
    post_data: extra?.requestBody ?? undefined,
    headers: buildVeloHeaders(extra, headerLevel),
    options: {
      filename: fileName ?? undefined,
      output_dir: undefined as string | undefined,
      merge_format: isM3u8 ? 'mp4' : undefined as string | undefined,
      extra_headers: undefined as Record<string, string> | undefined,
    },
  }
  const payload = JSON.stringify(msg)
  logger.info(
    '[download] velo', action, '→', url,
    'headers:', msg.headers ? Object.keys(msg.headers) : 'none',
    'ct:', extra?.contentType ?? '(none)',
    'cd:', extra?.contentDisposition ? '(set)' : '(none)',
    'method:', extra?.method ?? 'GET',
  )
  ws.send(payload)
}

function veloWsSendM3u8(ws: WebSocket, m3u8Text: string, baseUrl: string, fileName: string | undefined, token: string, extra?: {
  pageUrl?: string | undefined
  cookies?: string | undefined
  requestHeaders?: Record<string, string> | undefined
}, headerLevel?: HeaderForwardLevel): void {
  const msg = {
    version: 1,
    token,
    action: 'push_m3u8',
    m3u8_text: m3u8Text,
    url: undefined as string | undefined,
    base_url: baseUrl || undefined,
    headers: buildVeloHeaders(extra, headerLevel),
    options: {
      filename: fileName ?? undefined,
      output_dir: undefined as string | undefined,
      merge_format: 'mp4',
      extra_headers: undefined as Record<string, string> | undefined,
    },
  }
  const payload = JSON.stringify(msg)
  logger.info('[download] velo push_m3u8 →', `${m3u8Text.length} chars, baseUrl=${baseUrl}`, 'headers:', msg.headers ? Object.keys(msg.headers) : 'none')
  ws.send(payload)
}

/**
 * velo 推送 DASH 音视频合并下载任务
 *
 * action: "push_dash" → velo 解析为 HlsSource::Dash
 * 同时推送 video_url + audio_url，velo 下载后用 FFmpeg 合并为完整音视频
 */
export async function sendToVeloDash(
  videoUrl: string,
  audioUrl: string,
  fileName: string | undefined,
  cfg: DownloadClientConfig,
  extra?: {
    pageUrl?: string | undefined
    cookies?: string | undefined
    requestHeaders?: Record<string, string> | undefined
  },
): Promise<{ success: boolean; message?: string }> {
  const wsUrl = cfg.veloUrl
  return new Promise((resolve) => {
    try {
      if (veloWs && veloWsReady && veloWs.readyState === WebSocket.OPEN) {
        veloWsSendDash(veloWs, videoUrl, audioUrl, fileName, cfg.veloToken, extra, cfg.headerLevel)
        resolve({ success: true })
        return
      }
      const ws = new WebSocket(wsUrl)
      const timeout = setTimeout(() => {
        ws.close()
        resolve({ success: false, message: 'velo 连接超时（确保 velo 已启动并开启推送服务）' })
      }, 5000)
      ws.onopen = () => {
        clearTimeout(timeout)
        veloWs = ws
        veloWsReady = true
        veloWsSendDash(ws, videoUrl, audioUrl, fileName, cfg.veloToken, extra, cfg.headerLevel)
        resolve({ success: true })
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        veloWs = null
        veloWsReady = false
        resolve({ success: false, message: `velo 连接失败（确保 velo 已启动 + URL 可访问）` })
      }
      ws.onclose = () => {
        veloWs = null
        veloWsReady = false
      }
    } catch (e) {
      resolve({ success: false, message: (e as Error).message })
    }
  })
}

function veloWsSendDash(ws: WebSocket, videoUrl: string, audioUrl: string, fileName: string | undefined, token: string, extra?: {
  pageUrl?: string | undefined
  cookies?: string | undefined
  requestHeaders?: Record<string, string> | undefined
}, headerLevel?: HeaderForwardLevel): void {
  const msg = {
    version: 1,
    token,
    action: 'push_dash',
    video_url: videoUrl,
    audio_url: audioUrl,
    url: undefined as string | undefined,
    m3u8_text: undefined as string | undefined,
    base_url: undefined as string | undefined,
    headers: buildVeloHeaders(extra, headerLevel),
    options: {
      filename: fileName ?? undefined,
      output_dir: undefined as string | undefined,
      merge_format: 'mp4',
      extra_headers: undefined as Record<string, string> | undefined,
    },
  }
  const payload = JSON.stringify(msg)
  logger.info('[download] velo push_dash → video:', videoUrl.slice(0, 80), 'audio:', audioUrl.slice(0, 80), 'headers:', msg.headers ? Object.keys(msg.headers) : 'none')
  ws.send(payload)
}

/** PushClient 实例注入（供 background.ts 调用） */
let pushClientInstance: ReturnType<typeof createPushClient> | null = null

export function setPushClient(client: ReturnType<typeof createPushClient> | null): void {
  pushClientInstance = client
}

export function getPushClient(): ReturnType<typeof createPushClient> | null {
  return pushClientInstance
}

/**
 * 同步下载配置缓存（移植自 NDM bg.js _dlConfig）
 *
 * NDM 行 24-33: `var _dlConfig = { client: 'ndm', ... }` 同步读，避免每次下载都 await storage
 * 初始化时从 storage 加载，storage.onChanged 时实时更新
 *
 * 用途：onHeadersReceived 等同步回调中需要判断客户端类型，
 * 无法 await getDownloadConfig()，改用此同步缓存
 */
let _cachedConfig: DownloadClientConfig = { ...DEFAULT_DOWNLOAD_CONFIG }

export function getCachedDownloadConfig(): DownloadClientConfig {
  return _cachedConfig
}

export async function initCachedDownloadConfig(): Promise<void> {
  _cachedConfig = await getDownloadConfig()
}

export function updateCachedDownloadConfig(cfg: DownloadClientConfig): void {
  _cachedConfig = cfg
}

/** 推送 HLS m3u8 到 velo 桌面端 */
export async function pushHls(
  descriptor: MediaDescriptor,
  m3u8Text: string,
  options?: { mergeFormat?: string },
  extra?: { pageUrl?: string; cookies?: string; requestHeaders?: Record<string, string>; title?: string },
): Promise<void> {
  if (!pushClientInstance) {
    throw new Error('Push client not initialized')
  }
  const fileName = buildFileName(descriptor)
  const level = _cachedConfig.headerLevel
  const msg = {
    action: 'push_m3u8' as const,
    m3u8_text: m3u8Text,
    url: undefined as string | undefined,
    base_url: descriptor.url,
    content_type: descriptor.contentType || 'application/vnd.apple.mpegurl',
    content_disposition: descriptor.contentDisposition || undefined,
    method: descriptor.method || 'GET',
    headers: buildVeloHeaders(extra, level),
    options: {
      filename: fileName || undefined,
      output_dir: undefined as string | undefined,
      merge_format: options?.mergeFormat ?? _cachedConfig.mergeFormat ?? 'ts',
      extra_headers: undefined as Record<string, string> | undefined,
    },
  }
  await pushClientInstance.push(msg)
}

/** 推送 URL 到 velo 桌面端 */
export async function pushUrl(
  url: string,
  descriptor: MediaDescriptor,
  options?: { mergeFormat?: string },
  extra?: { pageUrl?: string; cookies?: string; requestHeaders?: Record<string, string>; title?: string },
): Promise<void> {
  if (!pushClientInstance) {
    throw new Error('Push client not initialized')
  }
  const isM3u8 = isHlsMedia(url, descriptor.contentType)
  const fileName = buildFileName(descriptor)
  const level = _cachedConfig.headerLevel
  const msg = {
    action: (isM3u8 ? 'push_url' : 'push_normal') as 'push_url' | 'push_normal',
    url,
    m3u8_text: undefined as string | undefined,
    base_url: undefined as string | undefined,
    content_type: descriptor.contentType || undefined,
    content_disposition: descriptor.contentDisposition || undefined,
    method: descriptor.method || 'GET',
    headers: buildVeloHeaders(extra, level),
    options: {
      filename: fileName || undefined,
      output_dir: undefined as string | undefined,
      merge_format: isM3u8 ? (options?.mergeFormat ?? _cachedConfig.mergeFormat ?? 'ts') : '',
      extra_headers: undefined as Record<string, string> | undefined,
    },
  }
  await pushClientInstance.push(msg)
}

/** 推送普通媒体到 velo 桌面端 */
export async function pushNormal(
  descriptor: MediaDescriptor,
  extra?: { pageUrl?: string; cookies?: string; requestHeaders?: Record<string, string>; title?: string },
): Promise<void> {
  if (!pushClientInstance) {
    throw new Error('Push client not initialized')
  }
  const isM3u8 = descriptor.contentType?.includes('mpegurl') || descriptor.ext === '.m3u8'
  const fileName = buildFileName(descriptor)
  const level = _cachedConfig.headerLevel
  const msg = {
    action: 'push_normal' as const,
    url: descriptor.url,
    m3u8_text: undefined as string | undefined,
    base_url: undefined as string | undefined,
    content_type: descriptor.contentType || undefined,
    content_disposition: descriptor.contentDisposition || undefined,
    method: descriptor.method || 'GET',
    headers: buildVeloHeaders(extra, level),
    options: {
      filename: fileName || undefined,
      output_dir: undefined as string | undefined,
      merge_format: isM3u8 ? (_cachedConfig.mergeFormat ?? 'ts') : '',
      extra_headers: undefined as Record<string, string> | undefined,
    },
  }
  await pushClientInstance.push(msg)
}