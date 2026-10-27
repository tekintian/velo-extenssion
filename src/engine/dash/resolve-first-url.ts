/**
 * 广告轨/Period 首分片 URL 解析
 *
 * 用于指纹计算：取广告轨的首个分片 URL，交给 shared/fingerprint 计算 SHA-256。
 *
 * 三种场景：
 *   - SegmentBase（B站）：baseUrl 本身就是 init 段 URL
 *   - SegmentTemplate（YouTube / MPD XML）：拼接 BaseURL + template
 *   - 直接 URL（通用）：baseUrl 直接使用
 */

import type { PlayurlTrack, MpdPeriod, MpdManifest } from './types'

export interface ResolvedUrl {
  url: string
  headers?: Record<string, string>
}

/**
 * 解析 JSON Playurl 轨的首分片 URL
 */
export function resolveTrackFirstSegmentUrl(
  track: PlayurlTrack,
  manifestBaseUrl?: string,
): ResolvedUrl | null {
  if (track.segmentTemplate) {
    return resolveSegmentTemplateUrl(track.segmentTemplate, track, track.baseUrl || manifestBaseUrl)
  }

  if (!track.baseUrl && !manifestBaseUrl) return null

  if (track.segmentBase) {
    const url = track.baseUrl || manifestBaseUrl || ''
    if (!url) return null

    const init = track.segmentBase.initialization
    if (init && /^\d+-\d+$/.test(init)) {
      return {
        url,
        headers: { Range: `bytes=${init.replace('-', '-')}` },
      }
    }

    return { url }
  }

  if (track.baseUrl) {
    return { url: track.baseUrl }
  }

  return null
}

/**
 * 解析 MPD XML Period 的首分片 URL
 *
 * 选最高带宽 Representation 做指纹（质量最稳定）
 */
export function resolvePeriodFirstSegmentUrl(
  period: MpdPeriod,
  mpd: MpdManifest,
): ResolvedUrl | null {
  const allReps: Array<{ rep: import('./types').MpdRepresentation; adapt: import('./types').MpdAdaptation }> = []

  for (const adapt of period.adaptations) {
    for (const rep of adapt.representations) {
      allReps.push({ rep, adapt })
    }
  }

  if (allReps.length === 0) return null

  const videoReps = allReps.filter((r) => r.rep.mimeType?.startsWith('video/') || r.adapt.contentType === 'video' || r.adapt.mimeType?.startsWith('video/'))
  const candidates = videoReps.length > 0 ? videoReps : allReps

  candidates.sort((a, b) => b.rep.bandwidth - a.rep.bandwidth)
  const best = candidates[0]!

  const baseUrl = mpd.baseUrl || period.baseUrl || best.adapt.baseUrl || best.rep.baseUrl || ''

  if (best.rep.segmentTemplate || best.adapt.segmentTemplate) {
    const template = best.rep.segmentTemplate || best.adapt.segmentTemplate!
    return resolveSegmentTemplateUrl(template, best.rep, baseUrl)
  }

  if (best.rep.segmentBase) {
    const url = best.rep.baseUrl || baseUrl
    if (!url) return null
    const init = best.rep.segmentBase.initialization
    if (init && /^\d+-\d+$/.test(init)) {
      return { url, headers: { Range: `bytes=${init}` } }
    }
    return { url }
  }

  if (best.rep.baseUrl) {
    return { url: best.rep.baseUrl }
  }

  if (baseUrl) {
    return { url: baseUrl }
  }

  return null
}

function resolveSegmentTemplateUrl(
  template: import('./types').SegmentTemplateInfo,
  context: { id?: string; codecs?: string; bandwidth?: number } | PlayurlTrack,
  baseUrl?: string,
): ResolvedUrl | null {
  let media = template.media
  if (!media) return null

  const repId = String((context as PlayurlTrack).id ?? (context as { id?: string }).id ?? '')
  const bw = (context as PlayurlTrack).bandwidth ?? (context as { bandwidth?: number }).bandwidth ?? 0

  media = media.replace(/\$RepresentationID\$/g, repId)
  media = media.replace(/\$Bandwidth\$/g, String(bw))

  if (template.segmentTimeline && template.segmentTimeline.length > 0) {
    const firstT = template.segmentTimeline[0]!.t
    media = media.replace(/\$Time\$/g, String(firstT))
  } else {
    media = media.replace(/\$Time\$/g, '0')
  }

  if (template.startNumber !== undefined) {
    media = media.replace(/\$Number\$/g, String(template.startNumber))
  } else {
    media = media.replace(/\$Number\$/g, '1')
  }

  const url = baseUrl ? new URL(media, baseUrl).href : media

  return { url }
}