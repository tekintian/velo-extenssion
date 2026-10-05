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

const mockWsSend = vi.fn()
const mockWsClose = vi.fn()

vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => ({
  onopen: null,
  onmessage: null,
  onclose: null,
  onerror: null,
  readyState: 1,
  send: mockWsSend,
  close: mockWsClose,
})))

import { createPushClient } from '@/background/push-client'

describe('PushClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates WebSocket on connect for ws channel', () => {
    const client = createPushClient('ws', 16888, 'test-token')
    client.connect()
    expect(WebSocket).toHaveBeenCalledWith('ws://127.0.0.1:16888/ws', ['sdown-ext.v1'])
  })

  it('does not create WebSocket for http channel', () => {
    const client = createPushClient('http', 16888, 'test-token')
    client.connect()
    expect(WebSocket).not.toHaveBeenCalled()
  })

  it('disconnect closes WebSocket', () => {
    const client = createPushClient('ws', 16888, 'test-token')
    client.connect()
    client.disconnect()
  })

  it('push queues message when not connected', async () => {
    const client = createPushClient('http', 16888, 'test-token')
    await client.push({ action: 'push_normal', url: 'https://example.com/video.mp4' })
  })
})
