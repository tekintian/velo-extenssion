import { defineBackground } from 'wxt/utils/define-background'
import { logger } from '@/lib/logger'
import { i18n } from '@/lib/i18n'
import { initMessageRouter, registerHandler } from '@/background/messaging/router'
import { PairingManager, type ProbeResult } from '@/background/pairing'
import { createPushClient, PushUnconfirmedError } from '@/background/push-client'
import { startSniffer, setM3u8ProcessHandler, getMediaItems, resolveHlsDelegation } from '@/background/media/sniffer'
import { setPushClient, pushHls, pushNormal, initCachedDownloadConfig, updateCachedDownloadConfig, getCachedDownloadConfig } from '@/background/media/download-client'
import type { DownloadClientConfig } from '@/background/media/types'
import { registerMediaHandlers } from '@/background/media/handler'
import { buildConfig, DEFAULT_CONFIG, processPlaylist, resolveMediaVariant } from '@/engine/hls/hls-filter'
import { registerHlsHandlers } from '@/background/hls/handler'
import { registerDashHandlers } from '@/background/dash/handler'
import { loadRemoteCacheFromStorage } from '@/engine/hls/hls-rules'
import { migrateAdFilterKeys } from '@engine/shared/storage'
import { recordStats } from '@/engine/hls/stats'
import { DEFAULT_PORT, STORAGE_KEYS } from '@/types'
import { persistentStorage, settingsStore } from '@/lib/storage'
import type { MediaDescriptor, Settings } from '@/types'
import { extractBaseName } from '@/lib/naming'
import { initSeedSitesIfNeeded } from '@/engine/hls/hls-sites'

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

function registerHandlers(): void {
  registerHlsHandlers()
  registerDashHandlers()
  // P0-3: 注册媒体嗅探/下载相关 handler（getCurrentTabId/getMediaItems/sendToDownload 等 8 个）
  // 此前遗漏调用，导致 player-panel.content.ts 轮询全失败、所有下载按钮报错
  registerMediaHandlers()

  // P0-5: HLS 委派状态查询 — hls-bridge.content.ts 启动时调用，决定 MAIN world 是否安装 fetch/XHR hook
  // 返回 'active' 表示扩展接管页面 m3u8 过滤
  registerHandler('getHlsDelegation', async (_message, sender) => {
    const pageUrl = sender.tab?.url ?? ''
    const { active, reason } = await resolveHlsDelegation(pageUrl)
    return { mode: active ? ('active' as const) : ('delegated' as const), reason }
  })

  registerHandler('velo-get-status', async () => {
    const pairing = new PairingManager()
    return { paired: !!pushClient, pairing: await pairing.getPairing() }
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

  registerHandler('getExtensionEnabled', async () => {
    const val = await persistentStorage.get<{ enabled: boolean }>('extensionGlobalConfig')
    return { enabled: val?.enabled ?? true }
  })

  registerHandler<{ enabled: boolean }>('setExtensionEnabled', async (message) => {
    const { enabled } = message.payload
    await persistentStorage.set('extensionGlobalConfig', { enabled })
    return { ok: true, enabled }
  })

  registerHandler('velo-get-pairing', async () => {
    const pairing = new PairingManager()
    return { pairing: await pairing.getPairing() }
  })

  registerHandler<{ token?: string; port?: number }>('velo-save-pairing', async (message) => {
    const { token, port } = message.payload
    const pairing = new PairingManager()
    await pairing.savePairing(token ?? '', port ?? DEFAULT_PORT)
    // 用户主动保存配对 → 清除自动连接冷却，立即建立连接
    await clearAutoConnectFailure()
    if (pushClient) pushClient.disconnect()
    pushClient = createPushClient(port ?? DEFAULT_PORT, token ?? '')
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

  registerHandler('velo-auto-connect', async () => {
    // popup 手动触发属于用户主动行为，绕过节流冷却
    const result = await tryAutoConnect(true)
    return result
  })
}

async function initBackground(): Promise<void> {
  logger.info('Background async init starting')

  await migrateAdFilterKeys()

  try {
    const seedSettings = await settingsStore.get<Partial<Settings>>()
    const runMode = seedSettings?.hlsRunMode ?? 'smart'
    await initSeedSitesIfNeeded(runMode)
  } catch (e) {
    logger.warn('[hls-sites] seed init failed:', (e as Error).message)
  }

  await initCachedDownloadConfig()

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.downloadClientConfig?.newValue) {
      updateCachedDownloadConfig(changes.downloadClientConfig.newValue as DownloadClientConfig)
    }
  })

  // P3-1: SW 重启后远程规则内存缓存丢失，从 storage 恢复
  // 否则要等下次 refreshRemoteRules 才能恢复，期间远程规则不生效
  await loadRemoteCacheFromStorage().catch((e) => {
    logger.warn('loadRemoteCacheFromStorage failed:', (e as Error).message)
  })

  const pairing = new PairingManager()
  const pairingInfo = await pairing.getPairing()
  if (await isAutoConnectCoolingDown()) {
    // 冷却窗口内不再探测：桌面端未启动是常规状态，避免 SW 频繁唤醒反复建 WS
    logger.info('Auto-connect skipped: recent failure within cooldown window')
  } else if (pairingInfo) {
    const probeResult = await pairing.probeClient([pairingInfo.port])
    if (probeResult.available) {
      await clearAutoConnectFailure()
      pushClient = createPushClient(probeResult.port, pairingInfo.token)
      pushClient.connect()
      setPushClient(pushClient)
    } else {
      await markAutoConnectFailed()
      logger.info(
        'Paired client on port',
        pairingInfo.port,
        'is not reachable — skip auto-connect (cooldown)',
      )
    }
  } else {
    void tryAutoConnect()
  }

  startSniffer()
  setM3u8ProcessHandler(veloProcessM3u8)

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      {
        id: 'velo-download-link',
        title: '使用 velo 下载',
        contexts: ['link', 'image', 'video', 'audio'],
      },
      () => {
        // 必须消费 lastError，否则 Chrome 会打印 "Unchecked runtime.lastError"
        if (chrome.runtime.lastError) {
          logger.debug('contextMenus.create failed:', chrome.runtime.lastError.message ?? '')
        }
      },
    )
  })

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'velo-download-link') {
      void handleContextMenu(info, tab)
    }
  })

  logger.info('Background async init done')
}

