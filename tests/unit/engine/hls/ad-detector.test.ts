import { describe, it, expect } from 'vitest'
import { detectAds, detectSequenceJumps, detectShortBlocks } from '@/engine/hls/ad-detector'
import { parsePlaylist } from '@/engine/hls/playlist-parser'
import { DEFAULT_CONFIG } from '@/engine/hls/hls-filter'
import type { AdFilterConfig, Segment } from '@/engine/hls/types'

function makeConfig(overrides: Partial<AdFilterConfig> = {}): AdFilterConfig {
  return { ...DEFAULT_CONFIG, ...overrides, _patterns: DEFAULT_CONFIG._patterns ?? [], _forceKeep: [] }
}

describe('detectAds', () => {
  it('detects CUE-OUT ad segments', () => {
    const text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttps://cdn.example.com/content1.ts\n#EXT-X-CUE-OUT\n#EXTINF:10,\nhttps://cdn.example.com/ad/1.ts\n#EXTINF:10,\nhttps://cdn.example.com/ad/2.ts\n#EXT-X-CUE-IN\n#EXTINF:10,\nhttps://cdn.example.com/content2.ts\n#EXT-X-ENDLIST'
    const parsed = parsePlaylist(text, 'https://cdn.example.com/')
    const result = detectAds(parsed, makeConfig())
    expect(result.adSegments.size).toBeGreaterThanOrEqual(2)
    expect(result.report.ads).toBeGreaterThanOrEqual(2)
  })

  it('detects URL pattern ad segments', () => {
    const text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttps://cdn.example.com/content1.ts\n#EXTINF:10,\nhttps://ads.example.com/preroll/1.ts\n#EXTINF:10,\nhttps://cdn.example.com/content2.ts\n#EXT-X-ENDLIST'
    const parsed = parsePlaylist(text, 'https://cdn.example.com/')
    const result = detectAds(parsed, makeConfig())
    expect(result.adSegments.has(1)).toBe(true)
  })

  it('returns empty for clean playlist', () => {
    const text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttps://cdn.example.com/seg1.ts\n#EXTINF:10,\nhttps://cdn.example.com/seg2.ts\n#EXT-X-ENDLIST'
    const parsed = parsePlaylist(text, 'https://cdn.example.com/')
    const result = detectAds(parsed, makeConfig())
    expect(result.adSegments.size).toBe(0)
    expect(result.report.ads).toBe(0)
  })
})

describe('detectSequenceJumps', () => {
  it('returns empty for segments without seqNums', () => {
    const segments: Segment[] = [
      { index: 0, url: 'https://cdn.example.com/abc.ts', duration: 10, title: '', byterange: null, discontinuity: false, cueState: null, scte35: null, dateRangeAd: null, seqNum: null },
    ]
    expect(detectSequenceJumps(segments).size).toBe(0)
  })
})

describe('detectShortBlocks', () => {
  it('returns empty for short segment lists', () => {
    const segments: Segment[] = Array.from({ length: 3 }, (_, i) => ({
      index: i, url: `https://cdn.example.com/seg${i}.ts`, duration: 10, title: '', byterange: null, discontinuity: false, cueState: null, scte35: null, dateRangeAd: null, seqNum: i,
    }))
    expect(detectShortBlocks(segments).size).toBe(0)
  })
})
