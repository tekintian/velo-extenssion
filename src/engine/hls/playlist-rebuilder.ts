import type { AdFilterConfig, ParsedPlaylist } from './types'

function absolutizeUrlsInTag(tag: string, baseUrl: string): string {
  return tag.replace(/URI="([^"]+)"/g, (_m, rel: string) => {
    try {
      return `URI="${new URL(rel, baseUrl).href}"`
    } catch {
      return `URI="${rel}"`
    }
  })
}

export function rebuildPlaylist(
  parsed: ParsedPlaylist,
  adSet: Set<number>,
  baseUrl: string,
  config: AdFilterConfig,
): string {
  const out: string[] = ['#EXTM3U']

  let maxDur = 0
  for (const s of parsed.segments) {
    if (!adSet.has(s.index) && s.duration > maxDur) maxDur = s.duration
  }

  for (const h of parsed.headerTags) {
    if (h.startsWith('#EXT-X-TARGETDURATION')) continue
    if (h.startsWith('#EXT-X-MEDIA-SEQUENCE')) continue
    if (h.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) continue
    if (h.startsWith('#EXT-X-KEY') || h.startsWith('#EXT-X-MAP')) {
      out.push(absolutizeUrlsInTag(h, baseUrl))
    } else {
      out.push(h)
    }
  }

  out.push(`#EXT-X-TARGETDURATION:${Math.ceil(maxDur)}`)
  out.push('#EXT-X-MEDIA-SEQUENCE:0')
  out.push('#EXT-X-DISCONTINUITY-SEQUENCE:0')

  let prevWasAd = false
  let firstContent = true
  for (const s of parsed.segments) {
    if (adSet.has(s.index)) {
      prevWasAd = true
      continue
    }
    if (firstContent) {
      if (s.discontinuity) out.push('#EXT-X-DISCONTINUITY')
    } else if (prevWasAd && config.keepDiscontinuityOnGap !== false) {
      out.push('#EXT-X-DISCONTINUITY')
    } else if (s.discontinuity) {
      out.push('#EXT-X-DISCONTINUITY')
    }
    out.push(`#EXTINF:${s.duration}${s.title ? `,${s.title}` : ''}`)
    if (s.byterange) out.push(`#EXT-X-BYTERANGE:${s.byterange}`)
    out.push(s.url)
    prevWasAd = false
    firstContent = false
  }

  out.push('#EXT-X-ENDLIST')
  return out.join('\n')
}
