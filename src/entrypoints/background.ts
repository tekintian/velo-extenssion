import { defineBackground } from 'wxt/utils/define-background'
import { logger } from '@/lib/logger'
import { i18n } from '@/lib/i18n'
import { initMessageRouter, registerHandler } from '@/background/messaging/router'
import { PairingManager } from '@/background/pairing'
import { createPushClient } from '@/background/push-client'
import { startSniffer, setM3u8ProcessHandler, getMediaItems } from '@/background/media/sniffer'
import { setPushClient, pushHls, pushUrl, pushNormal } from '@/background/media/download-client'
import { registerMediaHandlers } from '@/background/media/handler'
import { buildConfig, DEFAULT_CONFIG, processPlaylist } from '@/engine/hls/hls-filter'
import { registerHlsHandlers } from '@/background/hls/handler'
import { loadRemoteCacheFromStorage } from '@/engine/hls/hls-rules'
import { DEFAULT_CONFIG as DEFAULT_SDOWN_CONFIG, type VeloConfig } from '@/types'
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
let config: VeloConfig = { ...DEFAULT_SDOWN_CONFIG }

function registerHandlers(): void {
  registerHlsHandlers()
  // P0-3: 注册媒体嗅探/下载相关 handler（getCurrentTabId/getMediaItems/sendToDownload 等 8 个）
  // 此前遗漏调用，导致 player-panel.content.ts 轮询全失败、所有下载按钮报错
  registerMediaHandlers()

  // P0-5: HLS 委派状态查询 — hls-bridge.content.ts 启动时调用，决定 MAIN world 是否安装 fetch/XHR hook
  // 返回 'active' 表示扩展接管页面 m3u8 过滤
  registerHandler('getHlsDelegation', async () => {
    return { mode: 'active', reason: 'ad-filter-enabled' }
  })

  registerHandler('velo-get-status', async () => {
    return { paired: !!pushClient, config }
  })

  // === task #13: MSE 媒体用户提示 UI ===
  // 旧实现仅 log，无 UI 反馈。新实现：
  //   1. chrome.notifications 桌面通知（用户在系统通知中心看到）
  //   2. 广播给当前 tab 的 player-panel.content.ts 显示页面内 toast
  // 仅在「首次检测到 MSE 源」时通知一次（per tab），避免分片流刷屏
  const mseNotifiedTabs = new Set<number>()
  registerHandler<{ mimeType?: string; url?: string }>('velo-mse-source', async (message, sender) => {
    const { mimeType, url } = message.payload
    logger.info('MSE detected media:', mimeType, url)
    const tabId = sender.tab?.id ?? 0
    if (tabId > 0 && !mseNotifiedTabs.has(tabId)) {
      mseNotifiedTabs.add(tabId)
      // 桌面通知
      try {
        void chrome.notifications.create(`velo-mse-${tabId}`, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: i18n('mse_detected_title'),
          message: i18n('mse_detected_body'),
          priority: 1,
        })
      } catch (e) {
        logger.debug('chrome.notifications 不可用:', (e as Error).message)
      }
      // 页面内 toast
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'mseMediaDetected',
          payload: { mimeType: mimeType ?? '', url: url ?? '' },
        })
      } catch {
        // content script 未注入 — 忽略
      }
    }
    return { ok: true }
  })

  registerHandler<{ hash?: string; size?: number; mimeType?: string; url?: string }>('velo-mse-segment', async (message) => {
    // task #12: 接收 SHA-256 指纹，仅 log（未来可用于广告指纹比对）
    const { hash, size, mimeType } = message.payload
    if (hash) {
      logger.debug('MSE segment hash:', hash.slice(0, 16) + '...', 'size:', size, 'mime:', mimeType)
    }
    return { ok: true }
  })

  // === task #7: pageUrl 主动上报 ===
  // content script 在 SPA 路由变化时主动告知 background 当前 URL+title
  // 等价 NDM ct.js va() 函数：postMessage([2, tabId, location.href, document.title])
  registerHandler<{ url: string; title?: string }>('velo-report-page-url', async (message, sender) => {
    const { url, title } = message.payload
    const tabId = sender.tab?.id ?? 0
    logger.info('[velo] pageUrl reported:', url.slice(0, 80), 'tabId:', tabId, 'title:', title ? title.slice(0, 40) : '(empty)')
    return { ok: true, tabId }
  })

  // === task #9/#11: 全局显隐广播 [13, visibility] ===
  // 工具栏图标点击 / popup 切换 → 广播给当前 tab 所有 content script
  registerHandler<{ visible: boolean }>('velo-toggle-visibility', async (message, sender) => {
    const { visible } = message.payload
    const tabId = sender.tab?.id
    logger.info('[velo] toggle visibility:', visible, 'tabId:', tabId)
    if (tabId && tabId > 0) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'veloVisibilityChanged',
          payload: { visible },
        })
      } catch {
        // content script 未注入 — 忽略
      }
    }
    return { ok: true, visible }
  })

  registerHandler<{ cleaned: string; baseUrl: string; pageUrl?: string }>('velo-push-filtered-m3u8', async (message) => {
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
      // P0 修复：content script 推送的过滤后 m3u8 也需携带认证信息
      const effectivePageUrl = pageUrl || baseUrl
      let cookies = ''
      try {
        const cookieList = await chrome.cookies.getAll({ url: baseUrl })
        if (cookieList.length > 0) {
          cookies = cookieList.map((c) => `${c.name}=${c.value}`).join('; ')
        }
      } catch { /* ignore */ }
      await pushHls(descriptor, cleaned, { mergeFormat: config.mergeFormat }, { pageUrl: effectivePageUrl, cookies })
      logger.info('AdClear filtered m3u8 pushed to desktop:', baseUrl.slice(0, 80))
      return { ok: true }
    } catch (e) {
      logger.error('Push AdClear filtered m3u8 failed:', (e as Error).message)
      return { ok: false, error: (e as Error).message }
    }
  })

  registerHandler('velo-download-m3u8', async (_message, sender) => {
    logger.info('Badge download request, tab:', sender.tab?.id)
    return { ok: true }
  })

  registerHandler('velo-ping', async () => {
    return { ok: true, version: chrome.runtime.getManifest().version }
  })

  registerHandler('velo-get-config', async () => {
    return config
  })

  registerHandler<{ config: Partial<VeloConfig> }>('velo-save-config', async (message) => {
    const newConfig = message.payload.config
    if (newConfig) {
      config = { ...config, ...newConfig }
      await configStore.set(config)
    }
    return { ok: true }
  })

  registerHandler<{ token: string; port?: number }>('velo-save-pairing', async (message) => {
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

  registerHandler('velo-clear-pairing', async () => {
    const pairing = new PairingManager()
    await pairing.clearPairing()
    if (pushClient) {
      pushClient.disconnect()
      pushClient = null
    }
    setPushClient(null)
    return { ok: true }
  })

  registerHandler<{ token: string; port?: number }>('velo-validate-pairing', async (message) => {
    const { token, port } = message.payload
    const pairing = new PairingManager()
    const valid = await pairing.validatePairing(token ?? '', port ?? DEFAULT_SDOWN_CONFIG.port)
    return { ok: valid }
  })
}

async function initBackground(): Promise<void> {
  logger.info('Background async init starting')

  const stored = await configStore.get<VeloConfig>()
  config = { ...DEFAULT_SDOWN_CONFIG, ...stored }

  // P3-1: SW 重启后远程规则内存缓存丢失，从 storage 恢复
  // 否则要等下次 refreshRemoteRules 才能恢复，期间远程规则不生效
  await loadRemoteCacheFromStorage().catch((e) => {
    logger.warn('loadRemoteCacheFromStorage failed:', (e as Error).message)
  })

  const pairing = new PairingManager()
  const pairingInfo = await pairing.getPairing()
  if (pairingInfo) {
    pushClient = createPushClient(config.pushChannel, pairingInfo.port, pairingInfo.token)
    pushClient.connect()
    setPushClient(pushClient)
  }

  startSniffer()
  setM3u8ProcessHandler(veloProcessM3u8)

  chrome.contextMenus.create({
    id: 'velo-download-link',
    title: '使用 velo 下载',
    contexts: ['link', 'image', 'video', 'audio'],
  })

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'velo-download-link') {
      void handleContextMenu(info, tab)
    }
  })

  logger.info('Background async init done')
}