/**
 * 自动连接失败冷却窗口（5 分钟）
 *
 * 桌面端未启动属于常规状态。直接 new WebSocket 探测会在扩展控制台产生
 * `net::ERR_CONNECTION_REFUSED` 浏览器原生日志（JS 无法捕获）。MV3 service worker
 * 会被频繁唤醒，若每次唤醒都无脑探测就会刷屏。因此把「上次失败时间」持久化，
 * 冷却窗口内跳过自动探测；用户主动触发（popup 手动连接 / 保存配对 / 点击下载）不受限制。
 */
const AUTO_CONNECT_COOLDOWN_MS = 5 * 60 * 1000

async function isAutoConnectCoolingDown(): Promise<boolean> {
  try {
    const lastFailAt = await persistentStorage.get<number>(STORAGE_KEYS.autoConnectFailAt)
    if (typeof lastFailAt !== 'number') return false
    return Date.now() - lastFailAt < AUTO_CONNECT_COOLDOWN_MS
  } catch {
    return false
  }
}

async function markAutoConnectFailed(): Promise<void> {
  try {
    await persistentStorage.set(STORAGE_KEYS.autoConnectFailAt, Date.now())
  } catch {
    /* ignore */
  }
}

async function clearAutoConnectFailure(): Promise<void> {
  try {
    await persistentStorage.remove(STORAGE_KEYS.autoConnectFailAt)
  } catch {
    /* ignore */
  }
}

