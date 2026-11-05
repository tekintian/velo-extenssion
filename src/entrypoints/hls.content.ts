/**
 * HLS 广告分片过滤 content script
 *
 * 策略：在 MAIN world 注入 fetch/XHR hook，拦截 .m3u8 请求
 *   1. 拦截请求 → fetch 原始 m3u8
 *   2. 发给 background processHlsPlaylist 过滤
 *   3. 用返回的 cleaned m3u8 替换响应
 *
 * 注意：MV3 content script 在 isolated world，直接 hook fetch 不影响页面。
 *       必须用 chrome.scripting.executeScript world:'MAIN' 或 WXT 的 world:'MAIN' 注入。
 */

import { defineContentScript } from 'wxt/utils/define-content-script'
import { logger } from '@/lib/logger'
import { asWin } from '@/lib/cast'

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  runAt: 'document_start',
  world: 'MAIN',

  main() {
    const HLS_NS = asWin().__HLS_HOOK_NAMESPACE__ ??= {} as Record<string, unknown>
    asWin().__HLS_HOOK_NAMESPACE__ = HLS_NS

    if ((HLS_NS as Record<string, unknown>).owner) {
      logger.info('[AdClear HLS] Another extension already hooked HLS, owner:', (HLS_NS as Record<string, unknown>).owner, '— skipping')
      return
    }

    // 等待 bridge content script 的委派状态通知
    // bridge 在 isolated world 中查询 background，通过 postMessage 通知 MAIN world
    window.addEventListener('message', function onDelegate(e: MessageEvent) {
      if (e.source !== window) return
      const data = e.data as { __adclear_hls_delegate?: boolean; mode?: string; reason?: string } | null
      if (!data?.__adclear_hls_delegate) return

      if (data.mode === 'active') {
        window.removeEventListener('message', onDelegate)
        installHlsHooks()
      } else {
        logger.info('[AdClear HLS] Delegated to velo, reason:', data.reason, '— not hooking')
        window.removeEventListener('message', onDelegate)
      }
    })

    logger.info('[AdClear HLS] Waiting for delegation signal from bridge...')
  },
})

function installHlsHooks(): void {
  const HLS_NS = asWin().__HLS_HOOK_NAMESPACE__
  if ((HLS_NS as Record<string, unknown>).owner) {
    logger.info('[AdClear HLS] Another extension already hooked HLS, owner:', (HLS_NS as Record<string, unknown>).owner, '— skipping')
    return
  }
  ;(HLS_NS as Record<string, unknown>).owner = 'adclear'
  logger.info('[AdClear HLS] MAIN world hook installing, location:', location.href)

  // === 拦截 fetch ===
  const origFetch = window.fetch
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (isM3u8Url(url)) {
      logger.info('[AdClear HLS] fetch intercepted m3u8:', url)
      try {
        const response = await origFetch.call(window, input, init)
        const ct = response.headers.get('Content-Type') ?? ''
        if (!isM3u8ContentType(ct)) {
          logger.info('[AdClear HLS] Content-Type not m3u8, skip:', ct)
          return response
        }
        const text = await response.clone().text()
        logger.info('[AdClear HLS] m3u8 content len:', text.length, 'first 100:', text.slice(0, 100))
        // 只做广告检测，原样返回响应：页面播放数据源绝不修改，
        // 广告由 badge 按检测到的区间 seek 跳过；清洗结果仅供下载链路使用
        void detectPlaylistAdRanges(text, url)
        return response
      } catch (e) {
        logger.warn('[AdClear HLS] fetch hook failed:', (e as Error).message)
        return origFetch.call(window, input, init)
      }
    }
    return origFetch.call(window, input, init)
  } as typeof window.fetch

  // === 拦截 XMLHttpRequest ===
  type XhrOpenFn = (this: XMLHttpRequest, method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null) => void
  const OrigOpen = XMLHttpRequest.prototype.open as XhrOpenFn
  const OrigSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string, async?: boolean, username?: string | null, password?: string | null) {
    ;(this as XMLHttpRequest & { __adclear_url?: string }).__adclear_url = url
    return OrigOpen.call(this, method, url, async, username, password)
  }
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, _body?: Document | XMLHttpRequestBodyInit | null) {
    const url = (this as XMLHttpRequest & { __adclear_url?: string }).__adclear_url
    if (!url || !isM3u8Url(url)) {
      return OrigSend.call(this, _body as Document | XMLHttpRequestBodyInit | null)
    }
    logger.info('[AdClear HLS] XHR intercepted m3u8:', url)
    this.addEventListener('readystatechange', async function (this: XMLHttpRequest) {
      if (this.readyState === 4 && this.status === 200) {
        try {
          const text = this.responseText
          // 只做检测，不覆写 responseText/response，页面播放数据源保持原样
          void detectPlaylistAdRanges(text, url)
        } catch {
          // ignore
        }
      }
    })
    return OrigSend.call(this, _body as Document | XMLHttpRequestBodyInit | null)
  }

  logger.info('[AdClear HLS] content script loaded in MAIN world')
}

