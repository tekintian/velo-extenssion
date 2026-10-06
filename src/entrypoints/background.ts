import { defineBackground } from 'wxt/utils/define-background'
import { logger } from '@/lib/logger'
import { initMessageRouter, registerHandler } from '@/background/messaging/router'
import { PairingManager } from '@/background/pairing'
import { createPushClient } from '@/background/push-client'
import { registerWebRequestHandlers, isM3u8, getMediaItems } from '@/background/media/sniffer'
import { setPushClient, pushHls, pushUrl, pushNormal } from '@/background/media/download-client'
import { processPlaylist, buildConfig, DEFAULT_CONFIG } from '@/engine/hls/hls-filter'
import { registerHlsHandlers } from '@/background/hls/handler'
import { DEFAULT_CONFIG as DEFAULT_SDOWN_CONFIG, type SdownConfig } from '@/types'
import { configStore } from '@/lib/storage'
import type { MediaDescriptor } from '@/types'

export default defineBackground({
  type: 'module',

  main() {
    self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
      const reason = event.reason
      logger.error(
        'Unhandled Promise rejection:',
        reason === null ? 'null' : reason === undefined ? 'undefined' : reason,
      )
      event.preventDefault()
    })

    initMessageRouter()
    registerHandlers()

    void initBackground().catch((e) => {
      logger.error('initBackground failed:', (e as Error).message)
    })

    logger.info('Background service worker started')
  },

  persistent: false,
})

let pushClient: ReturnType<typeof createPushClient> | null = null
let config: SdownConfig = { ...DEFAULT_SDOWN_CONFIG }

function registerHandlers(): void {
  registerHlsHandlers()

  registerHandler('sdown-get-status', async () => {
    return { paired: !!pushClient, config }
  })

  registerHandler<{ mimeType?: string; url?: string }>('sdown-mse-source', async (message) => {
    logger.info('MSE detected media:', message.payload.mimeType, message.payload.url)
    return { ok: true }
  })

  registerHandler('sdown-mse-segment', async () => {
    return { ok: true }
  })

  registerHandler<{ cleaned: string; baseUrl: string; pageUrl?: string }>('sdown-push-filtered-m3u8', async (message) => {
    const { cleaned, baseUrl, pageUrl } = message.payload
    if (!cleaned || !baseUrl) return { ok: false, error: 'missing cleaned or baseUrl' }

    try {
      const descriptor: MediaDescriptor = {
        url: baseUrl,
        pageUrl: pageUrl ?? '',
        method: 'GET',
        ext: '.m3u8',
        mime: 'application/vnd.apple.mpegurl',
        contentLength: cleaned.length,
        contentType: 'application/vnd.apple.mpegurl',
        contentDisposition: '',
        headers: {},
      }
      await pushHls(descriptor, cleaned, { mergeFormat: config.mergeFormat })
      logger.info('AdClear filtered m3u8 pushed to desktop:', baseUrl.slice(0, 80))
      return { ok: true }
    } catch (e) {
      logger.error('Push AdClear filtered m3u8 failed:', (e as Error).message)
      return { ok: false, error: (e as Error).message }
    }
  })

  registerHandler('sdown-download-m3u8', async (_message, sender) => {
    logger.info('Badge download request, tab:', sender.tab?.id)
    return { ok: true }
  })

  registerHandler('sdown-ping', async () => {
    return { ok: true, version: chrome.runtime.getManifest().version }
  })

  registerHandler('sdown-get-config', async () => {
    return config
  })

  registerHandler<{ config: Partial<SdownConfig> }>('sdown-save-config', async (message) => {
    const newConfig = message.payload.config
    if (newConfig) {
      config = { ...config, ...newConfig }
      await configStore.set(config)
    }
    return { ok: true }
  })

  registerHandler<{ token: string; port?: number }>('sdown-save-pairing', async (message) => {
    const { token, port } = message.payload
    if (!token) return { ok: false, error: 'Token required' }
    const pairing = new PairingManager()
    await pairing.savePairing(token, port ?? DEFAULT_SDOWN_CONFIG.port)
    if (pushClient) pushClient.disconnect()
    pushClient = createPushClient(config.pushChannel, port ?? DEFAULT_SDOWN_CONFIG.port, token)
    pushClient.connect()
    setPushClient(pushClient)
    return { ok: true }
  })

  registerHandler('sdown-clear-pairing', async () => {
    const pairing = new PairingManager()
    await pairing.clearPairing()
    if (pushClient) {
      pushClient.disconnect()
      pushClient = null
    }
    setPushClient(null)
    return { ok: true }
  })

  registerHandler<{ token: string; port?: number }>('sdown-validate-pairing', async (message) => {
    const { token, port } = message.payload
    const pairing = new PairingManager()
    const valid = await pairing.validatePairing(token ?? '', port ?? DEFAULT_SDOWN_CONFIG.port)
    return { ok: valid }
  })
}

