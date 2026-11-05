import { describe, it, expect } from 'vitest'
import { detectAds, detectMinorityPathBlocks, detectSequenceJumps, detectShortBlocks } from '@/engine/hls/ad-detector'
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

  it('detects short blocks sandwiched between long blocks with hash filenames', () => {
    const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4']
    const pushBlock = (count: number, dur: number, tag: string, discontinuous: boolean) => {
      if (discontinuous) lines.push('#EXT-X-DISCONTINUITY')
      for (let i = 0; i < count; i++) {
        lines.push(`#EXTINF:${dur},`)
        lines.push(`https://cdn.example.com/content/${tag}${i}x.ts`)
      }
    }
    pushBlock(20, 2, 'a', false)
    pushBlock(7, 2, 'b', true)
    pushBlock(6, 3, 'c', true)
    pushBlock(20, 2, 'd', true)
    const parsed = parsePlaylist(lines.join('\n'), 'https://cdn.example.com/content/index.m3u8')
    expect(detectShortBlocks(parsed.segments).size).toBe(13)
  })

  it('keeps same-path content fragments out of ad set when site uses cross-dir ads', () => {
    const parsed = parsePlaylist(samePathShortBlockSample(), 'https://kkzycdn.com:65/20221216/tnoQ2Gnh/2000kb/hls/index.m3u8')
    const result = detectAds(parsed, makeConfig())
    const mainPrefix = 'https://kkzycdn.com:65/20221216/tnoQ2Gnh/2000kb/hls/'
    const misjudged = [...result.adSegments].filter((i) => parsed.segments[i]!.url.startsWith(mainPrefix))
    expect(misjudged.length).toBe(0)
  })

  it('detects same-path short block ads when site has no cross-dir ads', () => {
    const parsed = parsePlaylist(samePathOnlyShortBlockSample(), 'https://vip.dytt-tvs.com/20260926/38688_18c968e3/3000k/hls/mixed.m3u8')
    const result = detectAds(parsed, makeConfig())
    expect(result.adSegments.size).toBe(2)
  })
})

describe('detectMinorityPathBlocks', () => {
  it('ignores playlists where all segments share one path prefix', () => {
    const segments: Segment[] = Array.from({ length: 8 }, (_, i) => ({
      index: i, url: `https://cdn.example.com/main/hls/s${i}.ts`, duration: 2, title: '', byterange: null, discontinuity: i % 4 === 0, cueState: null, scte35: null, dateRangeAd: null, seqNum: null,
    }))
    expect(detectMinorityPathBlocks(segments).size).toBe(0)
  })

  it('detects ad block served from a minority directory with hash filenames', () => {
    const parsed = parsePlaylist(minorityPathSample(), 'https://kkzycdn.com:65/20221216/tnoQ2Gnh/2000kb/hls/index.m3u8')
    const result = detectAds(parsed, makeConfig())
    for (let i = 100; i < 106; i++) expect(result.adSegments.has(i)).toBe(true)
    expect(result.report.ads).toBe(6)
    expect(result.adSegments.has(0)).toBe(false)
    expect(result.adSegments.has(106)).toBe(false)
  })

  it('keeps same-path short block adjacent to minority ad block', () => {
    const lines = minorityPathSample().split('\n')
    const adStart = lines.findIndex((l) => l.includes('10082kb'))
    const insert: string[] = ['#EXT-X-DISCONTINUITY']
    for (let i = 0; i < 7; i++) {
      insert.push('#EXTINF:2,')
      insert.push(`https://kkzycdn.com:65/20221216/tnoQ2Gnh/2000kb/hls/Zx9Qm4vT${i}.ts`)
    }
    lines.splice(adStart - 2, 0, ...insert)
    const parsed = parsePlaylist(lines.join('\n'), 'https://kkzycdn.com:65/20221216/tnoQ2Gnh/2000kb/hls/index.m3u8')
    const result = detectAds(parsed, makeConfig())
    expect(result.report.ads).toBe(6)
    for (let i = 100; i < 107; i++) expect(result.adSegments.has(i)).toBe(false)
    for (let i = 107; i < 113; i++) expect(result.adSegments.has(i)).toBe(true)
  })
})

function minorityPathSample(): string {
  const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD']
  const pushMain = (count: number, discontinuous: boolean) => {
    if (discontinuous) lines.push('#EXT-X-DISCONTINUITY')
    for (let i = 0; i < count; i++) {
      lines.push('#EXTINF:2,')
      lines.push(`https://kkzycdn.com:65/20221216/tnoQ2Gnh/2000kb/hls/Ah6ZrmwI${i}.ts`)
    }
  }
  pushMain(20, false)
  for (let k = 0; k < 4; k++) pushMain(20, true)
  lines.push('#EXT-X-DISCONTINUITY')
  for (let i = 0; i < 6; i++) {
    lines.push('#EXTINF:3,')
    lines.push(`https://kkzycdn.com:65/20261101/tkPlKg7b/10082kb/hls/PWoMkrH7${i}.ts`)
  }
  for (let k = 0; k < 6; k++) pushMain(20, true)
  return lines.join('\n')
}

function samePathShortBlockSample(): string {
  const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-PLAYLIST-TYPE:VOD']
  const main = 'https://kkzycdn.com:65/20221216/tnoQ2Gnh/2000kb/hls/'
  const adDir = 'https://kkzycdn.com:65/20261101/tkPlKg7b/10082kb/hls/'
  const pushBlock = (count: number, dur: number, base: string, tag: string) => {
    lines.push('#EXT-X-DISCONTINUITY')
    for (let i = 0; i < count; i++) {
      lines.push(`#EXTINF:${dur},`)
      lines.push(`${base}${tag}${i}.ts`)
    }
  }
  pushBlock(20, 2, main, 'c1_')
  pushBlock(7, 2, main, 'c2_')
  pushBlock(6, 3, adDir, 'ad_')
  pushBlock(20, 2, main, 'c3_')
  pushBlock(4, 2, main, 'c4_')
  pushBlock(6, 3, adDir, 'ad_')
  pushBlock(20, 2, main, 'c5_')
  return lines.join('\n')
}

function samePathOnlyShortBlockSample(): string {
  const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-PLAYLIST-TYPE:VOD']
  const base = 'https://vip.dytt-tvs.com/20260926/38688_18c968e3/3000k/hls/'
  const pushBlock = (count: number, dur: number, tag: string) => {
    lines.push('#EXT-X-DISCONTINUITY')
    for (let i = 0; i < count; i++) {
      lines.push(`#EXTINF:${dur},`)
      lines.push(`${base}${tag}${i}.ts`)
    }
  }
  pushBlock(5, 4, 'c1_')
  pushBlock(2, 2.4, 'ad_')
  pushBlock(5, 4, 'c2_')
  pushBlock(5, 4, 'c3_')
  return lines.join('\n')
}