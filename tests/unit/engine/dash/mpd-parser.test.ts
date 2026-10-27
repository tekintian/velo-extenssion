import { describe, it, expect } from 'vitest'
import { parseMpd, parseDuration } from '@/engine/dash/mpd-parser'
import { rebuildMpd } from '@/engine/dash/mpd-rebuilder'
import { detectAds } from '@/engine/dash/ad-detector'
import type { MpdManifest, MpdPeriod } from '@/engine/dash/types'

const SIMPLE_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT0H3M0.000S" minBufferTime="PT1.500S">
  <Period id="1" start="PT0S" duration="PT0H1M0.000S">
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <Representation id="v1" bandwidth="2000000" width="1280" height="720" codecs="avc1.64001f">
        <BaseURL>https://cdn.example.com/video/720p/</BaseURL>
        <SegmentTemplate media="seg_$Number$.m4s" initialization="init.m4s" startNumber="1" duration="2" timescale="1"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" contentType="audio" lang="en">
      <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2">
        <BaseURL>https://cdn.example.com/audio/</BaseURL>
        <SegmentTemplate media="seg_$Number$.m4s" initialization="init.m4s" startNumber="1" duration="2" timescale="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
  <Period id="2" start="PT0H1M0.000S" duration="PT0H0M30.000S">
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <Representation id="v_ad" bandwidth="8000000" width="1920" height="1080" codecs="avc1.640032">
        <BaseURL>https://ad.example.com/preroll/</BaseURL>
        <SegmentTemplate media="seg_$Number$.m4s" initialization="init.m4s" startNumber="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
  <Period id="3" start="PT0H1M30.000S" duration="PT0H1M30.000S">
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <Representation id="v2" bandwidth="3000000" width="1920" height="1080" codecs="avc1.640028">
        <BaseURL>https://cdn.example.com/video/1080p/</BaseURL>
        <SegmentTemplate media="seg_$Number$.m4s" initialization="init.m4s" startNumber="1" duration="2" timescale="1"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" contentType="audio" lang="en">
      <Representation id="a2" bandwidth="192000" codecs="mp4a.40.2">
        <BaseURL>https://cdn.example.com/audio/</BaseURL>
        <SegmentTemplate media="seg_$Number$.m4s" initialization="init.m4s" startNumber="1" duration="2" timescale="1"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`

const DRM_MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT2M">
  <Period id="1">
    <AdaptationSet mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" value="Widevine"/>
      <Representation id="v1" bandwidth="2000000"/>
    </AdaptationSet>
  </Period>
</MPD>`

const SCTE35_MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT5M">
  <Period id="content" start="PT0S" duration="PT2M">
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v1" bandwidth="2000000"/>
    </AdaptationSet>
  </Period>
  <Period id="ad" start="PT2M" duration="PT30S">
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v_ad" bandwidth="500000"/>
    </AdaptationSet>
    <EventStream schemeIdUri="urn:scte:scte35:2013:bin" value="1">
      <Event presentationTime="0" duration="30"/>
    </EventStream>
  </Period>
  <Period id="content2" start="PT2M30S" duration="PT2M30S">
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v2" bandwidth="3000000"/>
    </AdaptationSet>
  </Period>
</MPD>`

const DYNAMIC_MPD = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" minimumUpdatePeriod="PT5S">
  <Period id="1"/>
</MPD>`