async function tryAutoConnect(force = false): Promise<ProbeResult & { connected?: boolean }> {
  if (!force && (await isAutoConnectCoolingDown())) {
    logger.info('Auto-connect skipped: recent failure within cooldown window')
    return { available: false, port: 0, tokenRequired: true, connected: false }
  }
  const pairing = new PairingManager()
  const savedPairing = await pairing.getPairing()
  const probePorts = [DEFAULT_PORT]
  if (savedPairing && savedPairing.port !== DEFAULT_PORT) {
    probePorts.push(savedPairing.port)
  }
  const result = await pairing.probeClient(probePorts)
  if (result.available) {
    let token = ''
    if (result.tokenRequired) {
      // 客户端要求 token：使用已保存的配对 token
      token = savedPairing?.token ?? ''
      if (!token) {
        // 无可用 token → 用空 token 尝试握手，验证客户端是否实际需要 token
        // 有些客户端 tokenRequired=true 但空 token 也能通过（宽松模式）
        const valid = await pairing.validatePairing('', result.port)
        if (!valid) {
          logger.warn('Client requires token but none configured — skipping auto-connect. Please set token in settings.')
          return { ...result, connected: false }
        }
        // 空 token 握手成功 → 继续用空 token 连接
      }
    }
    await clearAutoConnectFailure()
    await pairing.savePairing(token, result.port)
    if (pushClient) pushClient.disconnect()
    pushClient = createPushClient(result.port, token)
    pushClient.connect()
    setPushClient(pushClient)
    logger.info('Auto-connected to Velo client on port', result.port, 'tokenRequired:', result.tokenRequired, 'token:', token ? '***' : '(empty)')
    return { ...result, connected: true }
  }
  await markAutoConnectFailed()
  logger.info('Velo client not detected, auto-connect skipped (cooldown 5min)')
  return { ...result, connected: false }
}

/**
 * 统一 m3u8 处理入口（移植自 NDM bg.js X.i + V.V m3u8 分支）
 *
 * 对齐 NDM 行为：
 *   1. fetch m3u8 文本 → processPlaylist 广告检测+清洗
 *   2. 广播 hlsFilterReport 给 badge content script（显示角标统计）
 *   3. 广播 hlsFilterResult 给 badge content script（显示下载按钮 + AdSkipper）
 *   4. 持久化 cleaned context 到 storage（供下载按钮用）
 *   5. autoPush 时推送到桌面端下载客户端
 *
 * 旧实现仅做推送，不广播给 badge，导致角标不显示、AdSkipper 不工作、广告跳过无效。
 */
