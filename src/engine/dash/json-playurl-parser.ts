/**
 * JSON Playurl 解析器（模式 B — B站 playurl / YouTube player API）
 *
 * 将不同平台的 JSON 响应标准化为统一的 JsonPlayurlManifest 结构。
 */

import type {
  JsonPlayurlManifest,
  PlayurlTrack,
  PlayurlSource,
  SegmentBaseInfo,
} from './types'

export function detectPlayurlSource(json: unknown, url: string): PlayurlSource {
  if (/youtubei\/v\d+\/player/i.test(url) || /youtube\.com\/player/i.test(url)) {
    return 'youtube-player'
  }
  if (/playurl/i.test(url) || /bilibili/i.test(url)) {
    return 'bili-playurl'
  }
  if (typeof json === 'object' && json !== null) {
    const obj = json as Record<string, unknown>
    if ('streamingData' in obj || 'adaptiveFormats' in obj) return 'youtube-player'
    if ('data' in obj) {
      const data = (obj as { data: unknown }).data
      if (typeof data === 'object' && data !== null && 'dash' in (data as object)) return 'bili-playurl'
    }
    if ('dash' in obj) return 'bili-playurl'
  }
  return 'unknown'
}

export function parseJsonPlayurl(rawText: string, url: string): JsonPlayurlManifest {
  let json: unknown
  try {
    json = JSON.parse(rawText)
  } catch {
    throw new Error('Invalid JSON')
  }

  const source = detectPlayurlSource(json, url)

  switch (source) {
    case 'bili-playurl':
      return parseBiliPlayurl(json, rawText)
    case 'youtube-player':
      return parseYoutubePlayer(json, rawText)
    default:
      return parseGenericDashJson(json, rawText)
  }
}

function parseBiliPlayurl(json: unknown, rawText: string): JsonPlayurlManifest {
  const root = json as Record<string, unknown>
  const data = (root.data ?? root) as Record<string, unknown>
  const dash = (data.dash ?? data) as Record<string, unknown>

  const duration = typeof dash.duration === 'number' ? dash.duration : 0
  const minBufferTime = typeof dash.minBufferTime === 'number' ? dash.minBufferTime : undefined

  const videoArr = Array.isArray(dash.video) ? dash.video : []
  const audioArr = Array.isArray(dash.audio) ? dash.audio : []

  const tracks: PlayurlTrack[] = []

  for (const v of videoArr) {
    const item = v as Record<string, unknown>
    tracks.push(normalizeBiliTrack(item, 'video'))
  }

  for (const a of audioArr) {
    const item = a as Record<string, unknown>
    tracks.push(normalizeBiliTrack(item, 'audio'))
  }

  return {
    type: 'json-playurl',
    source: 'bili-playurl',
    duration,
    ...(minBufferTime !== undefined ? { minBufferTime } : {}),
    tracks,
    raw: JSON.parse(rawText),
  }
}

