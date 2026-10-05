import { describe, it, expect } from 'vitest'
import { parsePlaylist, isMasterPlaylist, parseMasterPlaylist, extractSeqNum } from '@/engine/hls/playlist-parser'

describe('extractSeqNum', () => {
  it('extracts trailing digits before extension', () => {
    expect(extractSeqNum('https://cdn.example.com/segment12345.ts')).toBe(12345)
  })

  it('returns null for non-numeric filenames', () => {
    expect(extractSeqNum('https://cdn.example.com/abcdef.ts')).toBeNull()
  })

  it('handles query strings', () => {
    expect(extractSeqNum('https://cdn.example.com/seg001.ts?token=abc')).toBe(1)
  })
})

describe('isMasterPlaylist', () => {
  it('detects master playlist', () => {
    expect(isMasterPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nstream.m3u8')).toBe(true)
  })

  it('returns false for media playlist', () => {
    expect(isMasterPlaylist('#EXTM3U\n#EXTINF:10,\nseg1.ts')).toBe(false)
  })
})

describe('parseMasterPlaylist', () => {
  it('parses variants with bandwidth', () => {
    const text = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n360p.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=842x480\n480p.m3u8'
    const variants = parseMasterPlaylist(text, 'https://cdn.example.com/')
    expect(variants).toHaveLength(2)
    expect(variants[0]!.bandwidth).toBe(800000)
    expect(variants[0]!.resolution).toBe('640x360')
    expect(variants[0]!.url).toBe('https://cdn.example.com/360p.m3u8')
  })
})

describe('parsePlaylist', () => {
  it('parses a simple media playlist', () => {
    const text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:9.9,\nhttps://cdn.example.com/seg1.ts\n#EXTINF:9.9,\nhttps://cdn.example.com/seg2.ts\n#EXT-X-ENDLIST'
    const result = parsePlaylist(text, 'https://cdn.example.com/')
    expect(result.segments).toHaveLength(2)
    expect(result.segments[0]!.duration).toBe(9.9)
    expect(result.segments[0]!.url).toBe('https://cdn.example.com/seg1.ts')
    expect(result.segments[1]!.url).toBe('https://cdn.example.com/seg2.ts')
  })

  it('handles CUE-OUT/CUE-IN ad markers', () => {
    const text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttps://cdn.example.com/content1.ts\n#EXT-X-CUE-OUT\n#EXTINF:10,\nhttps://cdn.example.com/ad1.ts\n#EXT-X-CUE-IN\n#EXTINF:10,\nhttps://cdn.example.com/content2.ts\n#EXT-X-ENDLIST'
    const result = parsePlaylist(text, 'https://cdn.example.com/')
    expect(result.segments[1]!.cueState).toBe('out')
    expect(result.segments[2]!.cueState).toBeNull()
  })

  it('handles relative URLs', () => {
    const text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg1.ts\n#EXT-X-ENDLIST'
    const result = parsePlaylist(text, 'https://cdn.example.com/stream/')
    expect(result.segments[0]!.url).toBe('https://cdn.example.com/stream/seg1.ts')
  })

  it('handles EXT-X-MEDIA-SEQUENCE', () => {
    const text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:10,\nhttps://cdn.example.com/seg100.ts\n#EXT-X-ENDLIST'
    const result = parsePlaylist(text, 'https://cdn.example.com/')
    expect(result.mediaSeqStart).toBe(100)
  })

  it('returns empty for non-m3u8 input', () => {
    const result = parsePlaylist('not m3u8', 'https://example.com/')
    expect(result.segments).toHaveLength(0)
  })
})
