/**
 * JSON Playurl 重建器（模式 B — 从 video[]/audio[] 移除广告轨 + 重建 JSON）
 *
 * 只移除被判为广告的轨，保留所有其他字段不变。
 */

import type { JsonPlayurlManifest, PlayurlSource } from './types'

export interface RebuildResult {
  success: boolean
  cleanedJson: Record<string, unknown> | null
  removedTrackIds: string[]
  reason?: string
}

export function rebuildJsonPlayurl(
  manifest: JsonPlayurlManifest,
  adTrackIds: Set<string>,
): RebuildResult {
  if (adTrackIds.size === 0) {
    return { success: true, cleanedJson: null, removedTrackIds: [] }
  }

  const remaining = manifest.tracks.filter((t) => !adTrackIds.has(t.id))
  const removedTrackIds = manifest.tracks
    .filter((t) => adTrackIds.has(t.id))
    .map((t) => t.id)

  if (remaining.length === 0) {
    return {
      success: false,
      cleanedJson: null,
      removedTrackIds,
      reason: 'all-tracks-ad',
    }
  }

  const cleanedJson = rebuildRawJson(manifest.raw, remaining, manifest.source)

  return { success: true, cleanedJson, removedTrackIds }
}

function rebuildRawJson(
  raw: Record<string, unknown>,
  remainingTracks: import('./types').PlayurlTrack[],
  source: PlayurlSource,
): Record<string, unknown> {
  const result = structuredClone(raw)

  switch (source) {
    case 'bili-playurl':
      return rebuildBiliJson(result, remainingTracks)
    case 'youtube-player':
      return rebuildYoutubeJson(result, remainingTracks)
    default:
      return rebuildGenericJson(result, remainingTracks)
  }
}

function rebuildBiliJson(
  raw: Record<string, unknown>,
  remainingTracks: import('./types').PlayurlTrack[],
): Record<string, unknown> {
  const data = (raw.data ?? raw) as Record<string, unknown>
  const dash = (data.dash ?? data) as Record<string, unknown>

  const remainingVideo = remainingTracks.filter((t) => t.kind === 'video')
  const remainingAudio = remainingTracks.filter((t) => t.kind === 'audio')

  dash.video = remainingVideo.map((t) => t.metadata)
  dash.audio = remainingAudio.map((t) => t.metadata)

  if (raw.data && typeof raw.data === 'object') {
    ;(raw.data as Record<string, unknown>).dash = dash
  }

  return raw
}

function rebuildYoutubeJson(
  raw: Record<string, unknown>,
  remainingTracks: import('./types').PlayurlTrack[],
): Record<string, unknown> {
  const streamingData = (raw.streamingData ?? {}) as Record<string, unknown>

  const remainingVideo = remainingTracks.filter((t) => t.kind === 'video')
  const remainingAudio = remainingTracks.filter((t) => t.kind === 'audio')

  const videoFormats = remainingVideo.map((t) => t.metadata)
  const audioFormats = remainingAudio.map((t) => t.metadata)

  if (videoFormats.length > 0 && audioFormats.length > 0) {
    streamingData.formats = videoFormats.slice(0, 1)
    streamingData.adaptiveFormats = [...videoFormats, ...audioFormats]
  } else {
    streamingData.adaptiveFormats = [...videoFormats, ...audioFormats]
  }

  raw.streamingData = streamingData
  return raw
}

function rebuildGenericJson(
  raw: Record<string, unknown>,
  remainingTracks: import('./types').PlayurlTrack[],
): Record<string, unknown> {
  raw.video = remainingTracks.filter((t) => t.kind === 'video').map((t) => t.metadata)
  raw.audio = remainingTracks.filter((t) => t.kind === 'audio').map((t) => t.metadata)
  return raw
}