async function initBackground(): Promise<void> {
  logger.info('Background async init starting')

  const stored = await configStore.get<SdownConfig>()
  config = { ...DEFAULT_SDOWN_CONFIG, ...stored }

  const pairing = new PairingManager()
  const pairingInfo = await pairing.getPairing()
  if (pairingInfo) {
    pushClient = createPushClient(config.pushChannel, pairingInfo.port, pairingInfo.token)
    pushClient.connect()
    setPushClient(pushClient)
  }

  registerWebRequestHandlers(handleDetected)

  chrome.contextMenus.create({
    id: 'sdown-download-link',
    title: '使用 sdown 下载',
    contexts: ['link', 'image', 'video', 'audio'],
  })

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'sdown-download-link') {
      void handleContextMenu(info, tab)
    }
  })

  logger.info('Background async init done')
}

async function handleDetected(descriptor: MediaDescriptor, _details: unknown): Promise<void> {
  logger.info('Detected media:', descriptor.ext, descriptor.url.slice(0, 80))

  if (isM3u8(descriptor)) {
    await handleHls(descriptor)
  } else {
    await pushNormal(descriptor)
  }
}

async function handleHls(descriptor: MediaDescriptor): Promise<void> {
  try {
    // fetch m3u8 时携带认证头
    const fetchHeaders: Record<string, string> = {}
    try {
      const cookieList = await chrome.cookies.getAll({ url: descriptor.url })
      if (cookieList.length > 0) {
        fetchHeaders['Cookie'] = cookieList.map((c) => `${c.name}=${c.value}`).join('; ')
      }
    } catch { /* ignore */ }
    const fetchInit: RequestInit = { cache: 'no-store' }
    if (Object.keys(fetchHeaders).length > 0) {
      fetchInit.headers = fetchHeaders
    }
    const resp = await fetch(descriptor.url, fetchInit)
    const text = await resp.text()

    let pageHost = ''
    try {
      if (descriptor.pageUrl) pageHost = new URL(descriptor.pageUrl).host
    } catch { /* ignore */ }

    const cfg = await buildConfig(
      {
        ...DEFAULT_CONFIG,
        enabled: config.enableFilter,
        scoreThreshold: config.scoreThreshold,
      },
      pageHost,
    )

    // 从嗅探器提取 requestHeaders 供指纹 fetch 认证
    let hlsAuthHeaders: Record<string, string> | undefined
    try {
      const items = getMediaItems(0)
      const m3u8Item = items.find((i) => i.ext === 'm3u8' || i.ext === 'm3u')
      if (m3u8Item?.requestHeaders && Object.keys(m3u8Item.requestHeaders).length > 0) {
        hlsAuthHeaders = m3u8Item.requestHeaders
      }
    } catch { /* ignore */ }

    const result = await processPlaylist(text, descriptor.url, descriptor.pageUrl, cfg, hlsAuthHeaders)

    if (result.mode === 'master') {
      const variants = ('variants' in result ? result.variants : []) as Array<{ url: string }>
      if (variants.length > 0) {
        await pushUrl(variants[0]!.url, descriptor, { mergeFormat: config.mergeFormat })
      }
      return
    }

    if (result.mode === 'no-ads' || result.mode === 'disabled' || result.mode === 'passthrough') {
      if (config.autoPush) {
        await pushHls(descriptor, text, { mergeFormat: config.mergeFormat })
      }
      return
    }

    if ('cleaned' in result && typeof result.cleaned === 'string') {
      if (config.autoPush) {
        await pushHls(descriptor, result.cleaned, { mergeFormat: config.mergeFormat })
        logger.info('HLS push completed')
      }
    }
  } catch (e) {
    logger.error('HLS processing failed:', (e as Error).message)
  }
}

async function handleContextMenu(info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab | undefined): Promise<void> {
  const url = info.linkUrl || info.srcUrl || info.pageUrl
  if (!url) return

  await pushNormal({ url, pageUrl: tab?.url || '', method: 'GET', ext: '', mime: '', contentLength: 0, contentType: '', contentDisposition: '', headers: {} })
}
