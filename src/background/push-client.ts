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

/**
 * push() 的返回值。
 *
 * `queued=true` 表示当前没有可用连接，消息已进入持久化离线队列，
 * 连接恢复后由 flushQueue 自动补发——调用方必须把这一状态如实告知用户，
 * 不能当作「已送达」上报成功。
 *
 * `pending=true` 表示桌面端已收到但处于 confirm / edit_only 模式，
 * 任务尚未创建，需用户在 velo 界面确认后才会开始下载——同样不能上报「已开始下载」。
 */
export interface PushResult {
  queued: boolean
  pending?: boolean
}

/**
 * 消息已发出但未收到桌面端确认（响应超时 / 发送后连接中断）。
 *
 * 与「发送失败」严格区分：此时桌面端可能已经创建了任务，调用方**不得**回退到
 * 其它客户端重发，否则会出现重复下载。调用方应提示用户先检查 velo 任务列表。
 */
export class PushUnconfirmedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PushUnconfirmedError'
  }
}

export function createPushClient(port: number, token: string) {
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
    resolve: (result: PushResult) => void
    reject: (reason: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  const PUSH_RESPONSE_TIMEOUT = 15000
  let connectionFailureAlerted = false

  function rejectAllPending(reason: string): void {
    for (const [, pending] of pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new PushUnconfirmedError(reason))
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
    connectWs()
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
          ok?: boolean; error?: string; detail?: string; action?: string; request_id?: number; pending?: boolean
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
          } else if (data.pending) {
            // confirm / edit_only 模式：桌面端已收到，但任务要等用户在 velo 里确认
            pending.resolve({ queued: false, pending: true })
          } else {
            pending.resolve({ queued: false })
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

  function disconnect(): void {
    disposed = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    stopHeartbeat()
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

  async function push(message: Record<string, unknown>): Promise<PushResult> {
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

    // WS 通道: request-response 模式
    if (connected && ws?.readyState === WebSocket.OPEN) {
      let sent = false
      try {
        ws.send(JSON.stringify(pushMsg))
        sent = true
        logger.info('Push sent:', pushMsg.action, 'request_id:', requestId)
      } catch (e) {
        logger.error('Push send failed:', (e as Error).message)
      }
      // ⚠️ 等待回执必须放在 try 之外：超时的 reject 若被 catch 吞掉，
      // 就会落入下面的离线队列分支返回 queued=true，导致「未确认」被伪装成「已入队」。
      if (sent) {
        // 等待桌面端回执：成功 → resolve；错误 → reject（触发回退）；
        // 超时 → reject(PushUnconfirmedError)。桌面端已回显 request_id，
        // 超时意味着「已发出但未确认」，不能当作成功（否则 UI 假成功）。
        return await new Promise<PushResult>((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId)
            logger.warn('Push response timeout:', pushMsg.action, 'request_id:', requestId)
            reject(new PushUnconfirmedError(i18n('push_unconfirmed')))
          }, PUSH_RESPONSE_TIMEOUT)
          pendingRequests.set(requestId, { resolve, reject, timer })
        })
      }
    }

    // WS 通道：当前无连接时，用户主动推送（如点击下载）触发一次建连尝试
    // 这是「用户触发」路径，重置退避序列，避免自动重连停止后永久失联
    if (!ws) {
      connect()
    }

    queue.push({ message: pushMsg, retries: 0, addedAt: Date.now() })
    if (queue.length > QUEUE_MAX_SIZE) {
      queue.splice(0, queue.length - QUEUE_MAX_SIZE)
    }
    await persistQueue()
    logger.info('Push queued (offline):', pushMsg.action)
    return { queued: true }
  }

  async function flushQueue(): Promise<void> {
    if (queue.length === 0) return

    // 需要 ws 处于 OPEN 状态才可冲刷
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return

    const items = queue.splice(0, queue.length)
    for (const item of items) {
      try {
        ws.send(JSON.stringify(item.message))
        logger.info('Flushed queued push:', item.message.action)
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