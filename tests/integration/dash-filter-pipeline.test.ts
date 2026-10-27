/**
 * DASH 广告过滤端到端 pipeline 集成测试
 *
 * 完整流程：processManifest → detectManifestType → parse → detect → rebuild → adRanges
 */

import { describe, it, expect } from 'vitest'
import { processManifest, detectManifestType, detectDrm } from '@/engine/dash/dash-filter'

const BILI_PLAYURL = JSON.stringify({
  code: 0,
  data: {
    dash: {
      video: [
        {
          id: 80,
          baseUrl: 'https://cn-sy-cd-v-09.bilivideo.com/upgcxcode/80/8000/content.mp4',
          bandwidth: 2000000,
          codecid: 7,
          codecs: 'avc1.64001f',
          width: 1280,
          height: 720,
        },
        {
          id: 81,
          baseUrl: 'https://ad-cdn.bilivideo.com/ad/preroll/8000/ad.mp4',
          bandwidth: 5000000,
          codecid: 7,
          codecs: 'avc1.640028',
          width: 1920,
          height: 1080,
        },
      ],
      audio: [
        {
          id: 30280,
          baseUrl: 'https://cn-sy-cd-v-09.bilivideo.com/upgcxcode/30280/320000/audio.mp4',
          bandwidth: 320000,
          codecid: 0,
          codecs: 'mp4a.40.2',
        },
      ],
      dolby: { type: 0, audio: [] },
      flac: { audio: null },
    },
    timelength: 180000,
  },
})

const BILI_PLAYURL_URL = 'https://api.bilibili.com/x/player/playurl?cid=123&bvid=456'

const SIMPLE_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT0H3M0.000S" minBufferTime="PT1.500S">
  <Period id="1" start="PT0S" duration="PT0H1M0.000S">
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <Representation id="v1" bandwidth="2000000" width="1280" height="720" codecs="avc1.64001f">
        <BaseURL>https://cdn.example.com/video/720p/</BaseURL>
        <SegmentTemplate media="seg_$Number$.m4s" initialization="init.m4s" startNumber="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
  <Period id="ad" start="PT1M0S" duration="PT0H0M30.000S">
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <Representation id="v_ad" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028">
        <BaseURL>https://ad-cdn.example.com/preroll/</BaseURL>
        <SegmentTemplate media="seg_$Number$.m4s" initialization="init.m4s" startNumber="1"/>
      </Representation>
    </AdaptationSet>
    <EventStream schemeIdUri="urn:scte:scte35:2013:bin">
      <Event presentationTime="0" duration="30"/>
    </EventStream>
  </Period>
  <Period id="3" start="PT1M30S" duration="PT0H1M30.000S">
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <Representation id="v3" bandwidth="3000000" width="1920" height="1080" codecs="avc1.640028">
        <BaseURL>https://cdn.example.com/video/1080p/</BaseURL>
        <SegmentTemplate media="seg_$Number$.m4s" initialization="init.m4s" startNumber="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

const DRM_MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
  <Period id="1">
    <AdaptationSet mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" value="Widevine"/>
      <Representation id="v1" bandwidth="2000000"/>
    </AdaptationSet>
  </Period>
</MPD>`

const DYNAMIC_MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" minimumUpdatePeriod="PT5S">
  <Period id="1"/>
</MPD>`

describe('DASH pipeline — detectManifestType', () => {
  it('detects B站 playurl by URL', () => {
    expect(detectManifestType('{}', BILI_PLAYURL_URL)).toBe('json-playurl')
  })

  it('detects MPD by URL', () => {
    expect(detectManifestType('', 'https://example.com/manifest.mpd')).toBe('mpd-xml')
  })

  it('detects MPD by Content-Type', () => {
    expect(detectManifestType('', 'https://example.com/video', 'application/dash+xml')).toBe('mpd-xml')
  })

  it('detects JSON by content sniffing', () => {
    expect(detectManifestType('{"dash":{}}', 'https://example.com/api')).toBe('json-playurl')
  })

  it('detects MPD by content sniffing', () => {
    expect(detectManifestType('<?xml version="1.0"?><MPD/>', 'https://example.com/manifest')).toBe('mpd-xml')
  })

  it('returns unknown for unrecognized', () => {
    expect(detectManifestType('random text', 'https://example.com/data')).toBe('unknown')
  })
})

describe('DASH pipeline — DRM detection', () => {
  it('detects Widevine in XML', () => {
    const result = detectDrm(DRM_MPD, 'xml')
    expect(result.hasDrm).toBe(true)
    expect(result.scheme).toBe('widevine')
  })

  it('no DRM in clean MPD', () => {
    const result = detectDrm(SIMPLE_MPD, 'xml')
    expect(result.hasDrm).toBe(false)
  })
})

describe('DASH pipeline — JSON Playurl end-to-end', () => {
  it('processes B站 playurl and detects ad track', async () => {
    const result = await processManifest(
      BILI_PLAYURL,
      BILI_PLAYURL_URL,
      'https://www.bilibili.com/video/BV123',
    )

    expect(result.mode).not.toBe('passthrough')
    if (result.mode === 'manifest-file' || result.mode === 'data-url') {
      expect(result.summary.adTargets).toBeGreaterThan(0)
      expect(result.cleanedText).toBeDefined()
    }
  })

  it('returns passthrough for empty JSON', async () => {
    const result = await processManifest(
      '{"data":{"dash":{"video":[],"audio":[]}}}',
      BILI_PLAYURL_URL,
      'https://www.bilibili.com',
    )
    expect(result.mode).toBe('passthrough')
  })
})

describe('DASH pipeline — MPD XML end-to-end', () => {
  it('processes MPD with ad Period and removes it', async () => {
    const result = await processManifest(
      SIMPLE_MPD,
      'https://example.com/manifest.mpd',
      'https://example.com/watch',
    )

    expect(result.mode).not.toBe('disabled')
    if (result.mode === 'manifest-file' || result.mode === 'data-url') {
      expect(result.summary.adTargets).toBeGreaterThan(0)
      expect(result.cleanedText).toBeDefined()
      expect(result.cleanedText).not.toContain('id="ad"')
      expect(result.adRanges).toBeDefined()
      expect(result.adRanges!.length).toBeGreaterThan(0)
    }
  })

  it('returns disabled for DRM MPD', async () => {
    const result = await processManifest(
      DRM_MPD,
      'https://example.com/drm.mpd',
      'https://example.com/watch',
    )
    expect(result.mode).toBe('disabled')
  })

  it('returns passthrough for dynamic MPD', async () => {
    const result = await processManifest(
      DYNAMIC_MPD,
      'https://example.com/live.mpd',
      'https://example.com/live',
    )
    expect(result.mode).toBe('passthrough')
  })
})

describe('DASH pipeline — error recovery', () => {
  it('handles invalid JSON gracefully', async () => {
    const result = await processManifest(
      'not json at all',
      BILI_PLAYURL_URL,
      'https://example.com',
    )
    expect(result.mode).toBe('passthrough')
  })

  it('handles invalid XML gracefully', async () => {
    const result = await processManifest(
      'not xml at all',
      'https://example.com/manifest!mpd',
      'https://example.com',
    )
    expect(result.mode).toBe('passthrough')
  })

  it('handles unknown manifest type', async () => {
    const result = await processManifest(
      'random binary data',
      'https://example.com/binary',
      'https://example.com',
    )
    expect(result.mode).toBe('passthrough')
  })
})