import { logger } from '@/lib/logger'
import { i18n } from '@/lib/i18n'
import { PROTOCOL_VERSION, SUB_PROTOCOL, RECONNECT_DELAYS, QUEUE_MAX_SIZE, STORAGE_KEYS } from '@/types'
import { persistentStorage } from '@/lib/storage'
import { getExtensionIdentity } from './pairing'
import type { PushMessage } from '@/types'

interface PushQueueItem {
  message: PushMessage
  retries: number
  addedAt: number
}

/**
 * T9.1: 在扩展图标上标记连接状态。
 * - 连接失败/断开 → 红色 '!' badge
 * - 连接恢复 → 清除 badge
 *
 * 用 try/catch 包裹防止在 service worker 早期初始化阶段调用 chrome.action 失败。
 */
function setBadgeError(): void {
  try {
    void chrome.action.setBadgeBackgroundColor({ color: '#ef4444' })
    void chrome.action.setBadgeText({ text: '!' })
  } catch (e) {
    logger.debug('setBadgeText 失败:', (e as Error).message)
  }
}

function clearBadge(): void {
  try {
    void chrome.action.setBadgeText({ text: '' })
  } catch (e) {
    logger.debug('clearBadge 失败:', (e as Error).message)
  }
}

/**
 * T9.1: 用 chrome.notifications 显示桌面通知（toast）告知用户「velo 未运行」。
 * 仅在「断开 → 已通知」状态切换时触发一次，避免重连风暴刷屏。
 */
let disconnectNotified = false

function notifyDisconnected(): void {
  if (disconnectNotified) return
  disconnectNotified = true
  try {
    const title = i18n('notify_disconnected_title')
    const message = i18n('notify_disconnected_body')
    void chrome.notifications.create('velo-disconnected', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      priority: 2,
    })
  } catch (e) {
    logger.debug('chrome.notifications 不可用:', (e as Error).message)
  }
}

function clearDisconnectNotification(): void {
  if (!disconnectNotified) return
  disconnectNotified = false
  try {
    void chrome.notifications.clear('velo-disconnected')
  } catch (e) {
    logger.debug('clearDisconnectNotification 失败:', (e as Error).message)
  }
}

/**
 * task #15: 连接失败时弹原生 alert 引导用户三步排查
 *
 * NDM bg.js 行 643-644 原文：
 * ```js
 * case 15:
 *   alert("Extension Can't Connect to NeatDownloadManager Application, You Can : \r\n1- Check If NeatDownloadManager is Running.\r\n2- or Hold down Delete-Key and click on the Download link.\r\n3- or Disable NeatDownloadManager Extension temporarily.");
 * ```
 *
 * MV3 service worker 没有 alert，content script 才有。
 * 实现：向当前活动 tab 的 content script 广播一条 veloConnectionFailed 消息，
 * 由 player-panel.content.ts 弹 alert（宿主页面 window.alert）。
 */
function notifyConnectionFailureWith3StepGuide(): void {
  try {
    void chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id
      if (!tabId || tabId < 0) return
      void chrome.tabs.sendMessage(tabId, { type: 'veloConnectionFailed' }).catch(() => {
        // content script 未注入 — 忽略
      })
    })
  } catch (e) {
    logger.debug('notifyConnectionFailureWith3StepGuide 失败:', (e as Error).message)
  }
}

