/**
 * YouTube itag → 分辨率 / 容器映射表
 *
 * 严格移植自 NDM ct.js（NeatDownloadManager Extension）的 `D` / `E` / `d` 三张表：
 *   - D: adaptive 视频 itag → 分辨率字符串（用于 DASH 视频轨识别 + 文件名标签）
 *   - E: adaptive 音频 itag 集合（用于 DASH 音频轨识别）
 *   - d: 非自适应（progressive）combined itag → { 容器, 分辨率 }（用于 YouTube watch
 *        页 `<script>` 内嵌 `"formats"` 数组解析：单一文件即包含音视频）
 *
 * ## itag 背景知识
 * YouTube 用 itag 数字标识每种编码格式。itag 在 URL 的 `?itag=` 参数中携带，
 * 是 YouTube 资源最稳定的指纹。itag 数字含义示例：
 *   - 18  → mp4 / 360p / H.264 + AAC（progressive，单一文件）
 *   - 22  → mp4 / 720p / H.264 + AAC（progressive）
 *   - 137 → mp4 / 1080p / H.264 video-only（adaptive）
 *   - 251 → webm / audio-only / Opus（adaptive）
 *
 * ## 三种使用场景（与 NDM bg.js + ct.js 对齐）
 *
 * ### 1. bg.js 的 W(b=true) 分支（adaptive，DASH 配对）
 * 触发条件：从 watch 页 `"adaptiveFormats"` 数组解析出的条目
 * URL 必须含 `signature=` 或 `sig=`（已签名 URL，可直接下载）
 * 必须有 `dur` 参数（用于配对时间窗口）
 * 视频轨 itag 必须在 `D` 表中 → 推送为 `{ mme: "video", ig: itag, du: dur, ... }`
 * 音频轨 itag 必须在 `E` 数组中 → 推送为 `{ mme: "audio", ig: itag, du: dur, ... }`
 * 后续通过 ei（mK 字段）配对 video+audio → 合并下载为 MKV
 *
 * ### 2. bg.js 的 W(b=false) 分支（progressive，combined）
 * 触发条件：从 watch 页 `"formats"` 数组解析出的条目
 * itag 必须在 `d` 表中 → 推送为 `{ fEx: "MP4", 4: "MP4 File " + 分辨率 + ", " + 时长 }`
 * 单文件即包含音视频，无需配对
 *
 * ### 3. bg.js 的 W(b=true) + YouTube player API POST 触发
 * 当 YouTube iframe 内的 player API 发起 POST `/youtubei/v1/player`（pathname ends with "player"）
 * 时，从 POST body 提取 videoId → fetch `https://www.youtube.com/watch?v=${videoId}` →
 * 在返回的 HTML 中正则提取 `"formats":[...]` 与 `"adaptiveFormats":[...]` →
 * 分别调用 W(b=false) / W(b=true) 解析。
 *
 * ## 与 NDM bg.js 行为的差异
 * NDM bg.js 通过 port.postMessage([7, formatsArray, isAdaptive]) 把解析出的数组发给 ct.js，
 * 由 ct.js 的 W() 函数做最终解析。
 * velo-extension 直接在 background 内完成解析（避免与 content script 的来回通信），
 * 但解析逻辑（正则、itag 过滤）严格保持一致。
 */

/**
 * Adaptive 视频 itag → 分辨率字符串
 *
 * 仅 DASH 视频轨（无音频）。NDM ct.js `D` 表 16 项原样移植。
 *
 * 用途：
 *   - bg.js W(b=true): itag 必须在 D 中才视为有效视频轨
 *   - 文件名标签: `MKV File ${D[itag]}, ${duration}`
 */
export const YOUTUBE_ADAPTIVE_VIDEO_ITAGS: Readonly<Record<number, string>> = Object.freeze({
  242: '240p',
  243: '360p',
  244: '480p',
  246: '480p',
  247: '720p',
  248: '1080p',
  271: '1440p',
  272: '2160p',
  278: '144p',
  302: '720p',
  303: '1080p',
  308: '1440p',
  335: '1080p',
  336: '1440p',
  337: '2160p',
})

/**
 * Adaptive 音频 itag 集合
 *
 * 仅 DASH 音频轨（无视频）。NDM ct.js `E` 数组 5 项原样移植。
 *
 * 用途：bg.js W(b=true) 通过 `E.indexOf(q) < 0` 判定 itag 是否为音频轨。
 *
 * 设计为 Set 以 O(1) 查询；D 表为 Record 因需查值（分辨率字符串）。
 */
export const YOUTUBE_ADAPTIVE_AUDIO_ITAGS: ReadonlySet<number> = new Set([
  171,
  172,
  249,
  250,
  251,
])

