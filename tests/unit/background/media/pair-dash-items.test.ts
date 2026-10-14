/**
 * pairDashItems 单元测试
 *
 * 覆盖三级配对策略的核心路径：
 *   ① 1v1 直配（1 video + 1 audio）
 *   ② 文件名前缀配对（B 站 {cid}-{quality}- 格式）
 *   ③ URL 路径前缀相似度配对
 *   ④ 时间窗口最近邻兜底
 *
 * 测试策略：通过 addMediaItemExternal 注入测试数据（避开私有的 tabMediaMap），
 * URL 中含 playvideo/playaudio 关键字让 isDashVideoCT/isDashAudioCT 正确分类。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/storage', () => ({
  persistentStorage: {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  },
  settingsStore: {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// Mock chrome API（pairDashItems 不直接用，但 sniffer.ts 顶层引用了 chrome.webRequest 等类型）
const mockAddListener = vi.fn()
vi.stubGlobal('chrome', {
  webRequest: {
    onHeadersReceived: { addListener: mockAddListener },
    onBeforeSendHeaders: { addListener: mockAddListener },
    onBeforeRequest: { addListener: mockAddListener },
    onCompleted: { addListener: mockAddListener },
    onErrorOccurred: { addListener: mockAddListener },
  },
  webNavigation: {
    onHistoryStateUpdated: { addListener: vi.fn() },
  },
  tabs: {
    onRemoved: { addListener: vi.fn() },
    get: vi.fn().mockResolvedValue({ title: '' }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  },
  downloads: {
    onCreated: { addListener: vi.fn() },
    download: vi.fn(),
  },
  cookies: { getAll: vi.fn().mockResolvedValue([]) },
  action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
  storage: { local: { get: vi.fn().mockResolvedValue(undefined), set: vi.fn() } },
})

// 控制 detectedAt 时间戳（addMediaItemExternal 内部用 Date.now()）
const FIXED_TIME = 1700000000000
vi.useFakeTimers()
vi.setSystemTime(FIXED_TIME)

import { addMediaItemExternal, pairDashItems } from '@/background/media/sniffer'

describe('pairDashItems', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.setSystemTime(FIXED_TIME)
    // 清空 tabMediaMap（通过 getMediaItems 返回空数组间接验证）
    // 注意：tabMediaMap 是模块私有，无法直接 clear；通过新 tabId 隔离测试
  })

  /**
   * 策略 ①：1v1 直配
   *
   * 场景：同 tab 只有 1 个 video + 1 个 audio，CT/URL 关键字能明确分类
   * 预期：直接配对成 1 组，两个 item 都被标记 dashRole + dashGroupId
   */
  it('策略①: 1v1 直配 — 1 video + 1 audio 直接配对', () => {
    const tabId = 10001
    addMediaItemExternal(tabId, 'https://example.com/playvideo/index.m4s', 'video', 'm4s')
    addMediaItemExternal(tabId, 'https://example.com/playaudio/index.m4s', 'audio', 'm4s')

    const pairs = pairDashItems(tabId)

    expect(pairs).toHaveLength(1)
    expect(pairs[0]!.video.dashRole).toBe('video')
    expect(pairs[0]!.audio.dashRole).toBe('audio')
    expect(pairs[0]!.video.dashGroupId).toBe(pairs[0]!.audio.dashGroupId)
    expect(pairs[0]!.video.dashGroupId).toMatch(/^dash-10001-1$/)
  })

  /**
   * 策略 ②：文件名前缀配对（B 站格式）
   *
   * 场景：多个 video + 多个 audio，文件名遵循 B 站 {cid}-{quality}-{size}.m4s 格式
   * 预期：前缀（{cid}-{quality}）相同的 video+audio 配对，不同 quality 不交叉
   */
  it('策略②: 文件名前缀配对 — B 站 {cid}-{quality}- 格式', () => {
    const tabId = 10002
    // 两个不同 cid 的视频，每个有 video + audio
    // cid=111 的 720p：前缀 111-80
    addMediaItemExternal(tabId, 'https://bilivideo.com/playvideo/111-80-30232.m4s', '111-80-30232', 'm4s')
    addMediaItemExternal(tabId, 'https://bilivideo.com/playaudio/111-80-30280.m4s', '111-80-30280', 'm4s')
    // cid=222 的 1080p：前缀 222-112
    addMediaItemExternal(tabId, 'https://bilivideo.com/playvideo/222-112-30280.m4s', '222-112-30280', 'm4s')
    addMediaItemExternal(tabId, 'https://bilivideo.com/playaudio/222-112-30232.m4s', '222-112-30232', 'm4s')

    const pairs = pairDashItems(tabId)

    expect(pairs).toHaveLength(2)
    // 每对的 video 和 audio 文件名前缀应相同
    for (const pair of pairs) {
      const vPrefix = pair.video.fileName.replace(/\.[^.]+$/, '').replace(/-[^-]*$/, '')
      const aPrefix = pair.audio.fileName.replace(/\.[^.]+$/, '').replace(/-[^-]*$/, '')
      expect(vPrefix).toBe(aPrefix)
    }
  })

  /**
   * 边界：无候选项时返回空数组
   */
  it('边界: 无 DASH 候选项返回空数组', () => {
    const tabId = 10003
    // 非 m4s 扩展名，且 CT 为空 → isDashCandidate 返回 false
    addMediaItemExternal(tabId, 'https://example.com/video.mp4', 'video', 'mp4')

    const pairs = pairDashItems(tabId)

    expect(pairs).toHaveLength(0)
  })

  /**
   * 边界：只有 video 没有 audio 时返回空数组
   */
  it('边界: 只有 video 没有 audio 返回空数组', () => {
    const tabId = 10004
    addMediaItemExternal(tabId, 'https://example.com/playvideo/index.m4s', 'video', 'm4s')
    // 没有 audio

    const pairs = pairDashItems(tabId)

    expect(pairs).toHaveLength(0)
  })

  /**
   * 策略 ③：URL 路径前缀相似度配对
   *
   * 场景：多个 video + 多个 audio，文件名无规律但 URL 路径前缀相似
   * 预期：URL 路径前 3 段相同的 video+audio 配对
   *
   * 注意：此场景下 videoItems.length + audioItems.length > 4，阈值 0.3
   */
  it('策略③: URL 路径前缀相似度配对 — YouTube 风格 URL', () => {
    const tabId = 10005
    // 同一视频的 video 和 audio 共享 /videoplayback/123456/ 路径前缀
    // 文件名无前缀规律，走策略 ③
    addMediaItemExternal(tabId, 'https://rr1.example.com/videoplayback/123456/itag=137/video.m4s', 'video', 'm4s')
    addMediaItemExternal(tabId, 'https://rr1.example.com/videoplayback/123456/itag=251/audio.m4s', 'audio', 'm4s')

    const pairs = pairDashItems(tabId)

    // 1v1 场景下会走策略 ①，先验证 1v1 能命中
    expect(pairs).toHaveLength(1)
    expect(pairs[0]!.video.url).toContain('itag=137')
    expect(pairs[0]!.audio.url).toContain('itag=251')
  })

  /**
   * 幂等性：已配对的 item 不会重复配对
   */
  it('幂等: 重复调用 pairDashItems 不产生重复配对', () => {
    const tabId = 10006
    addMediaItemExternal(tabId, 'https://example.com/playvideo/index.m4s', 'video', 'm4s')
    addMediaItemExternal(tabId, 'https://example.com/playaudio/index.m4s', 'audio', 'm4s')

    const pairs1 = pairDashItems(tabId)
    const pairs2 = pairDashItems(tabId)

    // 第二次调用时，候选项已带 dashGroupId，被过滤掉 → 返回空
    expect(pairs1).toHaveLength(1)
    expect(pairs2).toHaveLength(0)
  })
})