export function createPushClient(channel: 'ws' | 'http' | 'deep-link', port: number, token: string) {
  let ws: WebSocket | null = null
  let connected = false
  let everConnected = false
  let reconnectIndex = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** 已 disconnect 的实例不再建立新连接（防止被替换后旧实例仍创建 WS） */
  let disposed = false
  /** 自动重连已用尽全部退避档位后停止，等用户主动触发再连（避免桌面端未启动时无限重连） */
  let autoReconnectExhausted = false
  const queue: PushQueueItem[] = []
  // P2: 心跳 ping — 30s 发一次，10s 无 pong 主动 close 触发重连
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let pongTimer: ReturnType<typeof setTimeout> | null = null
  let awaitingPong = false
  const HEARTBEAT_INTERVAL = 30000
  const PONG_TIMEOUT = 10000

  let nextRequestId = 1
  const pendingRequests = new Map<number, {
    resolve: () => void
    reject: (reason: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  const PUSH_RESPONSE_TIMEOUT = 15000

  // === task #10: HTTP 推送通道状态 ===
  // HTTP 通道无持久连接，用周期性健康检查代替重连：
  //   - 启动时立即探活
  //   - 每 30s 探活一次（HEALTH_CHECK_INTERVAL）
  //   - 探活成功 → connected=true + 清除 badge + flush 队列
  //   - 探活失败 → connected=false + 标记 badge + 通知用户
  // 与 WS 重连策略的差异：WS 是被动 close→重连，HTTP 是主动周期探活
  let healthCheckTimer: ReturnType<typeof setInterval> | null = null
  const HEALTH_CHECK_INTERVAL = 30000
  const HTTP_PUSH_TIMEOUT = 8000
  let connectionFailureAlerted = false

  function rejectAllPending(reason: string): void {
    for (const [, pending] of pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    pendingRequests.clear()
  }

  function startHeartbeat(): void {
    stopHeartbeat()
    heartbeatTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      // 发 ping（桌面端回任意消息即视为 pong）
      try {
        ws.send(JSON.stringify({ action: 'ping', version: PROTOCOL_VERSION, token }))
        awaitingPong = true
        // 10s 无响应则主动 close，触发 onclose → 重连
        pongTimer = setTimeout(() => {
          if (awaitingPong && ws && ws.readyState === WebSocket.OPEN) {
            logger.warn('Heartbeat pong timeout, closing connection')
            ws.close()
          }
        }, PONG_TIMEOUT)
      } catch (e) {
        logger.error('Heartbeat ping failed:', (e as Error).message)
      }
    }, HEARTBEAT_INTERVAL)
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null }
    awaitingPong = false
  }

  /**
   * 对外连接入口（用户主动触发：启动、保存配对、popup 手动连接、点击下载）
   *
   * 每次主动触发都重置自动重连状态，让退避序列从头开始；
   * 内部定时重连走 connectWs()，不重置，用尽后自动停止。
   */
  function connect(): void {
    reconnectIndex = 0
    autoReconnectExhausted = false
    if (channel === 'ws') {
      connectWs()
    } else if (channel === 'http') {
      connectHttp()
    } else if (channel === 'deep-link') {
      connectDeepLink()
    } else {
      logger.info('Push channel is', channel, ', no connection established')
    }
  }

  /**
   * WS 通道建连（WS 先行，无前置 HTTP 探活）
   *
   * 说明：velo 推送服务是纯 WebSocket 服务（GET /health 不返回 HTTP 响应），
   * 因此不能用 HTTP 探活判定存活。桌面端未启动时浏览器会打印一条
   * `WebSocket connection ... net::ERR_CONNECTION_REFUSED`，这是浏览器网络层
   * 的原生日志，JS 无法捕获。为把这类「已知异常」压到最低，采用重连节流：
   * 退避档位（RECONNECT_DELAYS）用尽后停止自动重连，改由用户主动触发。
   */
  function connectWs(): void {
    if (disposed || ws) return
    openWs()
  }

  function openWs(): void {
    const url = `ws://127.0.0.1:${port}/ws`
    logger.debug('Connecting to', url)

    try {
      ws = new WebSocket(url, [SUB_PROTOCOL])
    } catch (e) {
      logger.warn('WebSocket creation failed:', (e as Error).message)
      handleConnectionFailure()
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      logger.info('WebSocket connected')
      connected = true
      everConnected = true
      reconnectIndex = 0
      autoReconnectExhausted = false
      connectionFailureAlerted = false
      clearBadge()
      clearDisconnectNotification()
      startHeartbeat()  // P2: 启动心跳
      // 上报扩展身份：桌面端据此把 pending 配对占位条目补全，供用户一键确认
      if (token) {
        try {
          ws?.send(JSON.stringify({
            version: PROTOCOL_VERSION,
            action: 'handshake',
            token,
            ...getExtensionIdentity(),
            options: { merge_format: '' },
          }))
        } catch (e) {
          logger.debug('握手消息发送失败:', (e as Error).message)
        }
      }
      void flushQueue()
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as {
          ok?: boolean; error?: string; detail?: string; action?: string; request_id?: number
        }
        if (awaitingPong) {
          awaitingPong = false
          if (pongTimer) { clearTimeout(pongTimer); pongTimer = null }
        }
        // request-response: 匹配 pending push 请求
        const rid = data.request_id
        if (rid != null && pendingRequests.has(rid)) {
          const pending = pendingRequests.get(rid)!
          pendingRequests.delete(rid)
          clearTimeout(pending.timer)
          if (data.error) {
            pending.reject(new Error(data.detail ?? data.error))
          } else {
            pending.resolve()
          }
          return
        }
        // 旧版桌面端不回 request_id：按 FIFO 匹配最早的 pending 请求
        if (data.error && pendingRequests.size > 0) {
          const firstEntry = pendingRequests.entries().next().value
          if (firstEntry) {
            const [firstId, firstPending] = firstEntry as [number, NonNullable<typeof pendingRequests extends Map<number, infer V> ? V : never>]
            pendingRequests.delete(firstId)
            clearTimeout(firstPending.timer)
            firstPending.reject(new Error(data.detail ?? data.error))
          }
          return
        }
        logger.debug('WS message:', data.action ?? (data.ok ? 'ok' : 'unknown'))
      } catch { /* ignore */ }
    }

    ws.onclose = () => {
      logger.info('WebSocket closed')
      connected = false
      ws = null
      stopHeartbeat()
      rejectAllPending('WebSocket closed')
      handleConnectionFailure()
      scheduleReconnect()
    }

    ws.onerror = (event) => {
      logger.debug('WebSocket error:', event.type)
      connected = false
    }
  }

  // ============================================================================
  // task #10: HTTP 推送通道实现
  // ============================================================================

  function connectHttp(): void {
    logger.info('HTTP push channel started, port:', port)
    // HTTP 通道无持久连接：启动即视为「准备就绪」
    // 周期性健康检查探活，决定 connected 状态
    if (healthCheckTimer) clearInterval(healthCheckTimer)
    healthCheckTimer = setInterval(() => { void healthCheck() }, HEALTH_CHECK_INTERVAL)
    // 启动时立即探活一次
    void healthCheck()
  }

  /**
   * HTTP 健康检查（task #10 重连策略）
   *
   * GET http://127.0.0.1:{port}/health
   *   - 2xx → connected=true + 清除 badge + flush 队列
   *   - 非 2xx 或网络错误 → connected=false + 标记 badge + 通知用户
   *
   * 与 WS 重连策略的差异：
   *   - WS 是被动 close→onclose→重连（依赖 TCP RST/FIN）
   *   - HTTP 是主动周期探活（无需 TCP keepalive，每 30s 主动 GET）
   *   - 失败时不递增 reconnectIndex，因为周期探活本身就是循环
   */
  async function healthCheck(): Promise<void> {
    const url = `http://127.0.0.1:${port}/health`
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), HTTP_PUSH_TIMEOUT)
      try {
        const res = await fetch(url, { method: 'GET', signal: controller.signal })
        if (res.ok) {
          if (!connected) {
            logger.info('HTTP health check OK, connected')
          }
          connected = true
          everConnected = true
          reconnectIndex = 0
          clearBadge()
          clearDisconnectNotification()
          connectionFailureAlerted = false
          void flushQueue()
        } else {
          markDisconnected(`HTTP ${res.status}`)
        }
      } finally {
        clearTimeout(timeout)
      }
    } catch (e) {
      markDisconnected((e as Error).message)
    }
  }

  function markDisconnected(reason: string): void {
    if (connected) {
      logger.info('Health check failed:', reason, '— marking disconnected')
    } else {
      logger.debug('Health check failed:', reason)
    }
    connected = false
    handleConnectionFailure()
  }

  /**
   * 连接失败统一反馈：badge + 桌面通知 + 一次性三步排查 alert
   *
   * 不再以 everConnected 作为前置条件：桌面端从未启动时（首次连接即失败）
   * 用户点下载后同样需要可见反馈，否则表现为「点了没反应」。
   */
  function handleConnectionFailure(): void {
    setBadgeError()
    notifyDisconnected()
    if (!connectionFailureAlerted) {
      connectionFailureAlerted = true
      notifyConnectionFailureWith3StepGuide()
    }
  }

  /**
   * task #10: HTTP 推送单条消息
   *
   * POST http://127.0.0.1:{port}/push
   *   Content-Type: application/json
   *   Body: JSON.stringify(PushMessage)
   *
   * 成功 → 直接返回
   * 失败 → 加入离线队列（与 WS 共用同一队列），下次健康检查 OK 时 flush
   */
  async function pushHttp(message: PushMessage): Promise<void> {
    const url = `http://127.0.0.1:${port}/push`
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), HTTP_PUSH_TIMEOUT)
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(message),
          signal: controller.signal,
        })
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          throw new Error(`HTTP ${res.status}: ${body}`)
        }
        logger.info('HTTP push sent:', message.action)
        // 推送成功 → 标记 connected（健康检查可能滞后）
        if (!connected) {
          connected = true
          everConnected = true
          reconnectIndex = 0
          clearBadge()
          clearDisconnectNotification()
          connectionFailureAlerted = false
        }
        return
      } finally {
        clearTimeout(timeout)
      }
    } catch (e) {
      logger.warn('HTTP push failed, queueing:', (e as Error).message, 'action:', message.action)
      markDisconnected((e as Error).message)
      // 入队（与 WS 共享同一队列）
      queue.push({ message, retries: 0, addedAt: Date.now() })
      if (queue.length > QUEUE_MAX_SIZE) {
        queue.splice(0, queue.length - QUEUE_MAX_SIZE)
      }
      await persistQueue()
    }
  }

  // ============================================================================
  // task #11: Deep Link 推送通道实现（Safari / macOS 专用）
  // ============================================================================

  /**
   * task #11: DeepLink 通道连接
   *
   * Safari / macOS 上：用 `velo://push?data={base64}` URL scheme 触发桌面端拉起
   *   - 无需持久连接
   *   - 每条消息通过 chrome.tabs.create 打开 velo:// URL
   *   - OS 路由到 velo 桌面端（已注册 URL scheme handler）
   *
   * 与 WS/HTTP 重连策略差异：
   *   - 无连接概念，无需探活
   *   - 推送失败（chrome.tabs.create 抛错）即视为不可用
   *   - badge 不标记错误（用户已通过 OS 看到是否成功）
   */
  function connectDeepLink(): void {
    logger.info('DeepLink push channel started (velo:// scheme)')
    connected = true
    everConnected = true
    clearBadge()
    clearDisconnectNotification()
    void flushQueue()
  }

  /**
   * task #11: 通过 velo:// URL scheme 发送推送
   *
   * 方案：chrome.tabs.create({ url: 'velo://push?data=...' })
   *   - 在 SW 中触发 OS 协议处理器
   *   - 浏览器会弹「打开 velo?」对话框（首次），用户允许后桌面端被拉起
   *   - 创建的 tab 是临时的，用户感知为「打开外部应用」
   *
   * 备选方案（Chrome MV3 SW 不可用，需要 content script）：
   *   - location.href = 'velo://push?...'
   *   - 隐藏 iframe.src = 'velo://push?...'
   *   - 这两种方式在 content script 中可用，需通过消息转发
   *   - 但 chrome.tabs.create 在 SW 中更直接，且 OS 路由逻辑一致
   *
   * @param message 推送消息
   */
  async function pushDeepLink(message: PushMessage): Promise<void> {
    try {
      const json = JSON.stringify(message)
      // base64 编码（兼容 Unicode）
      const b64Bytes = new TextEncoder().encode(json)
      let bin = ''
      for (const b of b64Bytes) bin += String.fromCharCode(b)
      const b64 = btoa(bin)
      const dlUrl = `velo://push?data=${encodeURIComponent(b64)}`

      // chrome.tabs.create 会触发 OS 协议处理器
      // active:false 避免抢焦点；后台创建 tab 让浏览器静默处理
      await chrome.tabs.create({ url: dlUrl, active: false })
      logger.info('DeepLink push sent (velo://):', message.action)
    } catch (e) {
      logger.warn('DeepLink push failed, queueing:', (e as Error).message, 'action:', message.action)
      // 入队（与 WS/HTTP 共享）
      queue.push({ message, retries: 0, addedAt: Date.now() })
      if (queue.length > QUEUE_MAX_SIZE) {
        queue.splice(0, queue.length - QUEUE_MAX_SIZE)
      }
      await persistQueue()
    }
  }

  function disconnect(): void {
    disposed = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    stopHeartbeat()
    if (healthCheckTimer) {
      clearInterval(healthCheckTimer)
      healthCheckTimer = null
    }
    if (ws) {
      ws.onclose = null
      ws.onerror = null
      ws.onmessage = null
      ws.close()
      ws = null
    }
    rejectAllPending('Disconnected')
    connected = false
    clearBadge()
    clearDisconnectNotification()
  }

  /**
   * 自动重连调度（指数退避 + 上限节流）
   *
   * 桌面端未启动是常规状态，不能无限重连——每次重连都会产生一条浏览器原生
   * WebSocket 失败日志。策略：走完 RECONNECT_DELAYS 全部档位（约 61s）后停止，
   * 仅保留 badge / 通知提示，等用户主动触发 connect() 再重新开始。
   */
  function scheduleReconnect(): void {
    if (disposed || reconnectTimer) return
    if (reconnectIndex >= RECONNECT_DELAYS.length) {
      if (!autoReconnectExhausted) {
        autoReconnectExhausted = true
        logger.info(
          'Auto reconnect exhausted after',
          RECONNECT_DELAYS.length,
          'attempts — waiting for user action',
        )
      }
      return
    }
    const delay = RECONNECT_DELAYS[reconnectIndex]!
    reconnectIndex += 1
    if (everConnected) {
      logger.info(`Reconnecting in ${delay}ms (attempt ${reconnectIndex})`)
    } else {
      logger.debug(`Reconnecting in ${delay}ms (attempt ${reconnectIndex})`)
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      // 内部重连不重置退避序列，用尽后由 scheduleReconnect 停止
      connectWs()
    }, delay)
  }

  async function push(message: Record<string, unknown>): Promise<void> {
    // P3-2: 确保 loadQueue 完成后再操作队列，避免 FIFO 顺序错乱
    // （loadQueue 是 fire-and-forget 预加载，push 可能在它完成前被调用）
    await ensureQueueLoaded()

    // ⚠️ 顺序关键：先展开 message，再写 token / version / action / options，
    // 避免调用方在 message 里遗留的 token:'' 覆盖 closure 中的真实 token。
    // 历史 bug：pushHls/pushUrl/pushNormal 在 msg 里写 token:''，
    // 旧实现 {...token, ...message} 把 token 覆盖为 ''，导致桌面端鉴权失败。
    const requestId = nextRequestId++
    const pushMsg = {
      ...message,
      request_id: requestId,
      version: PROTOCOL_VERSION,
      token,
      action: (message.action as PushMessage['action']) ?? 'push_normal',
      options: {
        merge_format: '',
        ...(message.options as Record<string, unknown>),
      },
    } as PushMessage

    // === task #10/#11: 按通道分发 ===
    if (channel === 'http') {
      await pushHttp(pushMsg)
      return
    }
    if (channel === 'deep-link') {
      await pushDeepLink(pushMsg)
      return
    }

    // WS 通道: request-response 模式
    if (connected && ws?.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(pushMsg))
        logger.info('Push sent:', pushMsg.action, 'request_id:', requestId)
        // 等待桌面端响应：成功 → resolve, 错误 → reject (触发 fallback), 超时 → resolve (兼容旧版)
        return await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId)
            logger.debug('Push response timeout (no error from server), assuming success:', pushMsg.action)
            resolve()
          }, PUSH_RESPONSE_TIMEOUT)
          pendingRequests.set(requestId, { resolve, reject, timer })
        })
      } catch (e) {
        logger.error('Push send failed:', (e as Error).message)
      }
    }

    // WS 通道：当前无连接时，用户主动推送（如点击下载）触发一次建连尝试
    // 这是「用户触发」路径，重置退避序列，避免自动重连停止后永久失联
    if (channel === 'ws' && !ws) {
      connect()
    }

    queue.push({ message: pushMsg, retries: 0, addedAt: Date.now() })
    if (queue.length > QUEUE_MAX_SIZE) {
      queue.splice(0, queue.length - QUEUE_MAX_SIZE)
    }
    await persistQueue()
    logger.info('Push queued (offline):', pushMsg.action)
  }

  async function flushQueue(): Promise<void> {
    if (queue.length === 0) return

    // === WS 通道：需要 ws 处于 OPEN 状态 ===
    if (channel === 'ws') {
      if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return
    }
    // === HTTP 通道：需要 connected=true（健康检查通过）===
    if (channel === 'http' && !connected) return
    // === DeepLink 通道：始终可推送 ===
    if (channel === 'deep-link' && !connected) {
      connected = true
    }

    const items = queue.splice(0, queue.length)
    for (const item of items) {
      try {
        if (channel === 'ws' && ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(item.message))
          logger.info('Flushed queued push:', item.message.action)
        } else if (channel === 'http') {
          await pushHttp(item.message)
        } else if (channel === 'deep-link') {
          await pushDeepLink(item.message)
        }
      } catch (e) {
        logger.error('Flush failed:', (e as Error).message)
        queue.push({ ...item, retries: item.retries + 1 })
      }
    }
    await persistQueue()
  }

  async function persistQueue(): Promise<void> {
    try {
      await persistentStorage.set(STORAGE_KEYS.queue, queue)
    } catch { /* ignore */ }
  }

  async function loadQueue(): Promise<void> {
    try {
      const saved = await persistentStorage.get<PushQueueItem[]>(STORAGE_KEYS.queue)
      if (saved) queue.unshift(...saved) // 旧项插到队首，保持 FIFO（新 push 的项在队尾）
    } catch { /* ignore */ }
  }

  // P3-2: 修复 loadQueue 竞态
  // 旧实现 void loadQueue() 是 fire-and-forget，若 push 在 loadQueue 完成前调用：
  //   1. push 往 queue 加新项 → persistQueue 覆盖 storage（只剩新项）
  //   2. loadQueue 完成 → queue.push(...saved) 把旧项追加到新项之后
  //   3. FIFO 顺序错乱（新项在旧项之前）
  // 修复：记录 loadQueuePromise，push 时 await 它再 persistQueue，确保旧项先入队
  let loadQueuePromise: Promise<void> | null = null
  function ensureQueueLoaded(): Promise<void> {
    if (!loadQueuePromise) loadQueuePromise = loadQueue()
    return loadQueuePromise
  }

  // 模块初始化时预加载队列（不阻塞，但 push 时会 await）
  void ensureQueueLoaded()

  return { connect, disconnect, push }
}