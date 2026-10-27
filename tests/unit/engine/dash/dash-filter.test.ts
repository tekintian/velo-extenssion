import { describe, it, expect } from 'vitest'
import { detectManifestType, detectDrm } from '@/engine/dash/dash-filter'
import { parseJsonPlayurl, detectPlayurlSource } from '@/engine/dash/json-playurl-parser'
import { rebuildJsonPlayurl } from '@/engine/dash/json-playurl-rebuilder'
import { detectAds } from '@/engine/dash/ad-detector'
import { resolveTrackFirstSegmentUrl } from '@/engine/dash/resolve-first-url'
import type { JsonPlayurlManifest, PlayurlTrack } from '@/engine/dash/types'

describe('detectManifestType', () => {
  it('detects B站 playurl by URL pattern', () => {
    expect(detectManifestType('{}', 'https://api.bilibili.com/x/player/playurl?avid=123')).toBe('json-playurl')
  })

  it('detects YouTube player by URL pattern', () => {
    expect(detectManifestType('{}', 'https://www.youtube.com/youtubei/v1/player?key=xxx')).toBe('json-playurl')
  })

  it('detects .mpd by URL pattern', () => {
    expect(detectManifestType('<MPD/>', 'https://cdn.example.com/manifest.mpd')).toBe('mpd-xml')
  })

  it('detects by Content-Type dash+xml', () => {
    expect(detectManifestType('x', 'https://cdn.example.com/video', 'application/dash+xml')).toBe('mpd-xml')
  })

  it('detects JSON by content sniffing', () => {
    expect(detectManifestType('{"code":0}', 'https://cdn.example.com/api')).toBe('json-playurl')
  })

  it('detects XML by content sniffing', () => {
    expect(detectManifestType('<?xml version="1.0"?><MPD>', 'https://cdn.example.com/api')).toBe('mpd-xml')
  })

  it('returns unknown for unrecognized', () => {
    expect(detectManifestType('binary data here', 'https://cdn.example.com/file')).toBe('unknown')
  })
})

describe('detectDrm', () => {
  it('detects Widevine in XML', () => {
    const xml = '<MPD><AdaptationSet><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/></AdaptationSet></MPD>'
    const result = detectDrm(xml, 'xml')
    expect(result.hasDrm).toBe(true)
    expect(result.scheme).toBe('widevine')
  })

  it('detects PlayReady in XML', () => {
    const xml = '<ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4ab8-a5e8-5ab0385f3852"/>'
    const result = detectDrm(xml, 'xml')
    expect(result.hasDrm).toBe(true)
    expect(result.scheme).toBe('playready')
  })

  it('detects DRM in JSON', () => {
    const json = JSON.stringify({ dash: { video: [{ encrypted: true }] } })
    const result = detectDrm(json, 'json')
    expect(result.hasDrm).toBe(true)
  })

  it('returns false for clean content', () => {
    expect(detectDrm('<MPD><Period/></MPD>', 'xml').hasDrm).toBe(false)
    expect(detectDrm('{"code":0}', 'json').hasDrm).toBe(false)
  })
})

describe('detectPlayurlSource', () => {
  it('detects B站 playurl', () => {
    expect(detectPlayurlSource({}, 'https://api.bilibili.com/x/player/playurl?avid=123')).toBe('bili-playurl')
  })

  it('detects YouTube player', () => {
    expect(detectPlayurlSource({}, 'https://www.youtube.com/youtubei/v1/player')).toBe('youtube-player')
  })

  it('returns unknown for others', () => {
    expect(detectPlayurlSource({}, 'https://cdn.example.com/manifest.json')).toBe('unknown')
  })
})

