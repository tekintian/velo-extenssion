/**
 * MPD XML 解析器（模式 A — DASH-IF / IPTV / 自托管 DASH）
 *
 * 使用浏览器原生 DOMParser 解析 MPD XML，
 * 输出结构化 MpdManifest 对象供 ad-detector / mpd-rebuilder 使用。
 *
 * MV3 Service Worker 中 DOMParser 为标准可用 API（WorkerGlobalScope）。
 */

import type {
  MpdManifest,
  MpdPeriod,
  MpdAdaptation,
  MpdRepresentation,
  MpdEventStream,
  ContentProtectionInfo,
  SegmentBaseInfo,
  SegmentTemplateInfo,
  SegmentTimelineEntry,
} from './types'

const DASH_NS = 'urn:mpeg:dash:schema:mpd:2011'
const MAX_MANIFEST_SIZE = 10 * 1024 * 1024
const MAX_PERIODS = 200

export function parseMpd(xmlText: string, url?: string): MpdManifest {
  if (xmlText.length > MAX_MANIFEST_SIZE) {
    throw new Error(`Manifest too large: ${xmlText.length} bytes > ${MAX_MANIFEST_SIZE}`)
  }

  const parser = new DOMParser()
  const doc = parser.parseFromString(xmlText, 'application/xml')

  const parseError = doc.querySelector('parsererror')
  if (parseError) {
    throw new Error(`XML parse error: ${parseError.textContent?.slice(0, 200)}`)
  }

  const mpdEl = doc.getElementsByTagNameNS(DASH_NS, 'MPD')[0]
    ?? doc.getElementsByTagName('MPD')[0]

  if (!mpdEl) {
    throw new Error('No <MPD> element found in XML')
  }

  const mpdType = (mpdEl.getAttribute('type') ?? 'static') as 'static' | 'dynamic'
  const mediaPresentationDuration = parseDuration(mpdEl.getAttribute('mediaPresentationDuration'))
  const minBufferTime = parseDuration(mpdEl.getAttribute('minBufferTime'))

  const mpdBaseUrl = resolveBaseURL(mpdEl)

  const contentProtections = extractContentProtections(mpdEl)

  const periods: MpdPeriod[] = []
  const periodEls = getChildrenNS(mpdEl, 'Period')
  if (periodEls.length === 0) {
    const fallbackPeriodEls = mpdEl.getElementsByTagName('Period')
    const limit = Math.min(fallbackPeriodEls.length, MAX_PERIODS)
    for (let i = 0; i < limit; i++) {
      periods.push(parsePeriod(fallbackPeriodEls[i]!, mpdBaseUrl))
    }
  } else {
    const limit = Math.min(periodEls.length, MAX_PERIODS)
    for (let i = 0; i < limit; i++) {
      periods.push(parsePeriod(periodEls[i]!, mpdBaseUrl))
    }
  }

  const baseUrl = url ?? mpdBaseUrl ?? undefined

  return {
    type: 'mpd-xml',
    mpdType,
    ...(mediaPresentationDuration !== undefined ? { mediaPresentationDuration } : {}),
    ...(minBufferTime !== undefined ? { minBufferTime } : {}),
    periods,
    contentProtections,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    rawXml: xmlText,
  }
}