async function veloProcessM3u8(
  m3u8Url: string,
  tabId: number,
  sniffedHeaders?: Record<string, string>,
): Promise<void> {
  try {
    logger.info('[velo][DIAG-1] veloProcessM3u8 entered, url:', m3u8Url.slice(0, 100), 'tabId:', tabId)
    const hlsCfg = (await persistentStorage.get<Record<string, unknown>>('hlsFilterConfig')) ?? {}
    const enableFilter = (hlsCfg.enableAdSkip as boolean) ?? true
    const scoreThreshold = (hlsCfg.scoreThreshold as number) ?? 3
    if (!enableFilter) {
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
    const MAX_FETCH_RETRIES = 3
    const FETCH_RETRY_BASE_MS = 500
    let resp: Response | null = null
    for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt++) {
      try {
        resp = await fetch(m3u8Url, fetchInit)
        if (resp.ok) break
        logger.warn('[velo] fetch m3u8 failed:', resp.status, 'attempt:', attempt)
        resp = null
      } catch (fetchErr) {
        logger.warn('[velo] fetch m3u8 threw:', (fetchErr as Error).message, 'attempt:', attempt)
        resp = null
      }
      if (attempt < MAX_FETCH_RETRIES) {
        const delay = FETCH_RETRY_BASE_MS * Math.pow(2, attempt - 1)
        await new Promise((r) => setTimeout(r, delay))
      }
    }
    if (!resp) {
      logger.error('[velo] fetch m3u8 failed after', MAX_FETCH_RETRIES, 'retries, url:', m3u8Url.slice(0, 120))
      return
    }
    const text = await resp.text()

    let pageHost = ''
    try {
      pageHost = new URL(m3u8Url).host
    } catch { /* ignore */ }

    // 页面播放链路永不替换响应，广告一律靠 adRanges seek 跳过，
    // 因此这里不再需要判定 hook 委派状态，区间恒为原始时间轴坐标全量下发。
    const cfg = await buildConfig(
      {
        ...DEFAULT_CONFIG,
        enabled: enableFilter,
        scoreThreshold,
      },
      pageHost,
    )

    let hlsAuthHeaders: Record<string, string> | undefined
    try {
      const items = getMediaItems(tabId)
      const m3u8Item = items.find((i) => i.ext === 'm3u8' || i.ext === 'm3u')
      if (m3u8Item?.requestHeaders && Object.keys(m3u8Item.requestHeaders).length > 0) {
        hlsAuthHeaders = m3u8Item.requestHeaders
      }
    } catch { /* ignore */ }

    const raw = await processPlaylist(text, m3u8Url, m3u8Url, cfg, hlsAuthHeaders)

    // master 列表下钻：广告都在变体媒体列表里，主列表只有索引（几十字节），
    // 不递归就只能得到 0 广告，导致角标不显示、下载按钮消失、跳过失效。
    // 下钻后的地址与原文同时供检测与下载上下文使用，避免把主列表当地址。
    let resolved = raw
    let mediaUrl = m3u8Url
    let mediaText = text
    if (raw.mode === 'master') {
      const variant = await resolveMediaVariant(text, m3u8Url, cfg, hlsAuthHeaders)
      if (!variant) {
        logger.info('[velo] master playlist has no usable variant, url:', m3u8Url.slice(0, 100))
        return
      }
      mediaUrl = variant.url
      mediaText = variant.text
      resolved = await processPlaylist(variant.text, variant.url, m3u8Url, cfg, hlsAuthHeaders)
    }

    // === 广播 hlsFilterReport 给 badge（对齐 NDM bg.js 行 504-510：广播 [16, report]） ===
    if (resolved.report && tabId > 0) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'hlsFilterReport',
          report: resolved.report,
        })
      } catch (e) {
        logger.warn('[velo][DIAG-2FAIL] hlsFilterReport send failed, tabId:', tabId, 'err:', (e as Error).message)
      }
    }

    logger.info('[velo][DIAG-2] processPlaylist done, mode:', resolved.mode,
      'hasCleaned:', 'cleaned' in resolved,
      'hasAdRanges:', 'adRanges' in resolved ? (resolved.adRanges as unknown[]).length : 0,
      'report.ads:', resolved.report && 'ads' in resolved.report ? resolved.report.ads : 0)

    // === 记录统计 ===
    if (resolved.report && 'ads' in resolved.report && resolved.report.ads > 0) {
      try {
        await recordStats(
          resolved.report as { ads: number; adDuration: number; contentDuration: number; appliedRule?: { id: string } | null },
          pageHost,
        )
      } catch (e) {
        logger.warn('[velo] recordStats failed:', (e as Error).message)
      }
    }

    // === 持久化 cleaned context + 广播 hlsFilterResult 给 badge（对齐 NDM bg.js 行 543-558） ===
    // NDM：存 _lastCleaned[tabId]，广播 [18] 给 ct 显示"下载"按钮 + AdSkipper
    // cleaned 只供下载/推送；页面播放数据源始终为原始列表，广告靠区间 seek 跳过
    if ('cleaned' in resolved && typeof resolved.cleaned === 'string' && tabId > 0) {
      const baseName = extractBaseName(mediaUrl)
      const adRanges = 'adRanges' in resolved ? resolved.adRanges : []
      let pageTitle = ''
      try {
        const tab = await chrome.tabs.get(tabId)
        pageTitle = tab?.title?.trim() || ''
      } catch { /* ignore */ }

      // 持久化 cleaned context（供下载按钮用，对齐 NDM _lastCleaned + _persistCtx）
      try {
        const ctx = {
          cleaned: resolved.cleaned,
          baseName,
          pageTitle,
          report: resolved.report,
          segments: 'segments' in resolved ? resolved.segments : [],
          reasons: 'reasons' in resolved ? resolved.reasons : {},
          pageHost,
          baseUrl: mediaUrl,
          detectedAt: Date.now(),
          playback: 'original' as const,
        }
        const CLEANED_KEY = 'hlsLastCleaned'
        const all = (await persistentStorage.get<Record<string, typeof ctx>>(CLEANED_KEY)) ?? {}
        all[String(tabId)] = ctx
        await persistentStorage.set(CLEANED_KEY, all)
      } catch (e) {
        logger.warn('[velo] persist cleaned context failed:', (e as Error).message)
      }

      // 广播 hlsFilterResult 给 badge（显示下载按钮 + AdSkipper）
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'hlsFilterResult',
          adRanges,
          baseName,
          pageTitle,
          report: resolved.report,
        })
        logger.info('[velo][DIAG-3] hlsFilterResult sent:', adRanges?.length ?? 0, 'ad ranges, baseName:', baseName)
      } catch (e) {
        logger.warn('[velo][DIAG-3FAIL] hlsFilterResult send failed, tabId:', tabId, 'baseName:', baseName, 'err:', (e as Error).message)
      }
    }

    // === 推送到桌面端下载客户端（autoPush 控制，对齐 NDM V.I WebSocket 推送） ===
    // descriptor 必须指向实际媒体列表（master 已下钻），否则下载客户端拿到的主列表没有分片
    const descriptor: MediaDescriptor = {
      url: mediaUrl,
      pageUrl,
      method: 'GET',
      ext: '.m3u8',
      mime: 'application/vnd.apple.mpegurl',
      contentLength: mediaText.length,
      contentType: 'application/vnd.apple.mpegurl',
      contentDisposition: '',
      headers: sniffedHeaders ?? {},
    }

    const pushExtra: { pageUrl: string; cookies?: string; requestHeaders?: Record<string, string> } = {
      pageUrl,
    }
    if (fetchHeaders['Cookie']) pushExtra.cookies = fetchHeaders['Cookie']
    if (sniffedHeaders) pushExtra.requestHeaders = sniffedHeaders

    const dlCfg = getCachedDownloadConfig()

    if (resolved.mode === 'no-ads' || resolved.mode === 'disabled' || resolved.mode === 'passthrough') {
      if (dlCfg.autoPush) {
        const pushed = await pushHls(descriptor, mediaText, { mergeFormat: dlCfg.mergeFormat }, pushExtra)
        if (pushed.queued) logger.info('[velo] HLS queued (velo offline)')
        else if (pushed.pending) logger.info('[velo] HLS awaiting user confirm in velo')
      }
      return
    }

    if ('cleaned' in resolved && typeof resolved.cleaned === 'string') {
      if (dlCfg.autoPush) {
        const pushed = await pushHls(descriptor, resolved.cleaned, { mergeFormat: dlCfg.mergeFormat }, pushExtra)
        if (pushed.queued) {
          logger.info('[velo] HLS queued (velo offline)')
        } else if (pushed.pending) {
          logger.info('[velo] HLS awaiting user confirm in velo')
        } else {
          logger.info('[velo] HLS push completed')
        }
      }
    }
  } catch (e) {
    if (e instanceof PushUnconfirmedError) {
      logger.warn('[velo] HLS push unconfirmed:', e.message)
      return
    }
    logger.error('[velo] HLS processing failed:', (e as Error).message)
  }
}