describe('parseMpd', () => {
  it('parses static MPD with 3 Periods', () => {
    const mpd = parseMpd(SIMPLE_MPD)
    expect(mpd.type).toBe('mpd-xml')
    expect(mpd.mpdType).toBe('static')
    expect(mpd.mediaPresentationDuration).toBe(180)
    expect(mpd.minBufferTime).toBe(1.5)
    expect(mpd.periods.length).toBe(3)
  })

  it('parses Period attributes', () => {
    const mpd = parseMpd(SIMPLE_MPD)
    const p1 = mpd.periods[0]!
    expect(p1.id).toBe('1')
    expect(p1.start).toBe(0)
    expect(p1.duration).toBe(60)
  })

  it('parses AdaptationSet and Representation', () => {
    const mpd = parseMpd(SIMPLE_MPD)
    const p1 = mpd.periods[0]!
    expect(p1.adaptations.length).toBe(2)
    expect(p1.adaptations[0]!.mimeType).toBe('video/mp4')
    expect(p1.adaptations[0]!.representations.length).toBe(1)
    expect(p1.adaptations[0]!.representations[0]!.id).toBe('v1')
    expect(p1.adaptations[0]!.representations[0]!.bandwidth).toBe(2000000)
  })

  it('parses SegmentTemplate', () => {
    const mpd = parseMpd(SIMPLE_MPD)
    const rep = mpd.periods[0]!.adaptations[0]!.representations[0]!
    expect(rep.segmentTemplate).toBeDefined()
    expect(rep.segmentTemplate?.media).toBe('seg_$Number$.m4s')
    expect(rep.segmentTemplate?.initialization).toBe('init.m4s')
    expect(rep.segmentTemplate?.startNumber).toBe(1)
  })

  it('parses BaseURL', () => {
    const mpd = parseMpd(SIMPLE_MPD)
    const rep = mpd.periods[0]!.adaptations[0]!.representations[0]!
    expect(rep.baseUrl).toBe('https://cdn.example.com/video/720p/')
  })

  it('parses ContentProtection (DRM)', () => {
    const mpd = parseMpd(DRM_MPD)
    expect(mpd.contentProtections.length).toBeGreaterThan(0)
    expect(mpd.contentProtections[0]!.schemeIdUri).toContain('edef8ba9')
  })

  it('parses EventStream SCTE-35', () => {
    const mpd = parseMpd(SCTE35_MPD)
    const adPeriod = mpd.periods.find((p) => p.id === 'ad')
    expect(adPeriod).toBeDefined()
    expect(adPeriod!.eventStreams).toBeDefined()
    expect(adPeriod!.eventStreams!.length).toBeGreaterThan(0)
    expect(adPeriod!.eventStreams![0]!.schemeIdUri).toContain('scte35')
  })

  it('detects dynamic MPD type', () => {
    const mpd = parseMpd(DYNAMIC_MPD)
    expect(mpd.mpdType).toBe('dynamic')
  })

  it('throws on invalid XML', () => {
    expect(() => parseMpd('not xml at all')).toThrow()
  })

  it('throws on missing MPD element', () => {
    expect(() => parseMpd('<?xml version="1.0"?><root/>')).toThrow()
  })
})

describe('parseDuration', () => {
  it('parses PT0H0M30.000S', () => {
    expect(parseDuration('PT0H0M30.000S')).toBe(30)
  })

  it('parses PT1M15S', () => {
    expect(parseDuration('PT1M15S')).toBe(75)
  })

  it('parses PT1H2M3S', () => {
    expect(parseDuration('PT1H2M3S')).toBe(3723)
  })

  it('parses PT0S', () => {
    expect(parseDuration('PT0S')).toBe(0)
  })

  it('returns undefined for null', () => {
    expect(parseDuration(null)).toBeUndefined()
  })

  it('returns undefined for invalid', () => {
    expect(parseDuration('invalid')).toBeUndefined()
  })
})

