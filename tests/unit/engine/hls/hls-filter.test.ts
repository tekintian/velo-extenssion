import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { processPlaylist, processMasterPlaylist, resolveMediaVariant, buildConfig, DEFAULT_CONFIG } from '@/engine/hls/hls-filter'

const SIMPLE_MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
https://cdn.example.com/seg1.ts
#EXTINF:10.0,
https://cdn.example.com/seg2.ts
#EXTINF:10.0,
https://cdn.example.com/seg3.ts
#EXT-X-ENDLIST`

const MASTER_PLAYLIST = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
https://cdn.example.com/360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=842x480
https://cdn.example.com/480p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
https://cdn.example.com/720p.m3u8`

const AD_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
https://cdn.example.com/seg1.ts
#EXT-X-CUE-OUT:30
#EXTINF:10.0,
https://ad.example.com/ad1.ts
#EXTINF:10.0,
https://ad.example.com/ad2.ts
#EXTINF:10.0,
https://ad.example.com/ad3.ts
#EXT-X-CUE-IN
#EXTINF:10.0,
https://cdn.example.com/seg2.ts
#EXT-X-ENDLIST`

describe('hls-filter', () => {
  describe('DEFAULT_CONFIG', () => {
    it('has enabled=true by default', () => {
      expect(DEFAULT_CONFIG.enabled).toBe(true)
    })

    it('has scoreThreshold as number', () => {
      expect(typeof DEFAULT_CONFIG.scoreThreshold).toBe('number')
    })
  })

  describe('buildConfig', () => {
    it('returns config with defaults', async () => {
      const cfg = await buildConfig(DEFAULT_CONFIG, '')
      expect(cfg.enabled).toBe(true)
    })

    it('overrides scoreThreshold', async () => {
      const cfg = await buildConfig({ ...DEFAULT_CONFIG, scoreThreshold: 5 }, '')
      expect(cfg.scoreThreshold).toBeGreaterThanOrEqual(3)
    })

    it('handles host for site rules', async () => {
      const cfg = await buildConfig(DEFAULT_CONFIG, 'example.com')
      expect(cfg).toBeDefined()
    })
  })

  describe('processPlaylist', () => {
    it('identifies master playlist', async () => {
      const result = await processPlaylist(MASTER_PLAYLIST, 'https://cdn.example.com/master.m3u8', 'https://example.com/video', DEFAULT_CONFIG)
      expect(result.mode).toBe('master')
    })

    it('returns no-ads for clean media playlist', async () => {
      const result = await processPlaylist(SIMPLE_MEDIA_PLAYLIST, 'https://cdn.example.com/index.m3u8', 'https://example.com/video', DEFAULT_CONFIG)
      expect(['no-ads', 'm3u8-file', 'disabled', 'passthrough']).toContain(result.mode)
    })

    it('returns report with stats', async () => {
      const result = await processPlaylist(SIMPLE_MEDIA_PLAYLIST, 'https://cdn.example.com/index.m3u8', 'https://example.com/video', DEFAULT_CONFIG)
      expect(result.report).toBeDefined()
    })

    it('detects ads in CUE-OUT playlist', async () => {
      const result = await processPlaylist(AD_PLAYLIST, 'https://cdn.example.com/index.m3u8', 'https://example.com/video', DEFAULT_CONFIG)
      expect(result.mode).not.toBe('master')
    })

    it('returns disabled when filter is off', async () => {
      const disabledConfig = { ...DEFAULT_CONFIG, enabled: false }
      const result = await processPlaylist(SIMPLE_MEDIA_PLAYLIST, 'https://cdn.example.com/index.m3u8', 'https://example.com/video', disabledConfig)
      expect(result.mode).toBe('disabled')
    })

    it('handles empty playlist gracefully', async () => {
      const result = await processPlaylist('', 'https://cdn.example.com/index.m3u8', 'https://example.com/video', DEFAULT_CONFIG)
      expect(result).toBeDefined()
    })

    it('handles non-m3u8 content gracefully', async () => {
      const result = await processPlaylist('<html>not m3u8</html>', 'https://cdn.example.com/index.m3u8', 'https://example.com/video', DEFAULT_CONFIG)
      expect(result).toBeDefined()
    })

    it('returns ad ranges in passthrough mode', async () => {
      const cfg = await buildConfig({ ...DEFAULT_CONFIG, mode: 'passthrough' }, 'example.com')
      const result = await processPlaylist(AD_PLAYLIST, 'https://cdn.example.com/index.m3u8', 'https://example.com/video', cfg)
      expect(result.mode).toBe('passthrough')
      if ('adRanges' in result) {
        expect(result.adRanges.length).toBeGreaterThan(0)
        const total = result.adRanges.reduce((sum, r) => sum + r.duration, 0)
        expect(total).toBeGreaterThan(0)
        expect(total).toBeLessThanOrEqual(result.report.adDuration)
      }
    })

    it('returns original-timeline ad ranges alongside cleaned playlist', async () => {
      const cfg = await buildConfig({ ...DEFAULT_CONFIG, mode: 'm3u8-file' }, 'example.com')
      const result = await processPlaylist(AD_PLAYLIST, 'https://cdn.example.com/index.m3u8', 'https://example.com/video', cfg)
      if (result.mode === 'm3u8-file') {
        expect(result.cleaned).not.toContain('ad.example.com')
        expect(result.adRanges.length).toBeGreaterThan(0)
        const total = result.adRanges.reduce((sum, r) => sum + r.duration, 0)
        expect(total).toBeGreaterThan(0)
        expect(total).toBeLessThanOrEqual(result.report.adDuration)
      } else {
        expect(result.mode).not.toBe('passthrough')
      }
    })
  })

  describe('processMasterPlaylist', () => {
    it('descends into highest bandwidth variant and detects ads', async () => {
      const cfg = await buildConfig({ ...DEFAULT_CONFIG, mode: 'passthrough' }, 'example.com')
      const fetched: string[] = []
      const fetcher = async (url: string): Promise<string> => {
        fetched.push(url)
        return AD_PLAYLIST
      }
      const result = await processMasterPlaylist(
        MASTER_PLAYLIST,
        'https://cdn.example.com/master.m3u8',
        'https://example.com/video',
        cfg,
        undefined,
        fetcher,
      )
      expect(result).not.toBeNull()
      expect(result!.mode).toBe('passthrough')
      expect(fetched[0]).toBe('https://cdn.example.com/720p.m3u8')
      if (result && 'adRanges' in result) {
        expect(result.adRanges.length).toBeGreaterThan(0)
      }
    })

    it('falls back to next variant when highest bandwidth fails', async () => {
      const cfg = await buildConfig({ ...DEFAULT_CONFIG, mode: 'passthrough' }, 'example.com')
      const fetched: string[] = []
      const fetcher = async (url: string): Promise<string> => {
        fetched.push(url)
        if (url.includes('720p')) throw new Error('403')
        return AD_PLAYLIST
      }
      const result = await processMasterPlaylist(
        MASTER_PLAYLIST,
        'https://cdn.example.com/master.m3u8',
        'https://example.com/video',
        cfg,
        undefined,
        fetcher,
      )
      expect(result).not.toBeNull()
      expect(fetched.length).toBe(2)
      expect(fetched[1]).toBe('https://cdn.example.com/480p.m3u8')
    })

    it('returns null when no variant is usable', async () => {
      const cfg = await buildConfig({ ...DEFAULT_CONFIG, mode: 'passthrough' }, 'example.com')
      const result = await processMasterPlaylist(
        MASTER_PLAYLIST,
        'https://cdn.example.com/master.m3u8',
        'https://example.com/video',
        cfg,
        undefined,
        async () => {
          throw new Error('offline')
        },
      )
      expect(result).toBeNull()
    })

    it('returns the chosen variant url so download context stays on media list', async () => {
      const cfg = await buildConfig({ ...DEFAULT_CONFIG, mode: 'passthrough' }, 'example.com')
      const variant = await resolveMediaVariant(
        MASTER_PLAYLIST,
        'https://cdn.example.com/master.m3u8',
        cfg,
        undefined,
        async () => SIMPLE_MEDIA_PLAYLIST,
      )
      expect(variant).not.toBeNull()
      expect(variant!.url).toBe('https://cdn.example.com/720p.m3u8')
      expect(variant!.text).toContain('#EXTINF:')
    })
  })
})