async function handleContextMenu(info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab | undefined): Promise<void> {
  const url = info.linkUrl || info.srcUrl || info.pageUrl
  if (!url) return

  // P0 修复：右键下载也需携带认证信息（Cookie/Referer/Origin）
  // NDM V.W: c["2"] = a.linkUrl || a.srcUrl, c.pageUrl = a.pageUrl, c["4"] = b.title, c["5"] = b.url || a.pageUrl
  const pageUrl = tab?.url || info.pageUrl || url
  const title = tab?.title || ''
  let cookies = ''
  try {
    const cookieList = await chrome.cookies.getAll({ url })
    if (cookieList.length > 0) {
      cookies = cookieList.map((c) => `${c.name}=${c.value}`).join('; ')
    }
  } catch { /* ignore */ }

  try {
    const pushed = await pushNormal(
      { url, pageUrl, method: 'GET', ext: '', mime: '', contentLength: 0, contentType: '', contentDisposition: '', headers: {} },
      { pageUrl, cookies, title },
    )
    if (pushed.queued) logger.info('[contextMenu] push queued (velo offline):', url.slice(0, 80))
    else if (pushed.pending) logger.info('[contextMenu] push awaiting user confirm in velo:', url.slice(0, 80))
  } catch (e) {
    if (e instanceof PushUnconfirmedError) {
      logger.warn('[contextMenu] push unconfirmed:', e.message)
      return
    }
    logger.error('[contextMenu] push failed:', (e as Error).message)
  }
}