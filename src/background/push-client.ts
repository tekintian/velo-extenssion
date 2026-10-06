import { logger } from '@/lib/logger'
import { PROTOCOL_VERSION, SUB_PROTOCOL, RECONNECT_DELAYS, QUEUE_MAX_SIZE, STORAGE_KEYS } from '@/types'
import { persistentStorage } from '@/lib/storage'
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
 * T9.1: 用 chrome.notifications 显示桌面通知（toast）告知用户「sdown 未运行」。
 * 仅在「断开 → 已通知」状态切换时触发一次，避免重连风暴刷屏。
 */
let disconnectNotified = false

function notifyDisconnected(): void {
  if (disconnectNotified) return
  disconnectNotified = true
  try {
    const title = chrome.i18n.getMessage('notify_disconnected_title') || 'sdown 未运行'
    const message = chrome.i18n.getMessage('notify_disconnected_body') || '请先启动 sdown 桌面端，扩展将自动重连'
    void chrome.notifications.create('sdown-disconnected', {
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
    void chrome.notifications.clear('sdown-disconnected')
  } catch (e) {
    logger.debug('clearDisconnectNotification 失败:', (e as Error).message)
  }
}

export function createPushClient(channel: 'ws' | 'http' | 'deep-link', port: number, token: string) {
  let ws: WebSocket | null = null
  let connected = false
  let reconnectIndex = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  const queue: PushQueueItem[] = []

  function connect(): void {
    if (channel !== 'ws') {
      logger.info('Push channel is', channel, ', WebSocket not used')
      return
    }

    const url = `ws://127.0.0.1:${port}/ws`
    logger.info('Connecting to', url)

    try {
      ws = new WebSocket(url, [SUB_PROTOCOL])
    } catch (e) {
      logger.error('WebSocket creation failed:', (e as Error).message)
      setBadgeError()
      notifyDisconnected()
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      logger.info('WebSocket connected')
      connected = true
      reconnectIndex = 0
      clearBadge()
      clearDisconnectNotification()
      void flushQueue()
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as { ok?: boolean; error?: string; action?: string }
        logger.debug('WS message:', data.action ?? 'unknown')
      } catch { /* ignore */ }
    }

    ws.onclose = () => {
      logger.info('WebSocket closed')
      connected = false
      ws = null
      // T9.1: 标记 badge + 通知用户（仅在断开→通知一次）
      setBadgeError()
      notifyDisconnected()
      scheduleReconnect()
    }

    ws.onerror = (event) => {
      logger.error('WebSocket error:', event.type)
      connected = false
      // onclose 会随后触发并清理状态，这里不重复通知
    }
  }

  function disconnect(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (ws) {
      ws.onclose = null
      ws.onerror = null
      ws.onmessage = null
      ws.close()
      ws = null
    }
    connected = false
    // 主动断开（如清除配对）不应保留 badge
    clearBadge()
    clearDisconnectNotification()
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) return
    const delay = RECONNECT_DELAYS[reconnectIndex] ?? RECONNECT_DELAYS[RECONNECT_DELAYS.length - 1]!
    reconnectIndex = Math.min(reconnectIndex + 1, RECONNECT_DELAYS.length - 1)
    logger.info(`Reconnecting in ${delay}ms (attempt ${reconnectIndex})`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  async function push(message: Record<string, unknown>): Promise<void> {
    const pushMsg: PushMessage = {
      version: PROTOCOL_VERSION,
      token,
      action: (message.action as PushMessage['action']) ?? 'push_normal',
      ...message,
      options: {
        merge_format: 'ts',
        ...(message.options as Record<string, unknown>),
      },
    }

    if (connected && ws?.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(pushMsg))
        logger.info('Push sent:', pushMsg.action)
        return
      } catch (e) {
        logger.error('Push send failed:', (e as Error).message)
      }
    }

    queue.push({ message: pushMsg, retries: 0, addedAt: Date.now() })
    if (queue.length > QUEUE_MAX_SIZE) {
      queue.splice(0, queue.length - QUEUE_MAX_SIZE)
    }
    await persistQueue()
    logger.info('Push queued (offline):', pushMsg.action)
  }

  async function flushQueue(): Promise<void> {
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) return
    if (queue.length === 0) return

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
      if (saved) queue.push(...saved)
    } catch { /* ignore */ }
  }

  void loadQueue()

  return { connect, disconnect, push }
}
