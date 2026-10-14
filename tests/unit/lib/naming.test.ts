/**
 * naming.ts 单元测试
 *
 * 覆盖 extractBaseName + isBadName 两个核心函数
 */

import { describe, it, expect } from 'vitest'
import { extractBaseName, isBadName } from '@/lib/naming'

describe('naming', () => {
  describe('extractBaseName', () => {
    it('从 m3u8 URL 提取有意义的路径段', () => {
      const url = 'https://cdn.example.com/static/video/episode01/index.m3u8'
      const name = extractBaseName(url)
      expect(name).toBe('episode01')
    })

    it('剔除技术段（index/home/player/cdn/static 等）', () => {
      const url = 'https://example.com/cdn/static/episode01/index.m3u8'
      const name = extractBaseName(url)
      expect(name).toBe('episode01')
    })

    it('全部被剔除时回退到 hostname', () => {
      const url = 'https://example.com/index.m3u8'
      const name = extractBaseName(url)
      expect(name).toBe('example.com')
    })

    it('去 www. 前缀', () => {
      const url = 'https://www.example.com/index.m3u8'
      const name = extractBaseName(url)
      expect(name).toBe('example.com')
    })

    it('限长 50 字符', () => {
      const longSegment = 'a'.repeat(100)
      const url = `https://example.com/${longSegment}/index.m3u8`
      const name = extractBaseName(url)
      expect(name.length).toBeLessThanOrEqual(50)
    })

    it('非法 URL 返回 video 兜底', () => {
      const name = extractBaseName('not-a-url')
      expect(name).toBe('video')
    })

    it('空字符串返回 video 兜底', () => {
      const name = extractBaseName('')
      expect(name).toBe('video')
    })

    it('多段拼接用 _ 连接', () => {
      const url = 'https://example.com/movies/season1/episode01/index.m3u8'
      const name = extractBaseName(url)
      expect(name).toBe('movies_season1_episode01')
    })

    it('清理非法文件名字符', () => {
      const url = 'https://example.com/视频:名/称/index.m3u8'
      const name = extractBaseName(url)
      // : 被替换为 _
      expect(name).not.toContain(':')
    })
  })

  describe('isBadName', () => {
    it('空字符串返回 true', () => {
      expect(isBadName('')).toBe(true)
      expect(isBadName(undefined)).toBe(true)
    })

    it('长度 < 3 返回 true', () => {
      expect(isBadName('ab')).toBe(true)
    })

    it('长度 >= 3 的正常名返回 false', () => {
      expect(isBadName('我的视频')).toBe(false)
      expect(isBadName('episode01')).toBe(false)
    })

    it('技术段名返回 true', () => {
      expect(isBadName('index')).toBe(true)
      expect(isBadName('home')).toBe(true)
      expect(isBadName('player')).toBe(true)
      expect(isBadName('video')).toBe(true)
      expect(isBadName('cdn')).toBe(true)
      expect(isBadName('static')).toBe(true)
    })

    it('无标题/未知类返回 true', () => {
      expect(isBadName('无标题')).toBe(true)
      expect(isBadName('untitled')).toBe(true)
      expect(isBadName('unknown')).toBe(true)
    })

    it('纯数字返回 true', () => {
      expect(isBadName('12345')).toBe(true)
    })

    it('纯符号返回 true', () => {
      expect(isBadName('___')).toBe(true)
      expect(isBadName('---')).toBe(true)
    })

    it('不含字母或中文返回 true', () => {
      expect(isBadName('123')).toBe(true)
      expect(isBadName('...')).toBe(true)
    })

    it('trim 后判断', () => {
      expect(isBadName('  ab  ')).toBe(true)  // trim 后长度 2
      expect(isBadName('  abc  ')).toBe(false) // trim 后长度 3
    })
  })
})