/**
 * Progressive（combined）itag → 容器 + 分辨率
 *
 * 单一文件即包含视频+音频，无需 DASH 配对。NDM ct.js `d` 表 8 项原样移植。
 *
 * 用途：bg.js W(b=false) 通过 `d[q]` 查询；找不到的 itag 跳过。
 *
 * 注：所有 8 项容器均为 MP4（与 NDM 一致；其它 progressive itag 如 43/webm 不在表中，
 * 因为 NDM 仅嗅探 MP4 容器的 progressive 流）。
 */
export interface ProgressiveItagInfo {
  /** 容器扩展名（大写） */
  readonly container: string
  /** 分辨率字符串（如 "360p"） */
  readonly resolution: string
}

export const YOUTUBE_PROGRESSIVE_ITAGS: Readonly<Record<number, ProgressiveItagInfo>> = Object.freeze({
  18: { container: 'MP4', resolution: '360p' },
  22: { container: 'MP4', resolution: '720p' },
  37: { container: 'MP4', resolution: '1080p' },
  38: { container: 'MP4', resolution: '1080p' },
  82: { container: 'MP4', resolution: '360p' },
  84: { container: 'MP4', resolution: '720p' },
  132: { container: 'MP4', resolution: '240p' },
  151: { container: 'MP4', resolution: '144p' },
})

/**
 * 判断 itag 是否为 adaptive 视频轨
 *
 * 等价 NDM ct.js `D[q]` 真值检查。
 */
export function isAdaptiveVideoItag(itag: number): boolean {
  return itag in YOUTUBE_ADAPTIVE_VIDEO_ITAGS
}

/**
 * 判断 itag 是否为 adaptive 音频轨
 *
 * 等价 NDM ct.js `0 > E.indexOf(q)` 的反向。
 */
export function isAdaptiveAudioItag(itag: number): boolean {
  return YOUTUBE_ADAPTIVE_AUDIO_ITAGS.has(itag)
}

/**
 * 获取 adaptive 视频 itag 的分辨率字符串
 *
 * @returns 分辨率字符串（如 "1080p"）；非视频轨 itag 返回 undefined
 */
export function getAdaptiveVideoResolution(itag: number): string | undefined {
  return YOUTUBE_ADAPTIVE_VIDEO_ITAGS[itag]
}

/**
 * 从 URL query 参数中提取 itag 数字
 *
 * 用于 DASH itag→分辨率标签（task #14）：
 * 在 player-panel 渲染 DASH 配对项时调用，从 video.m4s URL 中提取 itag，
 * 查 YOUTUBE_ADAPTIVE_VIDEO_ITAGS 表得到分辨率字符串，作为「合并下载」按钮的副标题。
 *
 * 支持两种 URL 格式：
 *   - YouTube watch 页 formats（query 含 itag=N）
 *   - GoogleVideo /videoplayback?...&itag=N&...（query 含 itag=N）
 *
 * @param url 媒体 URL
 * @returns itag 数字（解析失败返回 0）
 */
export function extractItagFromUrl(url: string): number {
  if (!url) return 0
  try {
    const qIdx = url.indexOf('?')
    if (qIdx < 0) return 0
    const query = url.slice(qIdx + 1)
    for (const part of query.split('&')) {
      if (part.startsWith('itag=')) {
        const v = part.slice(5).split('#')[0] ?? ''
        const n = parseInt(v, 10)
        return Number.isFinite(n) ? n : 0
      }
    }
  } catch {
    // ignore
  }
  return 0
}

/**
 * 解析 itag → 人类可读分辨率标签
 *
 * 用于 player-panel 的 DASH 配对项渲染：
 *   - adaptive 视频轨 itag → "1080p" 等
 *   - adaptive 音频轨 itag → "Audio"
 *   - progressive itag → "720p" 等
 *   - 未知 itag → 空字符串
 *
 * @param itag itag 数字
 * @returns 分辨率标签字符串（可能为空）
 */
export function resolveItagLabel(itag: number): string {
  if (!itag) return ''
  if (itag in YOUTUBE_ADAPTIVE_VIDEO_ITAGS) {
    return YOUTUBE_ADAPTIVE_VIDEO_ITAGS[itag] ?? ''
  }
  if (YOUTUBE_ADAPTIVE_AUDIO_ITAGS.has(itag)) {
    return 'Audio'
  }
  if (itag in YOUTUBE_PROGRESSIVE_ITAGS) {
    return YOUTUBE_PROGRESSIVE_ITAGS[itag]?.resolution ?? ''
  }
  return ''
}