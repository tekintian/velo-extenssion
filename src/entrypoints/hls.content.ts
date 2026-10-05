import { defineContentScript } from 'wxt/sandbox'

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_start',
  world: 'MAIN',

  main() {
    const HLS_NS = (window as unknown as Record<string, unknown>).__HLS_HOOK_NAMESPACE__ ??= {} as Record<string, unknown>
    ;(window as unknown as Record<string, unknown>).__HLS_HOOK_NAMESPACE__ = HLS_NS

    if ((HLS_NS as Record<string, unknown>).owner) {
      return
    }
    ;(HLS_NS as Record<string, unknown>).owner = 'sdown'

    const originalOpen = XMLHttpRequest.prototype.open
    const originalSend = XMLHttpRequest.prototype.send

    XMLHttpRequest.prototype.open = function (method: string, url: string | URL, asyncFlag?: boolean, username?: string | null, password?: string | null) {
      const urlStr = typeof url === 'string' ? url : url.toString()

      if (isM3u8Url(urlStr)) {
        this.addEventListener('load', function () {
          if (this.status < 200 || this.status >= 300) return
          const text = this.responseText
          if (!text || !text.includes('#EXTM3U')) return
          postHlsMessage('m3u8-intercepted', { text, baseUrl: urlStr, pageUrl: location.href })
        })
      }

      return originalOpen.call(this, method, url, asyncFlag ?? true, username ?? null, password ?? null)
    }

    XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      return originalSend.call(this, body ?? null)
    }

    const originalFetch = window.fetch
    window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

      if (isM3u8Url(url)) {
        const response = await originalFetch.call(this, input, init)
        const clone = response.clone()

        void (async () => {
          try {
            const text = await clone.text()
            if (text && text.includes('#EXTM3U')) {
              postHlsMessage('m3u8-intercepted', { text, baseUrl: url, pageUrl: location.href })
            }
          } catch { /* ignore */ }
        })()

        return response
      }

      return originalFetch.call(this, input, init)
    }

    hookMSE()
  },
})

function isM3u8Url(url: string): boolean {
  try {
    const u = new URL(url, location.href)
    const path = u.pathname.toLowerCase()
    return path.endsWith('.m3u8') || path.endsWith('.m3u')
  } catch {
    return url.toLowerCase().includes('.m3u8') || url.toLowerCase().includes('.m3u')
  }
}

function postHlsMessage(type: string, payload: Record<string, string>): void {
  window.postMessage({ source: 'sdown-hls', type, payload }, '*')
}

function hookMSE(): void {
  const origCreateObjectURL = URL.createObjectURL
  URL.createObjectURL = function (blob: Blob | MediaSource) {
    if (blob instanceof MediaSource) {
      postHlsMessage('mse-detected', { mimeType: 'application/vnd.apple.mpegurl', url: location.href })
    }
    return origCreateObjectURL.call(URL, blob)
  }

  const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer
  MediaSource.prototype.addSourceBuffer = function (mimeType: string) {
    if (mimeType.includes('mpegurl') || mimeType.includes('mpegURL')) {
      postHlsMessage('mse-detected', { mimeType, url: location.href })
    }
    return origAddSourceBuffer.call(this, mimeType)
  }
}