async function veloProcessM3u8(
  m3u8Url: string,
  tabId: number,
  sniffedHeaders?: Record<string, string>,
): Promise<void> {
  try {
    if (!config.enableFilter) {
      logger.info('[velo] filter disabled, skip m3u8 processing')
      return
    }

    // P0-4: 用真实页面 URL（而非 m3u8 URL）作为 pageUrl
    // 跨域 CDN 场景下，m3u8 的 origin 是 CDN 源而非观看页源，
    // 导致 buildVeloHeaders 提取的 Origin/Referer 错误，服务器校验失败 403
    let pageUrl = m3u8Url
    if (tabId > 0) {
      try {
        const tab = await chrome.tabs.get(tabId)
        if (tab.url) pageUrl = tab.url
      } catch { /* ignore，回退到 m3u8Url */ }
    }

    const fetchHeaders: Record<string, string> = {}
    try {
      const cookieList = await chrome.cookies.getAll({ url: m3u8Url })
      if (cookieList.length > 0) {
        fetchHeaders['Cookie'] = cookieList.map((c) => `${c.name}=${c.value}`).join('; ')
      }
    } catch { /* ignore */ }
    if (sniffedHeaders) {
      for (const [name, value] of Object.entries(sniffedHeaders)) {
        fetchHeaders[name] = value
      }
    }
    const fetchInit: RequestInit = { cache: 'no-store' }
    if (Object.keys(fetchHeaders).length > 0) {
      fetchInit.headers = fetchHeaders
    }
    const resp = await fetch(m3u8Url, fetchInit)
    if (!resp.ok) {
      logger.warn('[velo] fetch m3u8 failed:', resp.status)
      return
    }
    const text = await resp.text()

    let pageHost = ''
    try {
      pageHost = new URL(m3u8Url).host
    } catch { /* ignore */ }

    const cfg = await buildConfig(
      {
        ...DEFAULT_CONFIG,
        enabled: config.enableFilter,
        scoreThreshold: config.scoreThreshold,
      },
      pageHost,
    )

    let hlsAuthHeaders: Record<string, string> | undefined
    try {
      const items = getMediaItems(0)
      const m3u8Item = items.find((i) => i.ext === 'm3u8' || i.ext === 'm3u')
      if (m3u8Item?.requestHeaders && Object.keys(m3u8Item.requestHeaders).length > 0) {
        hlsAuthHeaders = m3u8Item.requestHeaders
      }
    } catch { /* ignore */ }

    const result = await processPlaylist(text, m3u8Url, m3u8Url, cfg, hlsAuthHeaders)

    const descriptor: MediaDescriptor = {
      url: m3u8Url,
      pageUrl,  // P0-4: 用真实观看页 URL
      method: 'GET',
      ext: '.m3u8',
      mime: 'application/vnd.apple.mpegurl',
      contentLength: text.length,
      contentType: 'application/vnd.apple.mpegurl',
      contentDisposition: '',
      headers: sniffedHeaders ?? {},
    }

    // P0 修复：推送时携带完整认证信息（Cookie/Referer/Origin/UA/Authorization）
    // P0-4: pageUrl 用真实观看页 URL（chrome.tabs.get），跨域 CDN 场景下 Origin/Referer 正确
    const pushExtra: { pageUrl: string; cookies?: string; requestHeaders?: Record<string, string> } = {
      pageUrl,
    }
    if (fetchHeaders['Cookie']) pushExtra.cookies = fetchHeaders['Cookie']
    if (sniffedHeaders) pushExtra.requestHeaders = sniffedHeaders

    if (result.mode === 'master') {
      const variants = ('variants' in result ? result.variants : []) as Array<{ url: string }>
      if (variants.length > 0) {
        await pushUrl(variants[0]!.url, descriptor, { mergeFormat: config.mergeFormat }, pushExtra)
      }
      return
    }

    if (result.mode === 'no-ads' || result.mode === 'disabled' || result.mode === 'passthrough') {
      if (config.autoPush) {
        await pushHls(descriptor, text, { mergeFormat: config.mergeFormat }, pushExtra)
      }
      return
    }

    if ('cleaned' in result && typeof result.cleaned === 'string') {
      if (config.autoPush) {
        await pushHls(descriptor, result.cleaned, { mergeFormat: config.mergeFormat }, pushExtra)
        logger.info('[velo] HLS push completed')
      }
    }
  } catch (e) {
    logger.error('[velo] HLS processing failed:', (e as Error).message)
  }
}

async function handleContextMenu(info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab | undefined): Promise<void> {
  const url = info.linkUrl || info.srcUrl || info.pageUrl
  if (!url) return

  // P0 修复：右键下载也需携带认证信息（Cookie/Referer/Origin）
  const pageUrl = tab?.url || url
  let cookies = ''
  try {
    const cookieList = await chrome.cookies.getAll({ url })
    if (cookieList.length > 0) {
      cookies = cookieList.map((c) => `${c.name}=${c.value}`).join('; ')
    }
  } catch { /* ignore */ }

  await pushNormal(
    { url, pageUrl, method: 'GET', ext: '', mime: '', contentLength: 0, contentType: '', contentDisposition: '', headers: {} },
    { pageUrl, cookies },
  )
}