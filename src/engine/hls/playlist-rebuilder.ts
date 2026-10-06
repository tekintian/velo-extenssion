/**
 * 清洗后播放列表重建
 *
 * 移植自 NDM ad-filter.js rebuildPlaylist + absolutizeUrlsInTag
 *
 * 功能：
 *   - 剔除广告分片
 *   - 绝对化 URL（KEY/MAP 的 URI）
 *   - 重排 MEDIA-SEQUENCE / DISCONTINUITY-SEQUENCE 从 0 开始
 *   - 重算 TARGETDURATION
 *   - 在广告缺口处补 EXT-X-DISCONTINUITY（避免解码器花屏）
 */

import type { AdFilterConfig, ParsedPlaylist } from './types'

/**
 * 对 EXT-X-KEY / EXT-X-MAP 等标签内的 URI="..." 做绝对化
 */
function absolutizeUrlsInTag(tag: string, baseUrl: string): string {
  return tag.replace(/URI="([^"]+)"/g, (_m, rel: string) => {
    try {
      return `URI="${new URL(rel, baseUrl).href}"`
    } catch {
      return `URI="${rel}"`
    }
  })
}

/**
 * 重建清洗后的 m3u8 文本
 */
export function rebuildPlaylist(
  parsed: ParsedPlaylist,
  adSet: Set<number>,
  baseUrl: string,
  config: AdFilterConfig,
): string {
  const out: string[] = ['#EXTM3U']

  // 1) 计算内容分片的最大时长 → 重算 TARGETDURATION
  let maxDur = 0
  for (const s of parsed.segments) {
    if (!adSet.has(s.index) && s.duration > maxDur) maxDur = s.duration
  }

  // 2) 重新输出头标签（KEY/MAP 绝对化，跳过原 TARGETDURATION/MEDIA-SEQUENCE/DISCONTINUITY-SEQUENCE）
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

  // 3) 输出内容分片；在广告缺口处补 EXT-X-DISCONTINUITY
  let prevWasAd = false
  let firstContent = true
  for (const s of parsed.segments) {
    if (adSet.has(s.index)) {
      prevWasAd = true
      continue // 跳过广告分片
    }
    if (firstContent) {
      // 第一片内容：若其本身原本带 DISCONTINUITY 则保留
      if (s.discontinuity) out.push('#EXT-X-DISCONTINUITY')
    } else if (prevWasAd && config.keepDiscontinuityOnGap !== false) {
      // 紧跟广告缺口之后：强制补 DISCONTINUITY 帮助解码器重同步
      out.push('#EXT-X-DISCONTINUITY')
    } else if (s.discontinuity) {
      out.push('#EXT-X-DISCONTINUITY')
    }
    out.push(`#EXTINF:${s.duration}${s.title ? `,${s.title}` : ''}`)
    if (s.byterange) out.push(`#EXT-X-BYTERANGE:${s.byterange}`)
    out.push(s.url) // 已是绝对 URL
    prevWasAd = false
    firstContent = false
  }

  out.push('#EXT-X-ENDLIST')
  return out.join('\n')
}
