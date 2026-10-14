/**
 * buildVeloHeaders 单元测试
 *
 * 覆盖认证头构建的 5 个核心场景：
 *   ① 仅 pageUrl → Origin + Referer
 *   ② 仅 cookies → Cookie
 *   ③ 仅 requestHeaders → 逐项展开
 *   ④ 全有 → 合并
 *   ⑤ 全无 → undefined
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/storage', () => ({
  persistentStorage: {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  },
  settingsStore: {
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

import { buildVeloHeaders } from '@/background/media/download-client'

describe('buildVeloHeaders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('① 仅 pageUrl → 提取 Origin + Referer', () => {
    const headers = buildVeloHeaders({ pageUrl: 'https://www.example.com/watch/123' })
    expect(headers).toBeDefined()
    expect(headers!['Origin']).toBe('https://www.example.com')
    expect(headers!['Referer']).toBe('https://www.example.com/watch/123')
  })

  it('① pageUrl 含 hash → Referer 去掉 hash', () => {
    const headers = buildVeloHeaders({ pageUrl: 'https://example.com/path#fragment' })
    expect(headers!['Referer']).toBe('https://example.com/path')
  })

  it('① pageUrl 含 query + hash → Referer 保留 query 去 hash', () => {
    const headers = buildVeloHeaders({ pageUrl: 'https://example.com/path?id=1#frag' })
    expect(headers!['Referer']).toBe('https://example.com/path?id=1')
  })

  it('② 仅 cookies → Cookie', () => {
    const headers = buildVeloHeaders({ cookies: 'session=abc123; token=xyz' })
    expect(headers).toBeDefined()
    expect(headers!['Cookie']).toBe('session=abc123; token=xyz')
    expect(headers!['Origin']).toBeUndefined()
  })

  it('③ 仅 requestHeaders → 逐项展开', () => {
    const headers = buildVeloHeaders({
      requestHeaders: {
        'User-Agent': 'Mozilla/5.0',
        'Authorization': 'Bearer eyJhbG...',
        'x-csrf-token': 'abc123',
      },
    })
    expect(headers).toBeDefined()
    expect(headers!['User-Agent']).toBe('Mozilla/5.0')
    expect(headers!['Authorization']).toBe('Bearer eyJhbG...')
    expect(headers!['x-csrf-token']).toBe('abc123')
  })

  it('④ 全有 → 合并所有头', () => {
    const headers = buildVeloHeaders({
      pageUrl: 'https://example.com/watch',
      cookies: 'session=abc',
      requestHeaders: { 'User-Agent': 'TestUA', 'Authorization': 'Bearer xyz' },
    })
    expect(headers).toBeDefined()
    expect(Object.keys(headers!)).toHaveLength(5)
    expect(headers!['Origin']).toBe('https://example.com')
    expect(headers!['Referer']).toBe('https://example.com/watch')
    expect(headers!['Cookie']).toBe('session=abc')
    expect(headers!['User-Agent']).toBe('TestUA')
    expect(headers!['Authorization']).toBe('Bearer xyz')
  })

  it('⑤ 全无 → undefined', () => {
    const headers = buildVeloHeaders()
    expect(headers).toBeUndefined()
  })

  it('⑤ 空 extra → undefined', () => {
    const headers = buildVeloHeaders({})
    expect(headers).toBeUndefined()
  })

  it('非法 pageUrl → 不抛错，跳过 Origin/Referer', () => {
    const headers = buildVeloHeaders({ pageUrl: 'not-a-url', cookies: 'a=b' })
    expect(headers).toBeDefined()
    expect(headers!['Cookie']).toBe('a=b')
    expect(headers!['Origin']).toBeUndefined()
  })
})
