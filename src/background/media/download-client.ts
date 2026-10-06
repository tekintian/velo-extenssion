/**
 * 下载客户端集成 — aria2 RPC + NDM WebSocket + sdown push + 浏览器原生
 *
 * 移植自 NDM bg.js 的 _sendToAria2 + WebSocket 协议
 *
 * 四种客户端:
 *   aria2   - HTTP POST JSON-RPC 到 http://host:port/jsonrpc (Motrix/aria2/FDM 通用)
 *   ndm     - WebSocket ws://127.0.0.1:10007/download 子协议 neatextension.v1
 *   sdown   - WebSocket ws://host:port JSON HlsPushMessage (sdown/Motrix Lite 推送协议)
 *   native  - chrome.downloads.download (浏览器自带)
 */

import { logger } from '@/lib/logger'
import { persistentStorage } from '@/lib/storage'
import { DEFAULT_DOWNLOAD_CONFIG } from './types'
import type { DownloadClientConfig } from './types'

const DOWNLOAD_CONFIG_KEY = 'downloadClientConfig'

/**
 * 加载下载客户端配置
 */
export async function getDownloadConfig(): Promise<DownloadClientConfig> {
  try {
    const stored = await persistentStorage.get<DownloadClientConfig>(DOWNLOAD_CONFIG_KEY)
    if (!stored) return DEFAULT_DOWNLOAD_CONFIG
    if (!stored.sdownToken) {
      return { ...stored, sdownToken: DEFAULT_DOWNLOAD_CONFIG.sdownToken }
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
  },
): Promise<{ success: boolean; message?: string }> {
  const cfg = await getDownloadConfig()
  try {
    switch (cfg.client) {
      case 'aria2':
        return await sendToAria2(url, fileName, cfg, extra)
      case 'ndm':
        return await sendToNdm(url, fileName, extra)
      case 'sdown':
        return await sendToSdown(url, fileName, cfg, extra)
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
 */
export async function sendToAria2(
  url: string,
  fileName: string | undefined,
  cfg: DownloadClientConfig,
  extra?: {
    pageUrl?: string | undefined
    cookies?: string | undefined
    requestHeaders?: Record<string, string> | undefined
  },
): Promise<{ success: boolean; message?: string }> {
  const rpcUrl = `http://${cfg.rpcHost}:${cfg.rpcPort}/jsonrpc`
  const params: unknown[] = []
  if (cfg.rpcSecret) params.push(`token:${cfg.rpcSecret}`)
  params.push([url])
  const opts: Record<string, string | string[]> = {}
  if (fileName) opts.out = fileName

  // 构建 HTTP 头：Origin + Referer + Cookie + 自定义 x-* 头
  const headers: string[] = []
  if (extra?.pageUrl) {
    try {
      headers.push(`Origin: ${new URL(extra.pageUrl).origin}`)
      let referer = extra.pageUrl.trim()
      const hashIdx = referer.lastIndexOf('#')
      referer = hashIdx < 0 || hashIdx < referer.indexOf('?') ? referer : referer.substring(0, hashIdx)
      headers.push(`Referer: ${referer}`)
    } catch { /* ignore */ }
  }
  if (extra?.cookies) {
    headers.push(`Cookie: ${extra.cookies}`)
  }
  if (extra?.requestHeaders) {
    for (const [name, value] of Object.entries(extra.requestHeaders)) {
      headers.push(`${name}: ${value}`)
    }
  }
  if (headers.length > 0) {
    opts.header = headers
  }

  params.push(opts)

  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'aria2.addUri',
      params,
    }),
  })
  if (!res.ok) {
    return { success: false, message: `aria2 RPC HTTP ${res.status}` }
  }
  const json = (await res.json()) as { error?: { message: string }; result?: string }
  if (json.error) {
    return { success: false, message: json.error.message }
  }
  logger.info('[download] aria2.addUri →', json.result ?? '(no gid)')
  return { success: true }
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
  extra?: { pageUrl?: string | undefined; contentType?: string | undefined; contentDisposition?: string | undefined; method?: string | undefined; cookies?: string | undefined; requestBody?: string | undefined; requestHeaders?: Record<string, string> | undefined },
): Promise<{ success: boolean; message?: string }> {
  return new Promise((resolve) => {
    try {
      if (ndmWs && ndmWsReady) {
        ndmSendPayload(ndmWs, url, fileName, extra)
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
        ndmSendPayload(ws, url, fileName, extra)
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

function ndmSendPayload(ws: WebSocket, url: string, fileName: string | undefined, extra?: { pageUrl?: string | undefined; contentType?: string | undefined; contentDisposition?: string | undefined; method?: string | undefined; cookies?: string | undefined; requestBody?: string | undefined; requestHeaders?: Record<string, string> | undefined }): void {
  // NDM WebSocket 协议（多行键值，移植自 bg.js V.I）:
  const method = extra?.method || 'GET'
  const pageUrl = extra?.pageUrl || ''
  const contentType = extra?.contentType || ''
  const contentDisposition = extra?.contentDisposition || ''
  const cookies = extra?.cookies || ''
  const requestBody = extra?.requestBody
  const requestHeaders = extra?.requestHeaders

  let b = `1:${method}\r\n`
  b += `2:${url}\r\n`
  b += `6:normal\r\n`
  if (fileName) b += `4:${fileName}\r\n`
  if (pageUrl) {
    let c = pageUrl.trim()
    if (c) {
      try { b += `Origin: ${new URL(c).origin}\r\n` } catch { /* ignore */ }
      const d = c.lastIndexOf('#')
      c = d < 0 || d < c.indexOf('?') ? c : c.substring(0, d)
      b += `Referer: ${c}\r\n`
    }
  }
  if (cookies) b += `Cookie: ${cookies}\r\n`
  if (contentType) b += `Content-Type: ${contentType}\r\n`
  if (contentDisposition) {
    b += `Content-Disposition: ${contentDisposition}\r\n`
  } else if (fileName) {
    b += `Content-Disposition: attachment; filename="${fileName}"\r\n`
  }
  // x-* 自定义头 (移植自 NDM bg.js V.I: for (e in a) N(e.toLowerCase(),"x-") && ...)
  if (requestHeaders) {
    for (const [name, value] of Object.entries(requestHeaders)) {
      b += `${name}: ${value}\r\n`
    }
  }
  // POST body (移植自 NDM bg.js V.I: a.postData ? "__0NeatPostData9__:" + a.postData : "Content-Length: 0\r\n")
  if (method === 'POST') {
    if (requestBody) {
      b += `__0NeatPostData9__:${requestBody}\r\n`
    } else {
      b += 'Content-Length: 0\r\n'
    }
  } else {
    b += 'Content-Length: 0\r\n'
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
 * sdown push server (WebSocket JSON HlsPushMessage)
 *
 * 协议：ws://host:port，发送 JSON { token, action, url, ... }
 * sdown (Motrix Lite) 接收后创建 HLS 下载任务
 *
 * 对应 sdown motrix-core HlsPushMessage 结构
 */
let sdownWs: WebSocket | null = null
let sdownWsReady = false

export async function sendToSdown(
  url: string,
  fileName: string | undefined,
  cfg: DownloadClientConfig,
  extra?: {
    pageUrl?: string | undefined
    contentType?: string | undefined
    cookies?: string | undefined
    requestHeaders?: Record<string, string> | undefined
  },
): Promise<{ success: boolean; message?: string }> {
  const wsUrl = `ws://${cfg.sdownHost}:${cfg.sdownPort}`
  return new Promise((resolve) => {
    try {
      if (sdownWs && sdownWsReady) {
        sdownWsSendUrl(sdownWs, url, fileName, cfg.sdownToken, extra)
        resolve({ success: true })
        return
      }
      const ws = new WebSocket(wsUrl)
      const timeout = setTimeout(() => {
        ws.close()
        resolve({ success: false, message: 'sdown 连接超时（确保 sdown 已启动并开启推送服务）' })
      }, 5000)
      ws.onopen = () => {
        clearTimeout(timeout)
        sdownWs = ws
        sdownWsReady = true
        sdownWsSendUrl(ws, url, fileName, cfg.sdownToken, extra)
        resolve({ success: true })
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        sdownWs = null
        sdownWsReady = false
        resolve({ success: false, message: `sdown 连接失败（确保 sdown 已启动 + 端口 ${cfg.sdownPort} 开放）` })
      }
      ws.onclose = () => {
        sdownWs = null
        sdownWsReady = false
      }
    } catch (e) {
      resolve({ success: false, message: (e as Error).message })
    }
  })
}

/**
 * sdown 推送内联 m3u8 文本（data-url 投递模式专用）
 *
 * action: "push_m3u8" → sdown 解析为 HlsSource::Inline
 * 直接推送 cleaned m3u8 文本，无需 data URL 编码
 */
export async function sendToSdownM3u8(
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
  const wsUrl = `ws://${cfg.sdownHost}:${cfg.sdownPort}`
  return new Promise((resolve) => {
    try {
      if (sdownWs && sdownWsReady) {
        sdownWsSendM3u8(sdownWs, m3u8Text, baseUrl, fileName, cfg.sdownToken, extra)
        resolve({ success: true })
        return
      }
      const ws = new WebSocket(wsUrl)
      const timeout = setTimeout(() => {
        ws.close()
        resolve({ success: false, message: 'sdown 连接超时（确保 sdown 已启动并开启推送服务）' })
      }, 5000)
      ws.onopen = () => {
        clearTimeout(timeout)
        sdownWs = ws
        sdownWsReady = true
        sdownWsSendM3u8(ws, m3u8Text, baseUrl, fileName, cfg.sdownToken)
        resolve({ success: true })
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        sdownWs = null
        sdownWsReady = false
        resolve({ success: false, message: `sdown 连接失败（确保 sdown 已启动 + 端口 ${cfg.sdownPort} 开放）` })
      }
      ws.onclose = () => {
        sdownWs = null
        sdownWsReady = false
      }
    } catch (e) {
      resolve({ success: false, message: (e as Error).message })
    }
  })
}

function buildSdownHeaders(extra?: {
  pageUrl?: string | undefined
  cookies?: string | undefined
  requestHeaders?: Record<string, string> | undefined
}): Record<string, string> | undefined {
  const headers: Record<string, string> = {}
  if (extra?.pageUrl) {
    try {
      headers['Origin'] = new URL(extra.pageUrl).origin
      let referer = extra.pageUrl.trim()
      const hashIdx = referer.lastIndexOf('#')
      referer = hashIdx < 0 || hashIdx < referer.indexOf('?') ? referer : referer.substring(0, hashIdx)
      headers['Referer'] = referer
    } catch { /* ignore */ }
  }
  if (extra?.cookies) {
    headers['Cookie'] = extra.cookies
  }
  if (extra?.requestHeaders) {
    for (const [name, value] of Object.entries(extra.requestHeaders)) {
      headers[name] = value
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

function sdownWsSendUrl(ws: WebSocket, url: string, fileName: string | undefined, token: string, extra?: {
  pageUrl?: string | undefined
  contentType?: string | undefined
  cookies?: string | undefined
  requestHeaders?: Record<string, string> | undefined
}): void {
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
    headers: buildSdownHeaders(extra),
    options: {
      filename: fileName ?? undefined,
      output_dir: undefined as string | undefined,
      merge_format: isM3u8 ? 'mp4' : undefined as string | undefined,
      extra_headers: undefined as Record<string, string> | undefined,
    },
  }
  const payload = JSON.stringify(msg)
  logger.info('[download] sdown', action, '→', url, 'headers:', msg.headers ? Object.keys(msg.headers) : 'none')
  ws.send(payload)
}

function sdownWsSendM3u8(ws: WebSocket, m3u8Text: string, baseUrl: string, fileName: string | undefined, token: string, extra?: {
  pageUrl?: string | undefined
  cookies?: string | undefined
  requestHeaders?: Record<string, string> | undefined
}): void {
  const msg = {
    version: 1,
    token,
    action: 'push_m3u8',
    m3u8_text: m3u8Text,
    url: undefined as string | undefined,
    base_url: baseUrl || undefined,
    headers: buildSdownHeaders(extra),
    options: {
      filename: fileName ?? undefined,
      output_dir: undefined as string | undefined,
      merge_format: 'mp4',
      extra_headers: undefined as Record<string, string> | undefined,
    },
  }
  const payload = JSON.stringify(msg)
  logger.info('[download] sdown push_m3u8 →', `${m3u8Text.length} chars, baseUrl=${baseUrl}`, 'headers:', msg.headers ? Object.keys(msg.headers) : 'none')
  ws.send(payload)
}

/**
 * sdown 推送 DASH 音视频合并下载任务
 *
 * action: "push_dash" → sdown 解析为 HlsSource::Dash
 * 同时推送 video_url + audio_url，sdown 下载后用 FFmpeg 合并为完整音视频
 */
export async function sendToSdownDash(
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
  const wsUrl = `ws://${cfg.sdownHost}:${cfg.sdownPort}`
  return new Promise((resolve) => {
    try {
      if (sdownWs && sdownWsReady) {
        sdownWsSendDash(sdownWs, videoUrl, audioUrl, fileName, cfg.sdownToken, extra)
        resolve({ success: true })
        return
      }
      const ws = new WebSocket(wsUrl)
      const timeout = setTimeout(() => {
        ws.close()
        resolve({ success: false, message: 'sdown 连接超时（确保 sdown 已启动并开启推送服务）' })
      }, 5000)
      ws.onopen = () => {
        clearTimeout(timeout)
        sdownWs = ws
        sdownWsReady = true
        sdownWsSendDash(ws, videoUrl, audioUrl, fileName, cfg.sdownToken, extra)
        resolve({ success: true })
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        sdownWs = null
        sdownWsReady = false
        resolve({ success: false, message: `sdown 连接失败（确保 sdown 已启动 + 端口 ${cfg.sdownPort} 开放）` })
      }
      ws.onclose = () => {
        sdownWs = null
        sdownWsReady = false
      }
    } catch (e) {
      resolve({ success: false, message: (e as Error).message })
    }
  })
}

function sdownWsSendDash(ws: WebSocket, videoUrl: string, audioUrl: string, fileName: string | undefined, token: string, extra?: {
  pageUrl?: string | undefined
  cookies?: string | undefined
  requestHeaders?: Record<string, string> | undefined
}): void {
  const msg = {
    version: 1,
    token,
    action: 'push_dash',
    video_url: videoUrl,
    audio_url: audioUrl,
    url: undefined as string | undefined,
    m3u8_text: undefined as string | undefined,
    base_url: undefined as string | undefined,
    headers: buildSdownHeaders(extra),
    options: {
      filename: fileName ?? undefined,
      output_dir: undefined as string | undefined,
      merge_format: 'mp4',
      extra_headers: undefined as Record<string, string> | undefined,
    },
  }
  const payload = JSON.stringify(msg)
  logger.info('[download] sdown push_dash → video:', videoUrl.slice(0, 80), 'audio:', audioUrl.slice(0, 80), 'headers:', msg.headers ? Object.keys(msg.headers) : 'none')
  ws.send(payload)
}
