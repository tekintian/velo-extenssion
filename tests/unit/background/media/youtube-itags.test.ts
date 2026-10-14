/**
 * youtube-itags 单元测试
 *
 * 覆盖 task #14 新增的 extractItagFromUrl + resolveItagLabel 两个函数：
 *   - extractItagFromUrl: 从 URL query 提取 itag 数字
 *   - resolveItagLabel: itag → 人类可读分辨率标签
 *
 * 同时验证现有的 isAdaptiveVideoItag / isAdaptiveAudioItag / getAdaptiveVideoResolution 不被破坏。
 */

import { describe, it, expect } from 'vitest'

import {
  YOUTUBE_ADAPTIVE_VIDEO_ITAGS,
  YOUTUBE_ADAPTIVE_AUDIO_ITAGS,
  YOUTUBE_PROGRESSIVE_ITAGS,
  isAdaptiveVideoItag,
  isAdaptiveAudioItag,
  getAdaptiveVideoResolution,
  extractItagFromUrl,
  resolveItagLabel,
} from '@/background/media/youtube-itags'

describe('youtube-itags (tables)', () => {
  it('YOUTUBE_ADAPTIVE_VIDEO_ITAGS 含 15 项 DASH 视频 itag', () => {
    expect(Object.keys(YOUTUBE_ADAPTIVE_VIDEO_ITAGS).length).toBe(15)
    expect(YOUTUBE_ADAPTIVE_VIDEO_ITAGS[248]).toBe('1080p')
    expect(YOUTUBE_ADAPTIVE_VIDEO_ITAGS[337]).toBe('2160p')
  })

  it('YOUTUBE_ADAPTIVE_AUDIO_ITAGS 含 5 项 DASH 音频 itag', () => {
    expect(YOUTUBE_ADAPTIVE_AUDIO_ITAGS.size).toBe(5)
    expect(YOUTUBE_ADAPTIVE_AUDIO_ITAGS.has(251)).toBe(true)
    expect(YOUTUBE_ADAPTIVE_AUDIO_ITAGS.has(249)).toBe(true)
  })

  it('YOUTUBE_PROGRESSIVE_ITAGS 含 8 项 combined itag', () => {
    expect(Object.keys(YOUTUBE_PROGRESSIVE_ITAGS).length).toBe(8)
    expect(YOUTUBE_PROGRESSIVE_ITAGS[22]?.resolution).toBe('720p')
    expect(YOUTUBE_PROGRESSIVE_ITAGS[18]?.container).toBe('MP4')
  })

  it('isAdaptiveVideoItag 查询', () => {
    expect(isAdaptiveVideoItag(248)).toBe(true)
    expect(isAdaptiveVideoItag(251)).toBe(false) // 251 是音频
    expect(isAdaptiveVideoItag(99999)).toBe(false)
  })

  it('isAdaptiveAudioItag 查询', () => {
    expect(isAdaptiveAudioItag(251)).toBe(true)
    expect(isAdaptiveAudioItag(248)).toBe(false) // 248 是视频
    expect(isAdaptiveAudioItag(99999)).toBe(false)
  })

  it('getAdaptiveVideoResolution 返回分辨率字符串', () => {
    expect(getAdaptiveVideoResolution(248)).toBe('1080p')
    expect(getAdaptiveVideoResolution(337)).toBe('2160p')
    expect(getAdaptiveVideoResolution(251)).toBeUndefined()
  })
})

describe('extractItagFromUrl (task #14)', () => {
  it('从 GoogleVideo videoplayback URL 提取 itag', () => {
    const url = 'https://rr1.sn-xxxx.googlevideo.com/videoplayback?dur=120.5&itag=248&ei=ABC123&signature=xxx'
    expect(extractItagFromUrl(url)).toBe(248)
  })

  it('从 YouTube watch 页 formats URL 提取 itag', () => {
    const url = 'https://rr1.googlevideo.com/videoplayback?expire=123&itag=22&sig=yyy'
    expect(extractItagFromUrl(url)).toBe(22)
  })

  it('音频 itag 也能提取', () => {
    const url = 'https://rr1.googlevideo.com/videoplayback?dur=120.5&itag=251&ei=DEF456'
    expect(extractItagFromUrl(url)).toBe(251)
  })

  it('无 query 参数 → 返回 0', () => {
    expect(extractItagFromUrl('https://example.com/videoplayback')).toBe(0)
  })

  it('无 itag 参数 → 返回 0', () => {
    expect(extractItagFromUrl('https://example.com/videoplayback?dur=120&ei=xxx')).toBe(0)
  })

  it('itag 在中间位置也能提取', () => {
    const url = 'https://example.com/videoplayback?dur=120&itag=137&ei=xxx&signature=yyy'
    expect(extractItagFromUrl(url)).toBe(137)
  })

  it('itag 后跟 hash 锚点也能提取', () => {
    const url = 'https://example.com/videoplayback?itag=303&t=1#fragment'
    expect(extractItagFromUrl(url)).toBe(303)
  })

  it('空 URL → 返回 0', () => {
    expect(extractItagFromUrl('')).toBe(0)
  })

  it('无效数字 → 返回 0', () => {
    const url = 'https://example.com/videoplayback?itag=abc'
    expect(extractItagFromUrl(url)).toBe(0)
  })
})

describe('resolveItagLabel (task #14)', () => {
  it('adaptive 视频轨 itag → 分辨率字符串', () => {
    expect(resolveItagLabel(248)).toBe('1080p')
    expect(resolveItagLabel(337)).toBe('2160p')
    expect(resolveItagLabel(278)).toBe('144p')
  })

  it('adaptive 音频轨 itag → "Audio"', () => {
    expect(resolveItagLabel(251)).toBe('Audio')
    expect(resolveItagLabel(171)).toBe('Audio')
  })

  it('progressive itag → 分辨率字符串', () => {
    expect(resolveItagLabel(22)).toBe('720p')
    expect(resolveItagLabel(18)).toBe('360p')
  })

  it('未知 itag → 空字符串', () => {
    expect(resolveItagLabel(99999)).toBe('')
  })

  it('itag=0 → 空字符串', () => {
    expect(resolveItagLabel(0)).toBe('')
  })
})