function normalizeBiliTrack(item: Record<string, unknown>, kind: 'video' | 'audio'): PlayurlTrack {
  const id = kind === 'video' ? `v:${item.id}` : `a:${item.id}`
  const baseUrl = typeof item.baseUrl === 'string' ? item.baseUrl : ''
  const backupUrls = Array.isArray(item.backupUrl)
    ? (item.backupUrl as unknown[]).filter((u): u is string => typeof u === 'string')
    : undefined

  let segmentBase: SegmentBaseInfo | undefined
  const sb = item.SegmentBase as Record<string, unknown> | undefined
  if (sb && typeof sb.Initialization === 'string') {
    const indexRange = typeof sb.indexRange === 'string' ? sb.indexRange : undefined
    segmentBase = {
      initialization: sb.Initialization,
      ...(indexRange !== undefined ? { indexRange } : {}),
    }
  }

  const codecs = typeof item.codecs === 'string' ? item.codecs : undefined
  const width = typeof item.width === 'number' ? item.width : undefined
  const height = typeof item.height === 'number' ? item.height : undefined
  const frameRate = typeof item.frameRate === 'string' ? item.frameRate : undefined

  return {
    id,
    kind,
    bandwidth: typeof item.bandwidth === 'number' ? item.bandwidth : 0,
    mimeType: typeof item.mimeType === 'string' ? item.mimeType : `${kind}/mp4`,
    ...(codecs !== undefined ? { codecs } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(frameRate !== undefined ? { frameRate } : {}),
    baseUrl,
    ...(backupUrls !== undefined ? { backupUrls } : {}),
    ...(segmentBase !== undefined ? { segmentBase } : {}),
    metadata: { ...item },
  }
}

function parseYoutubePlayer(json: unknown, rawText: string): JsonPlayurlManifest {
  const root = json as Record<string, unknown>
  const playability = root.playabilityStatus as Record<string, unknown> | undefined
  const streamingData = (root.streamingData ?? playability?.streamingData ?? root) as Record<string, unknown>

  const formats = [
    ...(Array.isArray(streamingData.formats) ? streamingData.formats : []),
    ...(Array.isArray(streamingData.adaptiveFormats) ? streamingData.adaptiveFormats : []),
  ]

  const tracks: PlayurlTrack[] = []
  let duration = typeof root.lengthSeconds === 'number' ? root.lengthSeconds : 0
  if (typeof root.videoDetails === 'object' && root.videoDetails !== null) {
    const details = root.videoDetails as Record<string, unknown>
    if (typeof details.lengthSeconds === 'number') duration = details.lengthSeconds
  }

  for (const f of formats) {
    const item = f as Record<string, unknown>
    const mimeType = typeof item.mimeType === 'string' ? item.mimeType : ''
    const kind = mimeType.startsWith('audio/') ? 'audio' : 'video'
    const itag = typeof item.itag === 'number' ? item.itag : 0

    let segmentBase: SegmentBaseInfo | undefined
    const initRange = item.initRange as Record<string, unknown> | undefined
    if (initRange && typeof initRange.start === 'string' && typeof initRange.end === 'string') {
      const sbInit = `${initRange.start}-${initRange.end}`
      const indexRangeObj = item.indexRange as Record<string, unknown> | undefined
      const sbIndex = (indexRangeObj && typeof indexRangeObj.start === 'string' && typeof indexRangeObj.end === 'string')
        ? `${indexRangeObj.start}-${indexRangeObj.end}`
        : undefined
      segmentBase = {
        initialization: sbInit,
        ...(sbIndex !== undefined ? { indexRange: sbIndex } : {}),
      }
    }

    const ytCodecs = typeof item.codecs === 'string' ? item.codecs : undefined
    const ytWidth = typeof item.width === 'number' ? item.width : undefined
    const ytHeight = typeof item.height === 'number' ? item.height : undefined

    tracks.push({
      id: `yt:${itag}`,
      kind,
      bandwidth: typeof item.bitrate === 'number' ? item.bitrate : 0,
      mimeType,
      ...(ytCodecs !== undefined ? { codecs: ytCodecs } : {}),
      ...(ytWidth !== undefined ? { width: ytWidth } : {}),
      ...(ytHeight !== undefined ? { height: ytHeight } : {}),
      baseUrl: typeof item.url === 'string' ? item.url : '',
      ...(segmentBase !== undefined ? { segmentBase } : {}),
      metadata: { ...item },
    })
  }

  return {
    type: 'json-playurl',
    source: 'youtube-player',
    duration,
    tracks,
    raw: JSON.parse(rawText),
  }
}

function parseGenericDashJson(json: unknown, rawText: string): JsonPlayurlManifest {
  const root = json as Record<string, unknown>

  const videoArr = Array.isArray(root.video) ? root.video : []
  const audioArr = Array.isArray(root.audio) ? root.audio : []

  const tracks: PlayurlTrack[] = []
  for (const v of videoArr) {
    const item = v as Record<string, unknown>
    tracks.push({
      id: `v:${item.id ?? tracks.length}`,
      kind: 'video',
      bandwidth: typeof item.bandwidth === 'number' ? item.bandwidth : 0,
      mimeType: typeof item.mimeType === 'string' ? item.mimeType : 'video/mp4',
      baseUrl: typeof item.baseUrl === 'string' ? item.baseUrl : '',
      metadata: { ...item },
    })
  }
  for (const a of audioArr) {
    const item = a as Record<string, unknown>
    tracks.push({
      id: `a:${item.id ?? tracks.length}`,
      kind: 'audio',
      bandwidth: typeof item.bandwidth === 'number' ? item.bandwidth : 0,
      mimeType: typeof item.mimeType === 'string' ? item.mimeType : 'audio/mp4',
      baseUrl: typeof item.baseUrl === 'string' ? item.baseUrl : '',
      metadata: { ...item },
    })
  }

  return {
    type: 'json-playurl',
    source: 'unknown',
    duration: typeof root.duration === 'number' ? root.duration : 0,
    tracks,
    raw: JSON.parse(rawText),
  }
}