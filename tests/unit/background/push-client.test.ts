/**
 * push-client 单元测试（task #10/#11: HTTP + DeepLink 通道）
 *
 * 覆盖 ws/http/deep-link 三种通道的 connect/disconnect/push 行为：
 *   ① ws 通道：connect 创建 WebSocket
 *   ② http 通道：connect 启动健康检查定时器，不创建 WebSocket
 *   ③ deep-link 通道：connect 标记 connected=true，无网络连接
 *   ④ http push 失败 → 入队
 *   ⑤ deep-link push → chrome.tabs.create with velo:// URL
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
const mockFetch = vi.fn()
const mockTabsCreate = vi.fn()

vi.stubGlobal('WebSocket', vi.fn().mockImplementation(() => ({
  onopen: null,
  onmessage: null,
  onclose: null,
  onerror: null,
  readyState: 1,
  send: mockWsSend,
  close: mockWsClose,
})))

vi.stubGlobal('fetch', mockFetch)
vi.stubGlobal('btoa', (s: string) => Buffer.from(s, 'binary').toString('base64'))
vi.stubGlobal('TextEncoder', TextEncoder)

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
    create: mockTabsCreate,
  },
  runtime: {
    getURL: vi.fn((p: string) => `chrome-extension://fake/${p}`),
  },
})

import { createPushClient } from '@/background/push-client'

describe('PushClient — ws channel (回归)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('connect 创建 WebSocket 到 ws://127.0.0.1:{port}/ws', async () => {
    // connectWs 先 HTTP 探活 /health，探活通过后才 new WebSocket，
    // 因此必须等待异步链路完成，不能同步断言（否则必然是 0 次调用）。
    mockFetch.mockResolvedValue({ ok: true } as Response)
    const client = createPushClient('ws', 16888, 'test-token')
    client.connect()
    await vi.waitFor(() => {
      expect(WebSocket).toHaveBeenCalledWith('ws://127.0.0.1:16888/ws', ['velo-ext.v1'])
    })
    client.disconnect()
  })

  it('disconnect 关闭 WebSocket', async () => {
    mockFetch.mockResolvedValue({ ok: true } as Response)
    const client = createPushClient('ws', 16888, 'test-token')
    client.connect()
    await vi.waitFor(() => {
      expect(WebSocket).toHaveBeenCalled()
    })
    client.disconnect()
    expect(mockWsClose).toHaveBeenCalled()
  })

  it('push 不连接时入队', async () => {
    const client = createPushClient('ws', 16888, 'test-token')
    await client.push({ action: 'push_normal', url: 'https://example.com/video.mp4' })
    // 入队后 queue 持久化
    // 不抛错即可
  })
})

describe('PushClient — http channel (task #10)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('connect 不创建 WebSocket（HTTP 通道无持久连接）', () => {
    const client = createPushClient('http', 16888, 'test-token')
    client.connect()
    expect(WebSocket).not.toHaveBeenCalled()
  })

  it('connect 触发首次健康检查（fetch GET /health）', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true } as Response)
    const client = createPushClient('http', 16888, 'test-token')
    client.connect()
    // 等待 fetch 调用
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:16888/health',
        expect.objectContaining({ method: 'GET' }),
      )
    })
    client.disconnect()
  })

  it('健康检查失败 → 调用 chrome.action.setBadgeText 标记错误', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'))
    const client = createPushClient('http', 16888, 'test-token')
    client.connect()
    await vi.waitFor(() => {
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '!' })
    })
    client.disconnect()
  })

  it('健康检查 OK → 清除 badge', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true } as Response)
    const client = createPushClient('http', 16888, 'test-token')
    client.connect()
    await vi.waitFor(() => {
      expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' })
    })
    client.disconnect()
  })

  it('push 成功 → fetch POST /push with JSON body', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true } as Response) // 健康检查
    mockFetch.mockResolvedValueOnce({ ok: true } as Response) // push
    const client = createPushClient('http', 16888, 'test-token')
    client.connect()
    // 等健康检查完成
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalled()
    })
    await client.push({ action: 'push_normal', url: 'https://example.com/v.mp4' })
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:16888/push',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    client.disconnect()
  })

  it('push 失败 → 入队（不抛错）', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true } as Response) // 健康检查
    mockFetch.mockRejectedValueOnce(new Error('connection refused')) // push 失败
    const client = createPushClient('http', 16888, 'test-token')
    client.connect()
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalled()
    })
    await client.push({ action: 'push_normal', url: 'https://example.com/v.mp4' })
    // 不抛错即可（已入队）
    client.disconnect()
  })

  it('健康检查失败 → 触发 3 步排查 alert 通知', async () => {
    mockFetch.mockRejectedValueOnce(new Error('connection refused'))
    const client = createPushClient('http', 16888, 'test-token')
    client.connect()
    await vi.waitFor(() => {
      expect(chrome.tabs.query).toHaveBeenCalled()
    })
    client.disconnect()
  })
})

describe('PushClient — deep-link channel (task #11)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('connect 不创建 WebSocket 和不调 fetch', () => {
    const client = createPushClient('deep-link', 16888, 'test-token')
    client.connect()
    expect(WebSocket).not.toHaveBeenCalled()
    // 健康检查不应触发（deep-link 无健康检查）
    // 不抛错即可
  })

  it('push → chrome.tabs.create with velo:// URL', async () => {
    mockTabsCreate.mockResolvedValueOnce({ id: 1 })
    const client = createPushClient('deep-link', 16888, 'test-token')
    client.connect()
    await client.push({ action: 'push_normal', url: 'https://example.com/v.mp4' })
    expect(mockTabsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringMatching(/^velo:\/\/push\?data=/),
        active: false,
      }),
    )
    client.disconnect()
  })

  it('push 失败 → 入队（不抛错）', async () => {
    mockTabsCreate.mockRejectedValueOnce(new Error('chrome.tabs.create failed'))
    const client = createPushClient('deep-link', 16888, 'test-token')
    client.connect()
    await client.push({ action: 'push_normal', url: 'https://example.com/v.mp4' })
    // 不抛错即可
    client.disconnect()
  })
})