describe('detectAds — MPD XML', () => {
  it('detects ad Period by EventStream SCTE-35', async () => {
    const mpd = parseMpd(SCTE35_MPD)
    const result = await detectAds(mpd, {
      patterns: [],
      forceKeep: [],
      scoreThreshold: 3,
    })
    expect(result.adTargetIds.has('ad')).toBe(true)
  })

  it('detects ad Period by xlink:href', async () => {
    const xlinkMpd = makeMpdWithXlink()
    const result = await detectAds(xlinkMpd, {
      patterns: [],
      forceKeep: [],
      scoreThreshold: 3,
    })
    expect(result.adTargetIds.has('ad-xlink')).toBe(true)
  })

  it('detects ad Period by id pattern', async () => {
    const idMpd = makeMpdWithAdId()
    const result = await detectAds(idMpd, {
      patterns: [],
      forceKeep: [],
      scoreThreshold: 3,
    })
    expect(result.adTargetIds.has('ad-preroll')).toBe(true)
  })

  it('returns empty for clean MPD', async () => {
    const mpd = parseMpd(SIMPLE_MPD)
    const result = await detectAds(mpd, {
      patterns: [],
      forceKeep: [],
      scoreThreshold: 5,
    })
    expect(result.adTargetIds.size).toBe(0)
  })
})

describe('rebuildMpd', () => {
  it('removes ad Period and reperiods start times', () => {
    const mpd = parseMpd(SIMPLE_MPD)
    const result = rebuildMpd(mpd, new Set(['2']))
    expect(result.success).toBe(true)
    expect(result.removedPeriodIds).toEqual(['2'])
    expect(result.cleanedXml).not.toContain('id="2"')
    expect(result.cleanedXml).toContain('id="1"')
    expect(result.cleanedXml).toContain('id="3"')
  })

  it('returns passthrough when all Periods are ad', () => {
    const mpd = parseMpd(SIMPLE_MPD)
    const result = rebuildMpd(mpd, new Set(['1', '2', '3']))
    expect(result.success).toBe(false)
    expect(result.reason).toBe('all-periods-ad')
  })

  it('returns null cleanedXml when no ad Periods', () => {
    const mpd = parseMpd(SIMPLE_MPD)
    const result = rebuildMpd(mpd, new Set())
    expect(result.success).toBe(true)
    expect(result.cleanedXml).toBeNull()
  })

  it('preserves XML declaration', () => {
    const mpd = parseMpd(SIMPLE_MPD)
    const result = rebuildMpd(mpd, new Set(['2']))
    expect(result.cleanedXml).toContain('<?xml')
  })

  it('handles removing first Period', () => {
    const mpd = parseMpd(SIMPLE_MPD)
    const result = rebuildMpd(mpd, new Set(['1']))
    expect(result.success).toBe(true)
    expect(result.cleanedXml).not.toContain('id="1"')
  })

  it('handles removing last Period', () => {
    const mpd = parseMpd(SIMPLE_MPD)
    const result = rebuildMpd(mpd, new Set(['3']))
    expect(result.success).toBe(true)
    expect(result.cleanedXml).not.toContain('id="3"')
  })
})

function makeMpdWithXlink(): MpdManifest {
  return {
    type: 'mpd-xml',
    mpdType: 'static',
    mediaPresentationDuration: 120,
    periods: [
      makePeriod('content', 0, 60),
      { ...makePeriod('ad-xlink', 60, 30), xlinkHref: 'https://ad-cdn.example.com/ad.xml' },
      makePeriod('content2', 90, 30),
    ],
    contentProtections: [],
    rawXml: '<MPD/>',
  }
}

function makeMpdWithAdId(): MpdManifest {
  return {
    type: 'mpd-xml',
    mpdType: 'static',
    mediaPresentationDuration: 120,
    periods: [
      makePeriod('content', 0, 60),
      makePeriod('ad-preroll', 60, 30),
      makePeriod('content2', 90, 30),
    ],
    contentProtections: [],
    rawXml: '<MPD/>',
  }
}

function makePeriod(id: string, start: number, duration: number): MpdPeriod {
  return {
    id,
    start,
    duration,
    adaptations: [
      {
        mimeType: 'video/mp4',
        contentType: 'video',
        representations: [
          { id: `${id}-v1`, bandwidth: 2000000 },
        ],
      },
    ],
  }
}