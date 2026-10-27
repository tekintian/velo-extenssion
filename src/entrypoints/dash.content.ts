/**
 * DASH 广告过滤 content script
 *
 * 策略：在 MAIN world 注入 fetch/XHR hook，拦截 playurl / MPD 请求
 *   1. 拦截请求 → fetch 原始 manifest
 *   2. 发给 background processDashManifest 过滤
 *   3. 用返回的 cleaned manifest 替换响应
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
    const DASH_NS = asWin().__DASH_HOOK_NAMESPACE__ ??= {} as Record<string, unknown>
    asWin().__DASH_HOOK_NAMESPACE__ = DASH_NS

    if ((DASH_NS as Record<string, unknown>).owner) {
      logger.info('[AdClear DASH] Another extension already hooked DASH, owner:', (DASH_NS as Record<string, unknown>).owner, '— skipping')
      return
    }

    window.addEventListener('message', function onDelegate(e: MessageEvent) {
      if (e.source !== window) return
      const data = e.data as { __adclear_dash_delegate?: boolean; mode?: string; reason?: string } | null
      if (!data?.__adclear_dash_delegate) return

      if (data.mode === 'active') {
        window.removeEventListener('message', onDelegate)
        installDashHooks()
      } else {
        logger.info('[AdClear DASH] Delegated, reason:', data.reason, '— not hooking')
        window.removeEventListener('message', onDelegate)
      }
    })

    logger.info('[AdClear DASH] Waiting for delegation signal from bridge...')
  },
})

function installDashHooks(): void {
  const DASH_NS = asWin().__DASH_HOOK_NAMESPACE__
  if ((DASH_NS as Record<string, unknown>).owner) return
  ;(DASH_NS as Record<string, unknown>).owner = 'adclear'
  logger.info('[AdClear DASH] MAIN world hook installing, location:', location.href)

  const origFetch = window.fetch
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (isDashManifestUrl(url)) {
      logger.info('[AdClear DASH] fetch intercepted:', url.slice(0, 120))
      try {
        const response = await origFetch.call(window, input, init)
        const ct = response.headers.get('Content-Type') ?? ''
        if (!isDashManifestContentType(ct, url)) {
          return response
        }
        const text = await response.clone().text()
        logger.info('[AdClear DASH] manifest content len:', text.length)
        const filtered = await filterManifest(text, url)
        if (filtered !== null) {
          const headers = new Headers()
          headers.set('Content-Type', ct || (isMpdUrl(url) ? 'application/dash+xml' : 'application/json'))
          headers.set('Cache-Control', 'no-store')
          return new Response(filtered, {
            status: 200,
            statusText: 'OK',
            headers,
          })
        }
        return response
      } catch (e) {
        logger.warn('[AdClear DASH] fetch hook failed:', (e as Error).message)
        return origFetch.call(window, input, init)
      }
    }
    return origFetch.call(window, input, init)
  } as typeof window.fetch

  type XhrOpenFn = (this: XMLHttpRequest, method: string, url: string | URL, async?: boolean, username?: string | null, password?: string | null) => void
  const OrigOpen = XMLHttpRequest.prototype.open as XhrOpenFn
  const OrigSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string, async?: boolean, username?: string | null, password?: string | null) {
    ;(this as XMLHttpRequest & { __adclear_dash_url?: string }).__adclear_dash_url = url
    return OrigOpen.call(this, method, url, async, username, password)
  }
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, _body?: Document | XMLHttpRequestBodyInit | null) {
    const url = (this as XMLHttpRequest & { __adclear_dash_url?: string }).__adclear_dash_url
    if (!url || !isDashManifestUrl(url)) {
      return OrigSend.call(this, _body as Document | XMLHttpRequestBodyInit | null)
    }
    logger.info('[AdClear DASH] XHR intercepted:', url.slice(0, 120))
    this.addEventListener('readystatechange', async function (this: XMLHttpRequest) {
      if (this.readyState === 4 && this.status === 200) {
        try {
          const text = this.responseText
          const filtered = await filterManifest(text, url)
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

  logger.info('[AdClear DASH] content script loaded in MAIN world')
}

function isDashManifestUrl(url: string): boolean {
  if (!url) return false
  return (
    /playurl(\?|$)/i.test(url) ||
    /youtubei\/v\d+\/player/i.test(url) ||
    isMpdUrl(url) ||
    /\/manifest(\?|$)/i.test(url)
  )
}

function isMpdUrl(url: string): boolean {
  return /\.mpd(\?|#|$)/i.test(url)
}

function isDashManifestContentType(contentType: string, url: string): boolean {
  const ct = contentType.toLowerCase()
  if (ct.includes('dash+xml')) return true
  if (ct.includes('application/json')) {
    if (/playurl|player|dash|mpd/i.test(url)) return true
    if (ct.includes('dash') || ct.includes('mpd')) return true
  }
  if (ct.includes('text/plain') || ct.includes('text/xml')) {
    if (isMpdUrl(url)) return true
  }
  return false
}

async function filterManifest(text: string, baseUrl: string): Promise<string | null> {
  try {
    const MAX_RETRIES = 3
    const TIMEOUT_MS = 5000
    const RETRY_BASE_MS = 500
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const result = await sendToBridge(text, baseUrl, TIMEOUT_MS)
      if (result !== null || attempt === MAX_RETRIES) return result
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * attempt))
      }
    }
    return null
  } catch (e) {
    logger.warn('[AdClear DASH] filterManifest error:', (e as Error).message)
    return null
  }
}

async function sendToBridge(text: string, baseUrl: string, timeoutMs: number): Promise<string | null> {
  const reqId = `dash-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return await new Promise<string | null>((resolve) => {
    const handler = (e: MessageEvent) => {
      if (e.source !== window || e.data?.__adclear_dash !== reqId) return
      window.removeEventListener('message', handler)
      resolve(e.data.filtered ?? null)
    }
    window.addEventListener('message', handler)
    window.postMessage({ __adclear_dash: reqId, type: 'processDashManifest', text, baseUrl, pageUrl: location.href }, '*')
    setTimeout(() => {
      window.removeEventListener('message', handler)
      resolve(null)
    }, timeoutMs)
  })
}