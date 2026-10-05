import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

const mockAddListener = vi.fn()
const mockGetAll = vi.fn().mockResolvedValue([])

vi.stubGlobal('chrome', {
  webRequest: {
    onHeadersReceived: { addListener: mockAddListener },
    onBeforeSendHeaders: { addListener: mockAddListener },
  },
  cookies: { getAll: mockGetAll },
})

import { isM3u8, getCookieString } from '@/background/media/sniffer'

describe('sniffer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('isM3u8', () => {
    it('returns true for .m3u8 extension', () => {
      expect(isM3u8({ ext: '.m3u8' })).toBe(true)
    })

    it('returns true for .m3u extension', () => {
      expect(isM3u8({ ext: '.m3u' })).toBe(true)
    })

    it('returns true for mpegurl mime type', () => {
      expect(isM3u8({ ext: '.ts', mime: 'application/vnd.apple.mpegurl' })).toBe(true)
    })

    it('returns false for non-m3u8', () => {
      expect(isM3u8({ ext: '.mp4', mime: 'video/mp4' })).toBe(false)
    })

    it('returns false for non-m3u8 without mime', () => {
      expect(isM3u8({ ext: '.mp4' })).toBe(false)
    })
  })

  describe('getCookieString', () => {
    it('returns empty string when no cookies', async () => {
      mockGetAll.mockResolvedValueOnce([])
      const result = await getCookieString('https://example.com')
      expect(result).toBe('')
    })

    it('returns formatted cookie string', async () => {
      mockGetAll.mockResolvedValueOnce([
        { name: 'session', value: 'abc123' },
        { name: 'user', value: 'test' },
      ])
      const result = await getCookieString('https://example.com')
      expect(result).toBe('session=abc123; user=test')
    })

    it('returns empty string on error', async () => {
      mockGetAll.mockRejectedValueOnce(new Error('fail'))
      const result = await getCookieString('https://example.com')
      expect(result).toBe('')
    })
  })
})
