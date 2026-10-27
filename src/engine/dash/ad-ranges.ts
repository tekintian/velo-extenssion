/**
 * DASH 广告时间区间提取
 *
 * 从 MpdManifest 或 JsonPlayurlManifest 中提取广告对应的时间区间，
 * 供 player-panel 显示跳过按钮使用。
 */

import type { MpdManifest, JsonPlayurlManifest, DashDetectionResult } from './types'
import type { AdRange } from '@engine/shared/types'

export function extractMpdAdRanges(
  mpd: MpdManifest,
  detection: DashDetectionResult,
): AdRange[] {
  const ranges: AdRange[] = []

  for (const periodId of detection.adTargetIds) {
    const period = mpd.periods.find((p) => p.id === periodId)
    if (!period) continue

    const start = period.start ?? 0
    const duration = period.duration ?? 0
    if (duration <= 0) continue

    ranges.push({
      start,
      end: start + duration,
      duration,
    })
  }

  ranges.sort((a, b) => a.start - b.start)
  return ranges
}

export function extractJsonAdRanges(
  manifest: JsonPlayurlManifest,
  detection: DashDetectionResult,
): AdRange[] {
  const ranges: AdRange[] = []

  const adTracks = manifest.tracks.filter((t) => detection.adTargetIds.has(t.id))
  if (adTracks.length === 0) return ranges

  const totalDuration = manifest.duration
  if (totalDuration <= 0) return ranges

  const adTrack = adTracks[0]!
  const contentTracks = manifest.tracks.filter((t) => !detection.adTargetIds.has(t.id) && t.kind === adTrack.kind)

  if (contentTracks.length === 0) {
    ranges.push({
      start: 0,
      end: totalDuration,
      duration: totalDuration,
    })
  } else {
    const adBandwidth = adTrack.bandwidth
    const avgContentBandwidth = contentTracks.reduce((s, t) => s + t.bandwidth, 0) / contentTracks.length

    if (adBandwidth > avgContentBandwidth * 3) {
      ranges.push({
        start: 0,
        end: Math.min(30, totalDuration),
        duration: Math.min(30, totalDuration),
      })
    } else {
      ranges.push({
        start: 0,
        end: totalDuration,
        duration: totalDuration,
      })
    }
  }

  return ranges
}