import { logger } from '@/lib/logger'
import { PROTOCOL_VERSION, SUB_PROTOCOL, RECONNECT_DELAYS, QUEUE_MAX_SIZE, STORAGE_KEYS } from '@/types'
import { persistentStorage } from '@/lib/storage'
import type { PushMessage } from '@/types'

interface PushQueueItem {
  message: PushMessage
  retries: number
  addedAt: number
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
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      logger.info('WebSocket connected')
      connected = true
      reconnectIndex = 0
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
      scheduleReconnect()
    }

    ws.onerror = (event) => {
      logger.error('WebSocket error:', event.type)
      connected = false
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