function parsePeriod(periodEl: Element, mpdBaseUrl: string | null): MpdPeriod {
  const id = periodEl.getAttribute('id') || undefined
  const start = parseDuration(periodEl.getAttribute('start'))
  const duration = parseDuration(periodEl.getAttribute('duration'))
  const xlinkHref = periodEl.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || undefined

  const periodBaseUrl = resolveBaseURL(periodEl) ?? mpdBaseUrl

  const adaptations: MpdAdaptation[] = []
  const adaptEls = getChildrenNS(periodEl, 'AdaptationSet')
  if (adaptEls.length === 0) {
    const fallbackAdaptEls = periodEl.getElementsByTagName('AdaptationSet')
    for (let i = 0; i < fallbackAdaptEls.length; i++) {
      adaptations.push(parseAdaptation(fallbackAdaptEls[i]!, periodBaseUrl))
    }
  } else {
    for (const aEl of adaptEls) {
      adaptations.push(parseAdaptation(aEl, periodBaseUrl))
    }
  }

  const eventStreams: MpdEventStream[] = []
  const esEls = getChildrenNS(periodEl, 'EventStream')
  if (esEls.length === 0) {
    const fallbackEsEls = periodEl.getElementsByTagName('EventStream')
    for (let i = 0; i < fallbackEsEls.length; i++) {
      eventStreams.push(parseEventStream(fallbackEsEls[i]!))
    }
  } else {
    for (const esEl of esEls) {
      eventStreams.push(parseEventStream(esEl))
    }
  }

  return {
    ...(id !== undefined ? { id } : {}),
    ...(start !== undefined ? { start } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(xlinkHref !== undefined ? { xlinkHref } : {}),
    adaptations,
    ...(eventStreams.length > 0 ? { eventStreams } : {}),
    ...(periodBaseUrl != null ? { baseUrl: periodBaseUrl } : {}),
  }
}

function parseAdaptation(adaptEl: Element, periodBaseUrl: string | null): MpdAdaptation {
  const id = adaptEl.getAttribute('id') || undefined
  const mimeType = adaptEl.getAttribute('mimeType') || undefined
  const contentType = adaptEl.getAttribute('contentType') || undefined
  const lang = adaptEl.getAttribute('lang') || undefined

  const adaptBaseUrl = resolveBaseURL(adaptEl) ?? periodBaseUrl

  const segmentTemplate = extractSegmentTemplate(adaptEl)

  const representations: MpdRepresentation[] = []
  const repEls = getChildrenNS(adaptEl, 'Representation')
  if (repEls.length === 0) {
    const fallbackRepEls = adaptEl.getElementsByTagName('Representation')
    for (let i = 0; i < fallbackRepEls.length; i++) {
      representations.push(parseRepresentation(fallbackRepEls[i]!, adaptBaseUrl))
    }
  } else {
    for (const rEl of repEls) {
      representations.push(parseRepresentation(rEl, adaptBaseUrl))
    }
  }

  return {
    ...(id !== undefined ? { id } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(contentType !== undefined ? { contentType } : {}),
    ...(lang !== undefined ? { lang } : {}),
    representations,
    ...(segmentTemplate !== undefined ? { segmentTemplate } : {}),
    ...(adaptBaseUrl != null ? { baseUrl: adaptBaseUrl } : {}),
  }
}

function parseRepresentation(repEl: Element, adaptBaseUrl: string | null): MpdRepresentation {
  const id = repEl.getAttribute('id') ?? ''
  const bandwidth = parseInt(repEl.getAttribute('bandwidth') ?? '0', 10)
  const width = optionalInt(repEl.getAttribute('width'))
  const height = optionalInt(repEl.getAttribute('height'))
  const codecs = repEl.getAttribute('codecs') || undefined
  const mimeType = repEl.getAttribute('mimeType') || undefined

  const repBaseUrl = resolveBaseURL(repEl) ?? adaptBaseUrl

  const segmentBase = extractSegmentBase(repEl)
  const segmentTemplate = extractSegmentTemplate(repEl)

  return {
    id,
    bandwidth,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(codecs !== undefined ? { codecs } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(segmentBase !== undefined ? { segmentBase } : {}),
    ...(segmentTemplate !== undefined ? { segmentTemplate } : {}),
    ...(repBaseUrl != null ? { baseUrl: repBaseUrl } : {}),
  }
}

function parseEventStream(esEl: Element): MpdEventStream {
  const schemeIdUri = esEl.getAttribute('schemeIdUri') ?? ''
  const value = esEl.getAttribute('value') || undefined

  const events: MpdEventStream['events'] = []
  const eventEls = getChildrenNS(esEl, 'Event')
  if (eventEls.length === 0) {
    const fallbackEventEls = esEl.getElementsByTagName('Event')
    for (let i = 0; i < fallbackEventEls.length; i++) {
      events.push(parseEvent(fallbackEventEls[i]!))
    }
  } else {
    for (const eEl of eventEls) {
      events.push(parseEvent(eEl))
    }
  }

  return {
    schemeIdUri,
    ...(value !== undefined ? { value } : {}),
    events,
  }
}

function parseEvent(eventEl: Element): MpdEventStream['events'][number] {
  const presentationTime = optionalInt(eventEl.getAttribute('presentationTime'))
  const duration = optionalInt(eventEl.getAttribute('duration'))
  const id = optionalInt(eventEl.getAttribute('id'))
  const content = eventEl.textContent || undefined

  return {
    ...(presentationTime !== undefined ? { presentationTime } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(content !== undefined ? { content } : {}),
  }
}

function extractSegmentBase(parentEl: Element): SegmentBaseInfo | undefined {
  const sbEl = getChildrenNS(parentEl, 'SegmentBase')[0]
    ?? parentEl.getElementsByTagName('SegmentBase')[0]
  if (!sbEl) return undefined

  const initEl = getChildrenNS(sbEl, 'Initialization')[0]
    ?? sbEl.getElementsByTagName('Initialization')[0]

  const initialization = initEl?.getAttribute('sourceURL')
    ?? initEl?.getAttribute('range')
    ?? ''

  const indexRangeEl = getChildrenNS(sbEl, 'SegmentList')[0]
    ?? sbEl.getElementsByTagName('RepresentationIndex')[0]
  const indexRange = indexRangeEl?.getAttribute('range') ?? undefined

  return {
    initialization,
    ...(indexRange !== undefined ? { indexRange } : {}),
  }
}

function extractSegmentTemplate(parentEl: Element): SegmentTemplateInfo | undefined {
  const stEl = getChildrenNS(parentEl, 'SegmentTemplate')[0]
    ?? parentEl.getElementsByTagName('SegmentTemplate')[0]
  if (!stEl) return undefined

  const media = stEl.getAttribute('media') || undefined
  const initialization = stEl.getAttribute('initialization') || undefined
  const timescale = optionalInt(stEl.getAttribute('timescale'))
  const duration = optionalInt(stEl.getAttribute('duration'))
  const startNumber = optionalInt(stEl.getAttribute('startNumber'))

  const timeline: SegmentTimelineEntry[] = []
  const stlEl = getChildrenNS(stEl, 'SegmentTimeline')[0]
    ?? stEl.getElementsByTagName('SegmentTimeline')[0]
  if (stlEl) {
    const sEls = getChildrenNS(stlEl, 'S')
    if (sEls.length === 0) {
      const fallbackSEls = stlEl.getElementsByTagName('S')
      for (let i = 0; i < fallbackSEls.length; i++) {
        timeline.push(parseS(fallbackSEls[i]!))
      }
    } else {
      for (const sEl of sEls) {
        timeline.push(parseS(sEl))
      }
    }
  }

  if (!media && !initialization) return undefined

  return {
    ...(media !== undefined ? { media } : {}),
    ...(initialization !== undefined ? { initialization } : {}),
    ...(timescale !== undefined ? { timescale } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(startNumber !== undefined ? { startNumber } : {}),
    ...(timeline.length > 0 ? { segmentTimeline: timeline } : {}),
  }
}

function parseS(sEl: Element): SegmentTimelineEntry {
  const t = parseInt(sEl.getAttribute('t') ?? '0', 10)
  const d = parseInt(sEl.getAttribute('d') ?? '0', 10)
  const r = optionalInt(sEl.getAttribute('r'))
  return { t, d, ...(r !== undefined ? { r } : {}) }
}

function extractContentProtections(parentEl: Element): ContentProtectionInfo[] {
  const result: ContentProtectionInfo[] = []
  const cpEls = parentEl.getElementsByTagNameNS(DASH_NS, 'ContentProtection')
  if (cpEls.length === 0) {
    const fallbackCpEls = parentEl.getElementsByTagName('ContentProtection')
    for (let i = 0; i < fallbackCpEls.length; i++) {
      result.push(parseContentProtection(fallbackCpEls[i]!))
    }
  } else {
    for (const cpEl of cpEls) {
      result.push(parseContentProtection(cpEl))
    }
  }
  return result
}

function parseContentProtection(cpEl: Element): ContentProtectionInfo {
  const schemeIdUri = cpEl.getAttribute('schemeIdUri') ?? ''
  const value = cpEl.getAttribute('value') || undefined

  const cencPsshEl = cpEl.getElementsByTagNameNS('urn:mpeg:cenc:2013', 'pssh')[0]
    ?? cpEl.getElementsByTagName('cenc:pssh')[0]
  const cencPssh = cencPsshEl?.textContent || undefined

  return {
    schemeIdUri,
    ...(value !== undefined ? { value } : {}),
    ...(cencPssh !== undefined ? { cencPssh } : {}),
  }
}

function resolveBaseURL(parentEl: Element): string | null {
  const buEls = getChildrenNS(parentEl, 'BaseURL')
  if (buEls.length === 0) {
    const fallback = parentEl.getElementsByTagName('BaseURL')
    return fallback.length > 0 ? (fallback[0]!.textContent?.trim() || null) : null
  }
  return buEls[0]!.textContent?.trim() || null
}

function getChildrenNS(parent: Element, localName: string): Element[] {
  const result: Element[] = []
  const nsChildren = parent.getElementsByTagNameNS(DASH_NS, localName)
  for (let i = 0; i < nsChildren.length; i++) {
    result.push(nsChildren[i]!)
  }
  return result
}

function optionalInt(val: string | null): number | undefined {
  if (val === null || val === '') return undefined
  const n = parseInt(val, 10)
  return isNaN(n) ? undefined : n
}

/**
 * 解析 ISO 8601 duration 格式: PT[H]H[M]M[S[.frac]]S
 * 例如: PT0H0M30.000S → 30, PT1M15S → 75
 */
export function parseDuration(val: string | null): number | undefined {
  if (!val) return undefined

  const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(val)
  if (!match) return undefined

  const hours = parseFloat(match[1] ?? '0')
  const minutes = parseFloat(match[2] ?? '0')
  const seconds = parseFloat(match[3] ?? '0')

  return hours * 3600 + minutes * 60 + seconds
}