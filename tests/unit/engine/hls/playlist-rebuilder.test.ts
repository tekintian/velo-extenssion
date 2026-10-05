import { describe, it, expect } from 'vitest'
import { rebuildPlaylist } from '@/engine/hls/playlist-rebuilder'
import { parsePlaylist } from '@/engine/hls/playlist-parser'
import { DEFAULT_CONFIG } from '@/engine/hls/hls-filter'
import type { AdFilterConfig } from '@/engine/hls/types'

function makeConfig(overrides: Partial<AdFilterConfig> = {}): AdFilterConfig {
  return { ...DEFAULT_CONFIG, ...overrides, _patterns: [], _forceKeep: [] }
}

describe('rebuildPlaylist', () => {
  it('removes ad segments and rebuilds m3u8', () => {
    const text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttps://cdn.example.com/content1.ts\n#EXTINF:10,\nhttps://cdn.example.com/ad1.ts\n#EXTINF:10,\nhttps://cdn.example.com/content2.ts\n#EXT-X-ENDLIST'
    const parsed = parsePlaylist(text, 'https://cdn.example.com/')
    const adSet = new Set([1])
    const result = rebuildPlaylist(parsed, adSet, 'https://cdn.example.com/', makeConfig())
    expect(result).toContain('#EXTM3U')
    expect(result).toContain('https://cdn.example.com/content1.ts')
    expect(result).not.toContain('https://cdn.example.com/ad1.ts')
    expect(result).toContain('https://cdn.example.com/content2.ts')
    expect(result).toContain('#EXT-X-ENDLIST')
  })

  it('adds DISCONTINUITY after ad gap', () => {
    const text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttps://cdn.example.com/content1.ts\n#EXTINF:10,\nhttps://cdn.example.com/ad1.ts\n#EXTINF:10,\nhttps://cdn.example.com/content2.ts\n#EXT-X-ENDLIST'
    const parsed = parsePlaylist(text, 'https://cdn.example.com/')
    const adSet = new Set([1])
    const result = rebuildPlaylist(parsed, adSet, 'https://cdn.example.com/', makeConfig({ keepDiscontinuityOnGap: true }))
    expect(result).toContain('#EXT-X-DISCONTINUITY')
  })

  it('resets MEDIA-SEQUENCE to 0', () => {
    const text = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:10,\nhttps://cdn.example.com/seg100.ts\n#EXT-X-ENDLIST'
    const parsed = parsePlaylist(text, 'https://cdn.example.com/')
    const result = rebuildPlaylist(parsed, new Set(), 'https://cdn.example.com/', makeConfig())
    expect(result).toContain('#EXT-X-MEDIA-SEQUENCE:0')
  })
})
