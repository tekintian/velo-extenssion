import { defineContentScript } from 'wxt/utils/define-content-script'
import { logger } from '@/lib/logger'

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_start',

  main() {
    window.addEventListener('message', (event) => {
      if (event.source !== window) return
      const data = event.data as Record<string, unknown> | undefined
      if (!data) return

      if (data.source === 'sdown-hls') {
        handleSdownMessage(data as { type?: string; payload?: Record<string, string> })
      } else if (data.source === 'adclear-hls') {
        handleAdClearBroadcast(data as { type?: string; payload?: Record<string, string> })
      } else if (data.__adclear && data.type === 'processHlsPlaylist') {
        handleAdClearMessage(data as { __adclear?: string; type?: string; text?: string; baseUrl?: string; pageUrl?: string })
      }
    })

    logger.info('HLS bridge content script ready (dual-source: sdown + adclear)')
  },
})

function handleSdownMessage(data: { type?: string; payload?: Record<string, string> }): void {
  const { type, payload } = data

  if (type === 'm3u8-intercepted' && payload) {
    void handleM3u8Intercepted(payload)
  } else if (type === 'mse-detected' && payload) {
    void handleMseDetected(payload)
  }
}

function handleAdClearMessage(data: { __adclear?: string; type?: string; text?: string; baseUrl?: string; pageUrl?: string }): void {
  if (data.type === 'processHlsPlaylist') {
    void handleM3u8Intercepted({
      text: data.text ?? '',
      baseUrl: data.baseUrl ?? '',
      pageUrl: data.pageUrl ?? '',
    })
  }
}

function handleAdClearBroadcast(data: { type?: string; payload?: Record<string, string> }): void {
  if (data.type === 'm3u8-filtered' && data.payload) {
    void handleAdClearFiltered(data.payload)
  }
}

async function handleAdClearFiltered(payload: Record<string, string>): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: 'sdown-push-filtered-m3u8',
      payload: {
        cleaned: payload.cleaned,
        baseUrl: payload.baseUrl,
        pageUrl: payload.pageUrl,
      },
    })
    logger.info('AdClear filtered m3u8 forwarded to sdown background for push')
  } catch (e) {
    logger.warn('Forward AdClear filtered result failed:', (e as Error).message)
  }
}

async function handleM3u8Intercepted(payload: Record<string, string>): Promise<void> {
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'processHlsPlaylist',
      payload: {
        text: payload.text,
        baseUrl: payload.baseUrl,
        pageUrl: payload.pageUrl,
      },
    })

    if (result?.mode === 'm3u8-file' && result.cleaned) {
      logger.info('HLS ad filter applied, cleaned m3u8 available')
      window.postMessage({ source: 'sdown-hls', type: 'm3u8-cleaned', payload: { cleaned: result.cleaned, baseUrl: payload.baseUrl } }, '*')
    }
  } catch (e) {
    logger.warn('processHlsPlaylist failed:', (e as Error).message)
  }
}

async function handleMseDetected(payload: Record<string, string>): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: 'sdown-mse-source',
      mimeType: payload.mimeType,
      url: payload.url,
    })
  } catch (e) {
    logger.warn('MSE notify failed:', (e as Error).message)
  }
}
