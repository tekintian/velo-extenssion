/**
 * DASH 过滤 — isolated world bridge content script
 *
 * 职责：MAIN world 的 dash.content.ts 拦截了 playurl/MPD fetch/XHR，
 * 但 MAIN world 不能调 chrome.runtime.sendMessage。
 * 本 script 在 isolated world 监听 window.postMessage，
 * 转发给 background processDashManifest，再把结果 postMessage 回 MAIN world。
 */

import { defineContentScript } from 'wxt/utils/define-content-script'
import { logger } from '@/lib/logger'
import { sendMessage } from '@/lib/runtime'

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  runAt: 'document_start',

  main() {
    logger.info('[AdClear DASH bridge] isolated world loaded, location:', location.href)

    void (async () => {
      try {
        const resp = await sendMessage<{ mode?: string; reason?: string }>({ type: 'getDashDelegation' })
        if (resp?.mode === 'active') {
          window.postMessage({ __adclear_dash_delegate: true, mode: 'active', reason: resp.reason }, '*')
        } else {
          window.postMessage({ __adclear_dash_delegate: true, mode: 'delegated', reason: resp?.reason }, '*')
        }
      } catch (e) {
        logger.warn('[AdClear DASH bridge] getDashDelegation failed:', (e as Error).message)
        window.postMessage({ __adclear_dash_delegate: true, mode: 'active' }, '*')
      }
    })()

    window.addEventListener('message', async (e: MessageEvent) => {
      if (e.source !== window) return
      const data = e.data as { __adclear_dash?: string; type?: string; text?: string; baseUrl?: string; pageUrl?: string } | null
      if (!data || !data.__adclear_dash || data.type !== 'processDashManifest') return

      const reqId = data.__adclear_dash
      logger.info('[AdClear DASH bridge] received processDashManifest from MAIN, reqId:', reqId)

      try {
        const MAX_RETRIES = 3
        const RETRY_BASE_MS = 300
        let response: unknown
        let lastErr: Error | null = null

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            response = await sendMessage({
              type: 'processDashManifest',
              payload: {
                rawText: data.text ?? '',
                url: data.baseUrl ?? '',
                pageUrl: data.pageUrl ?? '',
              },
            })
            if (response !== undefined) break
          } catch (sendErr) {
            lastErr = sendErr as Error
            logger.warn('[AdClear DASH bridge] sendMessage threw:', lastErr.message, 'attempt:', attempt)
          }
          if (attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, RETRY_BASE_MS * attempt))
          }
        }

        if (response === undefined) {
          const errMsg = lastErr ? lastErr.message : 'background unavailable'
          window.postMessage({ __adclear_dash: reqId, filtered: null, error: errMsg }, '*')
          return
        }

        const filtered = extractFilteredManifest(response)
        window.postMessage({ __adclear_dash: reqId, filtered }, '*')

        if (filtered !== null && data.baseUrl) {
          window.postMessage({
            source: 'adclear-dash',
            type: 'manifest-filtered',
            payload: { cleaned: filtered, baseUrl: data.baseUrl, pageUrl: data.pageUrl ?? '' },
          }, '*')
        }
      } catch (err) {
        logger.warn('[AdClear DASH bridge] error:', (err as Error).message)
        window.postMessage({ __adclear_dash: reqId, filtered: null, error: (err as Error).message }, '*')
      }
    })
  },
})

function extractFilteredManifest(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null
  const r = response as { mode?: string; cleanedText?: string }
  if (r.mode === 'manifest-file' || r.mode === 'data-url') {
    return r.cleanedText ?? null
  }
  return null
}