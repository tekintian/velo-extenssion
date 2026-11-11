/**
 * push-client 单元测试（WS 通道）
 *
 * 扩展端推送通道已收敛为单一 WS 通道（velo-ext.v1），
 * HTTP / deep-link 两条半成品通道已删除，此处仅覆盖 WS 行为：
 *   ① connect 创建 WebSocket 并携带子协议
 *   ② disconnect 关闭 WebSocket
 *   ③ 未连接时 push 入队（离线队列）
 *   ④ 连接成功后 push 直接发送并等待 request_id 回执
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/storage', () => ({
  persistentStorage: {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/background/pairing', () => ({
  getExtensionIdentity: vi.fn(() => ({
    extension_id: 'test-ext',
    device_name: 'test-device',
  })),
}))

const mockWsSend = vi.fn()
const mockWsClose = vi.fn()

interface FakeWs {
  onopen: (() => void) | null
  onmessage: ((e: { data: string }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  readyState: number
  send: typeof mockWsSend
  close: typeof mockWsClose
}

let lastWs: FakeWs | null = null

const WebSocketMock = vi.fn().mockImplementation(() => {
  const inst: FakeWs = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    readyState: 1,
    send: mockWsSend,
    close: mockWsClose,
  }
  lastWs = inst
  return inst
})
Object.assign(WebSocketMock, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })

vi.stubGlobal('WebSocket', WebSocketMock)

vi.stubGlobal('chrome', {
  action: {
    setBadgeBackgroundColor: vi.fn(),
    setBadgeText: vi.fn(),
  },
  notifications: {
    create: vi.fn(),
    clear: vi.fn(),
  },
  i18n: {
    getMessage: vi.fn((key: string) => key),
  },
  tabs: {
    query: vi.fn().mockImplementation((_, cb) => cb([])),
    sendMessage: vi.fn(),
  },
  runtime: {
    getURL: vi.fn((p: string) => `chrome-extension://fake/${p}`),
  },
})

import { createPushClient, PushUnconfirmedError } from '@/background/push-client'

const flushMicro = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** 过滤掉 onopen 阶段的握手消息，只返回业务推送消息 */
const pushSends = (): { action: string; request_id: number }[] =>
  mockWsSend.mock.calls
    .map((c) => JSON.parse(c[0] as string) as { action: string; request_id: number })
    .filter((m) => m.action !== 'handshake')

describe('PushClient — ws channel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lastWs = null
  })

  it('connect 创建 WebSocket 到 ws://127.0.0.1:{port}/ws 并带子协议', () => {
    const client = createPushClient(16888, 'test-token')
    client.connect()
    expect(WebSocket).toHaveBeenCalledWith('ws://127.0.0.1:16888/ws', ['velo-ext.v1'])
    client.disconnect()
  })

  it('disconnect 关闭 WebSocket', () => {
    const client = createPushClient(16888, 'test-token')
    client.connect()
    client.disconnect()
    expect(mockWsClose).toHaveBeenCalled()
  })

  it('未连接时 push 入队并返回 queued=true（不抛错）', async () => {
    const client = createPushClient(16888, 'test-token')
    const r = await client.push({ action: 'push_normal', url: 'https://example.com/video.mp4' })
    expect(r.queued).toBe(true)
    expect(mockWsSend).not.toHaveBeenCalled()
    client.disconnect()
  })

  it('连接后 push 立即发送，收到 request_id 回执返回 queued=false', async () => {
    const client = createPushClient(16888, 'test-token')
    client.connect()
    lastWs?.onopen?.()
    const p = client.push({ action: 'push_normal', url: 'https://example.com/video.mp4' })
    await flushMicro()
    const sends = pushSends()
    expect(sends).toHaveLength(1)
    lastWs?.onmessage?.({ data: JSON.stringify({ ok: true, request_id: sends[0]!.request_id }) })
    await expect(p).resolves.toEqual({ queued: false })
    client.disconnect()
  })

  it('已发送但回执超时 → reject PushUnconfirmedError（不再静默当作成功）', async () => {
    vi.useFakeTimers()
    const client = createPushClient(16888, 'test-token')
    client.connect()
    lastWs?.onopen?.()
    const p = client.push({ action: 'push_normal', url: 'https://example.com/video.mp4' })
    p.catch(() => { /* 避免未处理拒绝告警 */ })
    await flushMicro()
    expect(pushSends()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(20000)
    await expect(p).rejects.toBeInstanceOf(PushUnconfirmedError)
    vi.useRealTimers()
    client.disconnect()
  })
})