describe('parseJsonPlayurl — B站样本', () => {
  it('parses B站 playurl with ad tracks', () => {
    const biliJson = JSON.stringify({
      code: 0,
      data: {
        dash: {
          video: [
            {
              id: 120,
              baseUrl: 'https://cn-sy-cu-v-01.bilivideo.com/upgcxcode/120/main.m4s',
              backupUrl: [],
              bandwidth: 2000000,
              mimeType: 'video/mp4',
              codecs: 'avc1.64001f',
              width: 640,
              height: 360,
              frameRate: '30',
              segmentBase: {
                initialization: '0-719',
                indexRange: '720-1439',
              },
            },
            {
              id: 100,
              baseUrl: 'https://cn-sy-cu-v-01.bilivideo.com/ad/more/100/main.m4s',
              backupUrl: [],
              bandwidth: 8000000,
              mimeType: 'video/mp4',
              codecs: 'avc1.640032',
              width: 1920,
              height: 1080,
              frameRate: '30',
              segmentBase: {
                initialization: '0-719',
                indexRange: '720-1439',
              },
            },
          ],
          audio: [
            {
              id: 30280,
              baseUrl: 'https://cn-sy-cu-v-01.bilivideo.com/upgcxcode/30280/main.m4s',
              backupUrl: [],
              bandwidth: 320000,
              mimeType: 'audio/mp4',
              codecs: 'mp4a.40.2',
              segmentBase: {
                initialization: '0-719',
                indexRange: '720-1439',
              },
            },
          ],
          dolby: { type: 0, audio: [] },
          flac: { audio: null },
        },
        accept_quality: [120, 100],
      },
    })

    const manifest = parseJsonPlayurl(biliJson, 'https://api.bilibili.com/x/player/playurl?avid=123')
    expect(manifest.type).toBe('json-playurl')
    expect(manifest.source).toBe('bili-playurl')
    expect(manifest.tracks.length).toBe(3)
    expect(manifest.tracks.filter((t) => t.kind === 'video').length).toBe(2)
    expect(manifest.tracks.filter((t) => t.kind === 'audio').length).toBe(1)
  })

  it('parses YouTube player response', () => {
    const ytJson = JSON.stringify({
      playabilityStatus: { status: 'OK' },
      streamingData: {
        adaptiveFormats: [
          {
            itag: 137,
            url: 'https://rr1---sn-xxx.googlevideo.com/videoplayback/itag/137/',
            mimeType: 'video/mp4; codecs="avc1.640028"',
            bitrate: 3000000,
            width: 1920,
            height: 1080,
            fps: 30,
          },
          {
            itag: 251,
            url: 'https://rr1---sn-xxx.googlevideo.com/videoplayback/itag/251/',
            mimeType: 'audio/webm; codecs="opus"',
            bitrate: 160000,
          },
        ],
      },
    })

    const manifest = parseJsonPlayurl(ytJson, 'https://www.youtube.com/youtubei/v1/player')
    expect(manifest.type).toBe('json-playurl')
    expect(manifest.source).toBe('youtube-player')
    expect(manifest.tracks.length).toBe(2)
  })
})

