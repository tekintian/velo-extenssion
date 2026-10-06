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

import { defineContentScript } from 'wxt/sandbox'
import { logger } from '@/lib/logger'

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  runAt: 'document_start',
  world: 'MAIN',

  main() {
    const HLS_NS = (window as unknown as Record<string, unknown>).__HLS_HOOK_NAMESPACE__ ??= {} as Record<string, unknown>
    ;(window as unknown as Record<string, unknown>).__HLS_HOOK_NAMESPACE__ = HLS_NS

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
        logger.info('[AdClear HLS] Delegated to sdown, reason:', data.reason, '— not hooking')
        window.removeEventListener('message', onDelegate)
      }
    })

    logger.info('[AdClear HLS] Waiting for delegation signal from bridge...')
  },
})

function installHlsHooks(): void {
  const HLS_NS = (window as unknown as Record<string, unknown>).__HLS_HOOK_NAMESPACE__
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
        const filtered = await filterPlaylist(text, url)
        if (filtered !== null) {
          const headers = new Headers()
          headers.set('Content-Type', ct || 'application/vnd.apple.mpegurl')
          headers.set('Cache-Control', 'no-store')
          return new Response(filtered, {
            status: 200,
            statusText: 'OK',
            headers,
          })
        }
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
          const filtered = await filterPlaylist(text, url)
          if (filtered !== null) {
            Object.defineProperty(this, 'responseText', { value: filtered, writable: false, configurable: true })
            Object.defineProperty(this, 'response', { value: filtered, writable: false, configurable: true })
            this.dispatchEvent(new Event('readystatechange'))
          }
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
 * 发给 background 过滤，返回清洗后的 m3u8 文本（或 null 表示不过滤）
 */
async function filterPlaylist(text: string, baseUrl: string): Promise<string | null> {
  try {
    // content script 在 MAIN world，不能直接用 chrome.runtime.sendMessage
    // 用 postMessage 给 isolated world 的 bridge content script 转发
    const reqId = `hls-${Date.now()}-${Math.random().toString(36).slice(2)}`
    logger.info('[AdClear HLS] filterPlaylist sending to bridge, reqId:', reqId, 'baseUrl:', baseUrl.slice(0, 80))
    return await new Promise<string | null>((resolve) => {
      const handler = (e: MessageEvent) => {
        if (e.source !== window || e.data?.__adclear !== reqId) return
        window.removeEventListener('message', handler)
        const filtered = e.data.filtered ?? null
        logger.info('[AdClear HLS] filterPlaylist got response, filtered:', filtered !== null ? `len=${filtered.length}` : 'null')
        resolve(filtered)
      }
      window.addEventListener('message', handler)
      window.postMessage({ __adclear: reqId, type: 'processHlsPlaylist', text, baseUrl, pageUrl: location.href }, '*')
      // 3s 超时
      setTimeout(() => {
        window.removeEventListener('message', handler)
        logger.warn('[AdClear HLS] filterPlaylist timeout, no bridge response')
        resolve(null)
      }, 3000)
    })
  } catch (e) {
    logger.warn('[AdClear HLS] filterPlaylist error:', (e as Error).message)
    return null
  }
}