function isM3u8Url(url: string): boolean {
  if (!url) return false
  const lower = url.toLowerCase().split('?')[0]!
  return (
    lower.endsWith('.m3u8') ||
    lower.endsWith('.m3u') ||
    // 某些 CDN 用 query 参数标识，看 Content-Type 更准；但 content script 看不到响应头前的 URL
    // 这里保守匹配常见 m3u8 URL 形态
    /\.m3u8?(\?|#|$)/i.test(url)
  )
}

/**
 * 判断响应 Content-Type 是否为 m3u8（HLS 播放列表）
 *
 * URL 匹配 .m3u8 后，再用 Content-Type 二次确认，避免误伤同名非 m3u8 资源。
 * 常见 Content-Type:
 *   application/vnd.apple.mpegurl
 *   application/x-mpegurl
 *   audio/mpegurl
 */
function isM3u8ContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase()
  return (
    ct.includes('mpegurl') ||
    ct.includes('m3u8') ||
    ct.includes('x-mpegurl') ||
    // 某些服务器用 text/plain 但 body 是 #EXTM3U，放行让 parsePlaylist 自己判断
    ct.includes('text/plain')
  )
}

/**
 * 发给 background 过滤，返回广告检测结果（区间 + 报告）
 *
 * 页面播放链路只做检测，绝不替换播放器拿到的 m3u8 响应：
 *   - 替换响应会改变播放器的数据源，且不可恢复
 *   - data-url / 清洗文本不是所有播放器都支持（相对路径会以错误基准解析导致分片 404）
 *   - 广告由 badge 按返回的 adRanges 做 seek 跳过
 * 媒体下载与推送走独立链路，投递模式只在那里生效
 */
async function detectPlaylistAdRanges(
  text: string,
  baseUrl: string,
): Promise<{ adRanges?: Array<{ start: number; end: number; duration: number }>; report?: unknown } | null> {
  try {
    const MAX_BRIDGE_RETRIES = 3
    const BRIDGE_TIMEOUT_MS = 5000
    const BRIDGE_RETRY_BASE_MS = 500
    for (let attempt = 1; attempt <= MAX_BRIDGE_RETRIES; attempt++) {
      const result = await sendToBridge(text, baseUrl, BRIDGE_TIMEOUT_MS)
      if (result !== null || attempt === MAX_BRIDGE_RETRIES) {
        if (attempt > 1 && result !== null) {
          logger.info('[AdClear HLS] detect succeeded on retry:', attempt)
        }
        return result
      }
      logger.warn('[AdClear HLS] detect bridge returned null, retrying:', attempt)
      if (attempt < MAX_BRIDGE_RETRIES) {
        await new Promise((r) => setTimeout(r, BRIDGE_RETRY_BASE_MS * attempt))
      }
    }
    return null
  } catch (e) {
    logger.warn('[AdClear HLS] detect error:', (e as Error).message)
    return null
  }
}

async function sendToBridge(
  text: string,
  baseUrl: string,
  timeoutMs: number,
): Promise<{ adRanges?: Array<{ start: number; end: number; duration: number }>; report?: unknown } | null> {
  const reqId = `hls-${Date.now()}-${Math.random().toString(36).slice(2)}`
  logger.info('[AdClear HLS] detect sending to bridge, reqId:', reqId, 'baseUrl:', baseUrl.slice(0, 80))
  return await new Promise((resolve) => {
    const handler = (e: MessageEvent) => {
      if (e.source !== window || e.data?.__adclear !== reqId) return
      window.removeEventListener('message', handler)
      const error = e.data.error as string | undefined
      if (error) {
        logger.warn('[AdClear HLS] detect bridge error:', error)
        resolve(null)
        return
      }
      const adRanges = (e.data.adRanges ?? []) as Array<{ start: number; end: number; duration: number }>
      logger.info('[AdClear HLS] detect got response, adRanges:', adRanges.length)
      resolve({ adRanges, report: e.data.report })
    }
    window.addEventListener('message', handler)
    window.postMessage({ __adclear: reqId, type: 'processHlsPlaylist', text, baseUrl, pageUrl: location.href }, '*')
    setTimeout(() => {
      window.removeEventListener('message', handler)
      logger.warn('[AdClear HLS] detect timeout, no bridge response')
      resolve(null)
    }, timeoutMs)
  })
}