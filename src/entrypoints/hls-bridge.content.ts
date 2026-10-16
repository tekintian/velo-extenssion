/**
 * HLS 过滤 — isolated world bridge content script
 *
 * 职责：
 *   MAIN world 的 hls.content.ts 拦截了 m3u8 fetch/XHR，
 *   但 MAIN world 不能调 chrome.runtime.sendMessage。
 *   本 script 在 isolated world 监听 window.postMessage，
 *   转发给 background processHlsPlaylist，再把结果 postMessage 回 MAIN world。
 *
 *   这样 MAIN world 和 background 之间通过 isolated world 间接通信。
 *
 * task #13: 同时转发 MAIN world 的 MSE hook 消息（mse-source-added /
 *   velo-mse-segment）给 background，让桌面端在 MSE 流被创建时通知用户。
 */

import { defineContentScript } from 'wxt/utils/define-content-script'
import { logger } from '@/lib/logger'
import { sendMessage, onMessageAddListener } from '@/lib/runtime'

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  runAt: 'document_start',
  // 默认 isolated world（不加 world: 'MAIN'）

  main() {
    logger.info('[AdClear HLS bridge] isolated world loaded, location:', location.href)

    // 启动时查询 HLS 委派状态，通知 MAIN world 是否应该 hook
    void (async () => {
      try {
        const resp = await sendMessage<{ mode?: string; reason?: string }>({ type: 'getHlsDelegation' })
        if (resp?.mode === 'active') {
          window.postMessage({ __adclear_hls_delegate: true, mode: 'active', reason: resp.reason }, '*')
          logger.info('[AdClear HLS bridge] delegation active, notified MAIN world')
        } else {
          window.postMessage({ __adclear_hls_delegate: true, mode: 'delegated', reason: resp?.reason }, '*')
          logger.info('[AdClear HLS bridge] delegation delegated, reason:', resp?.reason)
        }
      } catch (e) {
        logger.warn('[AdClear HLS bridge] getHlsDelegation failed:', (e as Error).message)
      }
    })()

    // 监听委派状态变化（background 广播）
    onMessageAddListener((message: unknown) => {
      if (!message || typeof message !== 'object') return false
      const msg = message as { type?: string; mode?: string; reason?: string }
      if (msg.type === 'hlsDelegationChanged') {
        window.postMessage({ __adclear_hls_delegate: true, mode: msg.mode, reason: msg.reason }, '*')
        logger.info('[AdClear HLS bridge] delegation changed:', msg.mode, msg.reason)
      }
      return false
    })

    window.addEventListener('message', async (e: MessageEvent) => {
      if (e.source !== window) return
      const data = e.data as { __adclear?: string; source?: string; type?: string; text?: string; baseUrl?: string; pageUrl?: string; payload?: unknown } | null
      if (!data) return

      // === task #13: 转发 MAIN world MSE hook 消息给 background ===
      if (data.source === 'velo-mse' && data.type) {
        try {
          if (data.type === 'mse-source-added') {
            await sendMessage({
              type: 'velo-mse-source',
              payload: data.payload ?? {},
            })
          } else if (data.type === 'velo-mse-segment' || data.type === 'mse-segment-appended') {
            await sendMessage({
              type: 'velo-mse-segment',
              payload: data.payload ?? {},
            })
          }
        } catch (err) {
          logger.warn('[AdClear HLS bridge] forward MSE message failed:', (err as Error).message)
        }
        return
      }

      // HLS 处理消息（原逻辑）
      if (!data.__adclear || data.type !== 'processHlsPlaylist') return

      const reqId = data.__adclear
      logger.info('[AdClear HLS bridge] received processHlsPlaylist from MAIN, reqId:', reqId)
      try {
        const response = await sendMessage({
          type: 'processHlsPlaylist',
          payload: {
            text: data.text ?? '',
            baseUrl: data.baseUrl ?? '',
            pageUrl: data.pageUrl ?? '',
          },
        })
        logger.info('[AdClear HLS bridge] background response mode:', (response as { mode?: string })?.mode)
        const filtered = extractFilteredM3u8(response)
        logger.info('[AdClear HLS bridge] extracted filtered:', filtered !== null ? `len=${filtered.length}` : 'null')
        window.postMessage({ __adclear: reqId, filtered }, '*')
        if (filtered !== null && data.baseUrl) {
          window.postMessage({
            source: 'adclear-hls',
            type: 'm3u8-filtered',
            payload: { cleaned: filtered, baseUrl: data.baseUrl, pageUrl: data.pageUrl ?? '' },
          }, '*')
        }
      } catch (err) {
        logger.warn('[AdClear HLS bridge] error:', (err as Error).message)
        window.postMessage({ __adclear: reqId, filtered: null, error: (err as Error).message }, '*')
      }
    })
  },
})

/**
 * 从 processHlsPlaylist 响应里提取清洗后的 m3u8 文本
 *
 * 响应结构:
 *   mode='m3u8-file' / 'data-url'  → cleaned 字段
 *   mode='data-url'                → 也可用 url 字段（data: URL）
 *   其它 mode                       → null（原样放行）
 */
function extractFilteredM3u8(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null
  const r = response as { mode?: string; cleaned?: string; url?: string }
  if (r.mode === 'm3u8-file' || r.mode === 'data-url') {
    return r.cleaned ?? null
  }
  return null
}