describe('detectAds — DASH', () => {
  it('detects ad track by URL pattern', async () => {
    const manifest: JsonPlayurlManifest = {
      type: 'json-playurl',
      source: 'bili-playurl',
      duration: 300,
      tracks: [
        makeTrack('v1', 'video', 'https://cdn.bilivideo.com/upgcxcode/120/main.m4s', 2000000),
        makeTrack('v2', 'video', 'https://cdn.bilivideo.com/ad/more/100/main.m4s', 8000000),
        makeTrack('a1', 'audio', 'https://cdn.bilivideo.com/upgcxcode/30280/main.m4s', 320000),
      ],
      raw: {},
    }

    const result = await detectAds(manifest, {
      patterns: [/\/ad\//i, /preroll/i, /midroll/i],
      forceKeep: [],
      scoreThreshold: 3,
    })

    expect(result.adTargetIds.has('v2')).toBe(true)
    expect(result.adTargetIds.has('v1')).toBe(false)
  })

  it('detects ad by bandwidth outlier', async () => {
    const manifest: JsonPlayurlManifest = {
      type: 'json-playurl',
      source: 'bili-playurl',
      duration: 300,
      tracks: [
        makeTrack('v1', 'video', 'https://cdn.example.com/video/360p.m4s', 500000),
        makeTrack('v2', 'video', 'https://cdn.example.com/video/720p.m4s', 1500000),
        makeTrack('v3', 'video', 'https://cdn.example.com/video/1080p.m4s', 3000000),
        makeTrack('v_ad', 'video', 'https://cdn.example.com/video/4k.m4s', 20000000),
      ],
      raw: {},
    }

    const result = await detectAds(manifest, {
      patterns: [],
      forceKeep: [],
      scoreThreshold: 3,
    })

    expect(result.adTargetIds.has('v_ad')).toBe(true)
  })

  it('returns empty for clean manifest', async () => {
    const manifest: JsonPlayurlManifest = {
      type: 'json-playurl',
      source: 'bili-playurl',
      duration: 300,
      tracks: [
        makeTrack('v1', 'video', 'https://cdn.example.com/video/360p.m4s', 500000),
        makeTrack('v2', 'video', 'https://cdn.example.com/video/720p.m4s', 1500000),
        makeTrack('a1', 'audio', 'https://cdn.example.com/audio/128k.m4s', 128000),
      ],
      raw: {},
    }

    const result = await detectAds(manifest, {
      patterns: [],
      forceKeep: [],
      scoreThreshold: 3,
    })

    expect(result.adTargetIds.size).toBe(0)
  })

  it('detects ad by codec family mismatch (e.g. B站 ad uses hevc while content uses avc)', async () => {
    const manifest: JsonPlayurlManifest = {
      type: 'json-playurl',
      source: 'bili-playurl',
      duration: 300,
      tracks: [
        makeTrack('v1', 'video', 'https://cdn.bilivideo.com/video/720p.m4s', 1500000, 'avc1.64001f'),
        makeTrack('v2', 'video', 'https://cdn.bilivideo.com/video/1080p.m4s', 3000000, 'avc1.640028'),
        makeTrack('v_ad', 'video', 'https://cdn.bilivideo.com/video/4k.m4s', 8000000, 'hev1.1.6.L93.B0'),
        makeTrack('a1', 'audio', 'https://cdn.bilivideo.com/audio/128k.m4s', 128000, 'mp4a.40.2'),
      ],
      raw: {},
    }

    const result = await detectAds(manifest, {
      patterns: [],
      forceKeep: [],
      scoreThreshold: 3,
    })

    expect(result.adTargetIds.has('v_ad')).toBe(true)
    expect(result.detections.find((d) => d.targetId === 'v_ad')!.signal).toContain('codec-mismatch')
  })

  it('detects ad by codec profile mismatch (B站 ad uses High@4.0, content uses Main@3.1)', async () => {
    const manifest: JsonPlayurlManifest = {
      type: 'json-playurl',
      source: 'bili-playurl',
      duration: 300,
      tracks: [
        makeTrack('v1', 'video', 'https://cdn.bilivideo.com/video/360p.m4s', 500000, 'avc1.4D401E'),
        makeTrack('v2', 'video', 'https://cdn.bilivideo.com/video/720p.m4s', 1500000, 'avc1.4D401F'),
        makeTrack('v3', 'video', 'https://cdn.bilivideo.com/video/1080p.m4s', 3000000, 'avc1.4D4028'),
        makeTrack('v_ad', 'video', 'https://cdn.bilivideo.com/video/ad.m4s', 8000000, 'avc1.640028'),
        makeTrack('a1', 'audio', 'https://cdn.bilivideo.com/audio/128k.m4s', 128000, 'mp4a.40.2'),
      ],
      raw: {},
    }

    const result = await detectAds(manifest, {
      patterns: [],
      forceKeep: [],
      scoreThreshold: 3,
    })

    expect(result.adTargetIds.has('v_ad')).toBe(true)
  })
})

describe('rebuildJsonPlayurl', () => {
  it('removes ad tracks from B站 JSON', () => {
    const manifest: JsonPlayurlManifest = {
      type: 'json-playurl',
      source: 'bili-playurl',
      duration: 300,
      tracks: [
        makeTrack('v1', 'video', 'https://cdn.example.com/video/360p.m4s', 500000),
        makeTrack('v_ad', 'video', 'https://cdn.example.com/ad/preroll.m4s', 8000000),
        makeTrack('a1', 'audio', 'https://cdn.example.com/audio/128k.m4s', 128000),
      ],
      raw: {
        code: 0,
        data: {
          dash: {
            video: [
              { id: 120, baseUrl: 'https://cdn.example.com/video/360p.m4s', bandwidth: 500000, mimeType: 'video/mp4' },
              { id: 100, baseUrl: 'https://cdn.example.com/ad/preroll.m4s', bandwidth: 8000000, mimeType: 'video/mp4' },
            ],
            audio: [
              { id: 30280, baseUrl: 'https://cdn.example.com/audio/128k.m4s', bandwidth: 128000, mimeType: 'audio/mp4' },
            ],
          },
        },
      },
    }

    const result = rebuildJsonPlayurl(manifest, new Set(['v_ad']))
    expect(result.success).toBe(true)
    if (result.success) {
      const cleaned = result.cleanedJson as { data: { dash: { video: unknown[]; audio: unknown[] } } }
      expect(cleaned.data.dash.video.length).toBe(1)
      expect(cleaned.data.dash.audio.length).toBe(1)
    }
  })
})

describe('resolveTrackFirstSegmentUrl', () => {
  it('resolves baseUrl directly', () => {
    const track = makeTrack('v1', 'video', 'https://cdn.example.com/video/main.m4s', 2000000)
    const result = resolveTrackFirstSegmentUrl(track)
    expect(result?.url).toBe('https://cdn.example.com/video/main.m4s')
  })

  it('resolves segmentTemplate media URL', () => {
    const track: PlayurlTrack = {
      ...makeTrack('v1', 'video', '', 2000000),
      segmentTemplate: {
        media: 'https://cdn.example.com/video/segment_$Number$.m4s',
        initialization: 'https://cdn.example.com/video/init.m4s',
        startNumber: 1,
      },
    }
    const result = resolveTrackFirstSegmentUrl(track)
    expect(result?.url).toBe('https://cdn.example.com/video/segment_1.m4s')
  })

  it('returns null for empty track', () => {
    const track = makeTrack('v1', 'video', '', 2000000)
    const result = resolveTrackFirstSegmentUrl(track)
    expect(result).toBeNull()
  })
})

function makeTrack(id: string, kind: 'video' | 'audio', baseUrl: string, bandwidth: number, codecs?: string): PlayurlTrack {
  return {
    id,
    kind,
    bandwidth,
    mimeType: kind === 'video' ? 'video/mp4' : 'audio/mp4',
    codecs: codecs ?? (kind === 'video' ? 'avc1.64001f' : 'mp4a.40.2'),
    baseUrl,
    metadata: {},
  }
}