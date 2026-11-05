/**
 * 播放状态查询 — 跨 frame 定向汇总
 *
 * ## 背景（缺陷根因）
 * badge.content.ts 以 `allFrames: true` 注入，主页面之外每个 iframe（广告位、
 * 统计、播放器）都各有一份 `getPlayback` 监听器。chrome.tabs.sendMessage 在
 * 不指定 frameId 时会把消息广播到该 tab 所有已注入 frame，并以「第一个返回的
 * 响应」为准。若空 frame 先回，就会拿到「未找到 video 元素」，而主 frame 里
 * 真正在播放的 video 的正确答案被丢弃 —— 这是竞态，与视频是否在播放无关。
 *
 * ## 解决思路
 * 不再依赖广播的「谁先回」，改为按 frameId 逐个定向查询：
 *   1. 先查 frameId 0（主 frame），命中即返回，符合用户直觉
 *   2. 主 frame 未命中时，用 webNavigation.getAllFrames 拿到全部 frameId
 *      逐个查询，取第一个 ok 的结果
 * 每个 sendMessage 都独立捕获异常（frame 无 content script / 跨域不可达时
 * 会 reject），因此不会因个别 frame 失败而中断整体流程。
 */

export interface PlaybackState {
  readonly ok: boolean
  readonly currentTime: number
  readonly duration: number
  readonly src: string
  readonly frameId: number
  readonly error?: string | undefined
}

interface RawPlaybackResponse {
  ok?: boolean
  currentTime?: number
  duration?: number
  src?: string
  error?: string
}

function normalize(raw: RawPlaybackResponse, frameId: number): PlaybackState {
  return {
    ok: raw.ok === true,
    currentTime: typeof raw.currentTime === 'number' && Number.isFinite(raw.currentTime) ? raw.currentTime : 0,
    duration: typeof raw.duration === 'number' && Number.isFinite(raw.duration) ? raw.duration : 0,
    src: typeof raw.src === 'string' ? raw.src : '',
    frameId,
    error: raw.error,
  }
}

async function queryFrame(tabId: number, frameId: number): Promise<PlaybackState | null> {
  try {
    const raw = (await chrome.tabs.sendMessage(
      tabId,
      { type: 'getPlayback' },
      { frameId },
    )) as RawPlaybackResponse | undefined
    if (!raw || typeof raw !== 'object') return null
    return normalize(raw, frameId)
  } catch {
    return null
  }
}

/**
 * 查询指定标签页的播放状态
 *
 * @param tabId 目标标签页
 * @returns 命中 video 的 frame 的播放状态；全部 frame 均无 video 时抛出可读错误
 */
export async function queryPlayback(tabId: number): Promise<PlaybackState> {
  const mainFrame = await queryFrame(tabId, 0)
  if (mainFrame?.ok) return mainFrame

  const frames = await getAllFrameIds(tabId)
  frames.delete(0)

  if (frames.size > 0) {
    const results = await Promise.all(
      Array.from(frames).map((frameId) => queryFrame(tabId, frameId)),
    )
    for (const r of results) {
      if (r?.ok) return r
    }
  }

  if (mainFrame?.error) return mainFrame
  return {
    ok: false,
    currentTime: 0,
    duration: 0,
    src: '',
    frameId: 0,
    error: undefined,
  }
}

/** 取标签页内所有 frameId（含主 frame）；查询失败时返回空集合，退化为只查主 frame */
async function getAllFrameIds(tabId: number): Promise<Set<number>> {
  const ids = new Set<number>([0])
  try {
    const all = await chrome.webNavigation.getAllFrames({ tabId })
    for (const f of all ?? []) {
      if (typeof f.frameId === 'number') ids.add(f.frameId)
    }
  } catch {
    // webNavigation 不可用 — 退化为只查主 frame
  }
  return ids
}