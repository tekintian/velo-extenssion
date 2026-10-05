import type { ParsedPlaylist, Segment } from './types'

export function extractSeqNum(url: string): number | null {
  const m = url.match(/(\d+)(?=\.\w+(?:\?|#|$))/)
  return m ? parseInt(m[1]!, 10) : null
}

export function isMasterPlaylist(text: string): boolean {
  return /#EXT-X-STREAM-INF:/i.test(text)
}

export function parseMasterPlaylist(
  text: string,
  baseUrl: string,
): Array<{ url: string; bandwidth: number; resolution: string | undefined }> {
  const lines = text.split(/\r?\n/)
  const variants: Array<{ url: string; bandwidth: number; resolution: string | undefined }> = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const next = lines[i + 1]?.trim()
      if (!next || next.startsWith('#')) continue
      const bwMatch = line.match(/BANDWIDTH=(\d+)/)
      const resMatch = line.match(/RESOLUTION=(\d+x\d+)/)
      let absUrl: string
      try {
        absUrl = new URL(next, baseUrl).href
      } catch {
        absUrl = next
      }
      variants.push({
        url: absUrl,
        bandwidth: bwMatch ? parseInt(bwMatch[1]!, 10) : 0,
        resolution: resMatch ? resMatch[1] : undefined,
      })
    }
  }
  return variants
}

export function parsePlaylist(text: string, baseUrl: string): ParsedPlaylist {
  const lines = text.split(/\r?\n/)
  const headerTags: string[] = []
  const segments: Segment[] = []
  let mediaSeqStart = 0

  if (lines.length === 0 || lines[0]!.trim() !== '#EXTM3U') {
    return { headerTags, segments, mediaSeqStart: 0 }
  }

  let pendingExtinf: { duration: number; title: string } | null = null
  let pendingByterange: string | null = null
  let pendingDiscontinuity = false
  let cueState: 'out' | null = null
  let pendingScte35: string | null = null
  let pendingDateRangeAd: string | null = null
  let segIndex = 0

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue

    if (line[0] === '#') {
      const colon = line.indexOf(':')
      const tagFull = colon > -1 ? line.slice(1, colon) : line.slice(1)
      const args = colon > -1 ? line.slice(colon + 1) : ''
      const tag = tagFull.toUpperCase()

      switch (tag) {
        case 'EXT-X-VERSION':
        case 'EXT-X-TARGETDURATION':
        case 'EXT-X-PLAYLIST-TYPE':
        case 'EXT-X-INDEPENDENT-SEGMENTS':
        case 'EXT-X-I-FRAMES-ONLY':
        case 'EXT-X-ALLOW-CACHE':
        case 'EXT-X-MEDIA-SEQUENCE':
          headerTags.push(line)
          if (tag === 'EXT-X-MEDIA-SEQUENCE') {
            mediaSeqStart = parseInt(args, 10) || 0
          }
          break
        case 'EXT-X-KEY':
        case 'EXT-X-MAP':
        case 'EXT-X-SESSION-DATA':
        case 'EXT-X-MEDIA':
          headerTags.push(line)
          break
        case 'EXTINF': {
          const comma = args.indexOf(',')
          pendingExtinf = {
            duration: parseFloat(comma > -1 ? args.slice(0, comma) : args) || 0,
            title: comma > -1 ? args.slice(comma + 1) : '',
          }
          break
        }
        case 'EXT-X-BYTERANGE':
          pendingByterange = args
          break
        case 'EXT-X-DISCONTINUITY':
          pendingDiscontinuity = true
          break
        case 'EXT-X-DISCONTINUITY-SEQUENCE':
          headerTags.push(line)
          break
        case 'EXT-X-CUE-OUT':
        case 'EXT-X-CUE-OUT-CONT':
          cueState = 'out'
          break
        case 'EXT-X-CUE-IN':
          cueState = null
          pendingScte35 = null
          pendingDateRangeAd = null
          break
        case 'EXT-X-SCTE35-OUT':
        case 'EXT-X-SCTE35-CMD':
          pendingScte35 = args
          cueState = 'out'
          break
        case 'EXT-X-SCTE35-IN':
          pendingScte35 = null
          cueState = null
          break
        case 'EXT-X-DATERANGE':
          if (
            /CLASS="[^"]*(?:com\.apple\.ad|ad|sponsor|promo|spot)[^"]*"/i.test(args) ||
            /SCTE35-(OUT|CMD)=/i.test(args)
          ) {
            pendingDateRangeAd = args
            cueState = 'out'
          }
          break
        default:
          break
      }
    } else {
      let absUrl: string
      try {
        absUrl = new URL(line, baseUrl).href
      } catch {
        absUrl = line
      }
      segments.push({
        index: segIndex++,
        url: absUrl,
        duration: pendingExtinf ? pendingExtinf.duration : 0,
        title: pendingExtinf ? pendingExtinf.title : '',
        byterange: pendingByterange,
        discontinuity: pendingDiscontinuity,
        cueState,
        scte35: pendingScte35,
        dateRangeAd: pendingDateRangeAd,
        seqNum: extractSeqNum(absUrl),
      })
      pendingExtinf = null
      pendingByterange = null
      pendingDiscontinuity = false
    }
  }

  return { headerTags, segments, mediaSeqStart }
}
