/**
 * 广告样本确认卡 — 页面内现场复核
 *
 * 保存样本前暂停播放，把样本的可学习分片清单展示给用户：
 *   - 逐片预览（直接 seek 页面原播放器到该分片，播完自动暂停；不额外请求分片、不引入 MSE）
 *   - 逐片改判（广告 / 非广告），只有判为广告的分片才会学指纹
 *   - 载入完整广告块（扩展分片清单，覆盖整个广告块）
 *
 * 主 frame 与 iframe 都需要安装（视频可能在跨域 iframe 内），
 * 因此本模块不依赖任何页面级状态，由调用方传入 findVideo。
 */

import { i18n } from '@/lib/i18n'
import { sendMessage } from '@/lib/runtime'
import { logger } from '@/lib/logger'

const CARD_ID = '__adclear_sample_card'
const CARD_STYLE_ID = '__adclear_sample_card_style'

export interface SampleSegmentView {
  readonly index: number
  readonly duration: number
  readonly discontinuity: boolean
  readonly isCurrent: boolean
  readonly signals: readonly string[]
  readonly verdict: 'ad' | 'content' | 'unknown'
}

interface CaptureResult {
  ok?: boolean
  error?: string
  draftId?: string
  pageHost?: string
  currentTime?: number
  currentSegIndex?: number
  segments?: SampleSegmentView[]
  /** 完整块是否比当前清单更大，决定是否显示「载入完整广告块」 */
  expandable?: boolean
}

export interface SampleCardOptions {
  /** 定位当前 frame 内真实播放器 */
  readonly findVideo: () => HTMLVideoElement | null
  /**
   * 预览开始/结束时通知宿主
   *
   * 页面里的广告跳过器同样监听 timeupdate，命中广告区间就 seek 走。
   * 用户预览的分片恰好是广告分片，必然落在跳过区间内，因此预览期间必须
   * 让跳过器暂停工作，否则画面会被瞬间跳到区间末尾，表现为「定位到但不播放」。
   */
  readonly onPreviewHoldChange?: (holding: boolean) => void
}

function fmtDur(sec: number): string {
  const s = sec.toFixed(1)
  return `${s}s`
}

const VERDICT_LABEL: Record<string, string> = {
  ad: 'ad',
  content: 'content',
  unknown: 'unknown',
}

let cardEl: HTMLElement | null = null
let draftId: string | null = null
let segments: SampleSegmentView[] = []
let restorePlayState: (() => void) | null = null

/**
 * 高亮框指向的分片
 *
 * 与 ★ 的语义分开：★ 是捕获瞬间的采样基准点（数据语义，固定不动），
 * 高亮框是用户当前操作焦点，应跟随最后一次点击（预览或改判）的分片。
 * null 表示尚未点击任何条目，此时退回高亮基准分片。
 */
let focusedIndex: number | null = null

function ensureStyles(): void {
  if (document.getElementById(CARD_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = CARD_STYLE_ID
  style.textContent = `
    #${CARD_ID} {
      position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
      z-index: 2147483647; width: min(560px, 92vw); max-height: 86vh; overflow: auto;
      background: rgba(15,15,23,.97); color: #fff;
      font: 12px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
      border-radius: 12px; padding: 14px 16px;
      box-shadow: 0 12px 48px rgba(0,0,0,.5);
      backdrop-filter: blur(8px);
    }
    #${CARD_ID} .sc-hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
    #${CARD_ID} .sc-title { font-weight: 600; font-size: 14px; }
    #${CARD_ID} .sc-sub { color: #a8a29e; font-size: 11px; margin-bottom: 10px; }
    #${CARD_ID} .sc-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
    #${CARD_ID} .sc-row {
      display: grid; grid-template-columns: 44px 58px 1fr 52px auto;
      align-items: center; gap: 8px;
      background: rgba(255,255,255,.04); border-radius: 7px; padding: 6px 8px;
    }
    #${CARD_ID} .sc-row.cur { outline: 1px solid #6366f1; }
    #${CARD_ID} .sc-idx { color: #a8a29e; font-variant-numeric: tabular-nums; }
    #${CARD_ID} .sc-tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; text-align: center; }
    #${CARD_ID} .sc-tag.ad { background: rgba(239,68,68,.18); color: #f87171; }
    #${CARD_ID} .sc-tag.content { background: rgba(16,185,129,.18); color: #34d399; }
    #${CARD_ID} .sc-tag.unknown { background: rgba(161,161,170,.18); color: #a1a1aa; }
    #${CARD_ID} .sc-signals { color: #d4d4d8; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #${CARD_ID} .sc-dur { color: #a8a29e; font-size: 11px; text-align: right; }
    #${CARD_ID} .sc-ops { display: flex; gap: 4px; }
    #${CARD_ID} button {
      font: inherit; cursor: pointer; border: 1px solid rgba(255,255,255,.16);
      background: rgba(255,255,255,.06); color: #e4e4e7;
      border-radius: 5px; padding: 2px 8px; font-size: 11px;
    }
    #${CARD_ID} button:hover { background: rgba(255,255,255,.14); }
    #${CARD_ID} button.on { background: #4338ca; border-color: #6366f1; color: #fff; }
    #${CARD_ID} .sc-preview { margin-bottom: 10px; }
    #${CARD_ID} .sc-preview:empty { display: none; }
    #${CARD_ID} .sc-tip { color: #a8a29e; font-size: 11px; margin-top: 4px; }
    #${CARD_ID} .sc-ft { display: flex; justify-content: flex-end; gap: 8px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,.1); }
    #${CARD_ID} .sc-ft button { padding: 6px 16px; font-size: 12px; }
    #${CARD_ID} .sc-ok { background: #059669; border-color: #10b981; color: #fff; }
    #${CARD_ID} .sc-ok:hover { background: #047857; }
  `
  document.head?.appendChild(style)
}

function destroyCard(): void {
  stopPreview()
  setPreviewHold(false)
  previewCtx = null
  focusedIndex = null
  cardEl?.remove()
  cardEl = null
  document.getElementById(CARD_STYLE_ID)?.remove()
  draftId = null
  segments = []
}

/**
 * 切换高亮框到指定分片
 *
 * 只切换 .cur 类而不重建列表：重建会丢失按钮焦点并造成闪烁，
 * 而高亮只是视觉焦点，无需重绘整张表。
 */
function focusRow(segIndex: number, body: HTMLElement): void {
  focusedIndex = segIndex
  // 按 data-seg 精确匹配，不依赖行顺序与清单顺序一致
  body.querySelectorAll('.sc-row').forEach((row) => {
    row.classList.toggle('cur', row.getAttribute('data-seg') === String(segIndex))
  })
}

function renderList(body: HTMLElement): void {
  const list = body.querySelector('.sc-list') as HTMLElement | null
  if (!list) return
  list.innerHTML = ''
  for (const s of segments) {
    const row = document.createElement('div')
    // 高亮跟随最后一次点击；尚未点击时高亮采样基准分片
    const highlighted = focusedIndex === null ? s.isCurrent : s.index === focusedIndex
    row.className = `sc-row${highlighted ? ' cur' : ''}`
    row.setAttribute('data-seg', String(s.index))
    const tagClass = VERDICT_LABEL[s.verdict] ?? 'unknown'
    // signals 来自规则命中理由（可能含页面可控的 URL 片段），必须转义后再拼入 HTML
    const signalsText = escapeHtml(s.signals.join(', ') || '—')
    const signalsTitle = escapeHtml(s.signals.join(', '))
    row.innerHTML = `
      <span class="sc-idx">#${s.index}${s.isCurrent ? ' ★' : ''}</span>
      <span class="sc-tag ${tagClass}">${i18n(`sample_verdict_${tagClass}`)}</span>
      <span class="sc-signals" title="${signalsTitle}">${signalsText}</span>
      <span class="sc-dur">${fmtDur(s.duration)}</span>
      <span class="sc-ops"></span>
    `
    const ops = row.querySelector('.sc-ops') as HTMLElement
    const pv = document.createElement('button')
    pv.textContent = i18n('sample_preview')
    pv.addEventListener('click', () => handlePreview(s.index, body))
    ops.appendChild(pv)

    const adBtn = document.createElement('button')
    adBtn.textContent = i18n('sample_mark_ad')
    if (s.verdict === 'ad') adBtn.classList.add('on')
    adBtn.addEventListener('click', () => void handleVerdict(s.index, 'ad', body))
    ops.appendChild(adBtn)

    const ctBtn = document.createElement('button')
    ctBtn.textContent = i18n('sample_mark_content')
    if (s.verdict === 'content') ctBtn.classList.add('on')
    ctBtn.addEventListener('click', () => void handleVerdict(s.index, 'content', body))
    ops.appendChild(ctBtn)

    list.appendChild(row)
  }
}

/**
 * 预览上下文
 *
 * 分片清单只记录 index 与 duration，没有绝对起始时间，
 * 因此需要捕获时的坐标作为基准，再用 duration 前缀和推算出目标分片的时间点。
 */
interface PreviewContext {
  readonly findVideo: () => HTMLVideoElement | null
  /** 捕获瞬间的播放位置 */
  readonly baseTime: number
  /** baseTime 所在分片在清单中的下标 */
  readonly baseIndex: number
  /** 分片清单读取器：始终取最新清单，展开完整块后新分片也可预览 */
  readonly segs: () => readonly SampleSegmentView[]
  readonly holdChange?: ((holding: boolean) => void) | undefined
}

let previewCtx: PreviewContext | null = null

/** 当前预览状态；null 表示未在预览 */
let activePreview: {
  video: HTMLVideoElement
  onTimeUpdate: () => void
  timer: number
  onSeeked: (() => void) | null
} | null = null

/**
 * 通知宿主暂停/恢复广告跳过器
 *
 * 只在状态真正翻转时下发，避免同一状态下重复回调。
 */
function setPreviewHold(holding: boolean): void {
  if (previewHolding === holding) return
  previewHolding = holding
  previewCtx?.holdChange?.(holding)
}

let previewHolding = false

/**
 * 计算目标分片的绝对播放时间
 *
 * 分片时长之和即时间轴长度，故从基准分片起按 duration 前缀和累加即可精确定位。
 * 基准分片之前的索引同样可算，向前累减。
 *
 * @returns 目标时间点（秒）；索引不在清单内返回 null
 */
function segStartTime(ctx: PreviewContext, targetIndex: number): number | null {
  const list = ctx.segs()
  const pos = list.findIndex((s) => s.index === targetIndex)
  const basePos = list.findIndex((s) => s.index === ctx.baseIndex)
  if (pos < 0 || basePos < 0) return null

  let t = ctx.baseTime
  if (pos > basePos) {
    for (let i = basePos; i < pos; i++) t += list[i]!.duration
  } else {
    for (let i = pos; i < basePos; i++) t -= list[i]!.duration
  }
  return Math.max(0, t)
}

/**
 * 停止当前预览
 *
 * 移除 timeupdate 监听与兜底定时器，避免监听器在多次预览间累积。
 * 不恢复播放位置：预览在原播放器上进行，用户确认后本来就要从这里继续看。
 */
function stopPreview(): void {
  if (!activePreview) {
    setPreviewHold(false)
    return
  }
  const { video, onTimeUpdate, timer, onSeeked } = activePreview
  video.removeEventListener('timeupdate', onTimeUpdate)
  if (onSeeked) video.removeEventListener('seeked', onSeeked)
  window.clearInterval(timer)
  try {
    video.pause()
  } catch { /* 播放器可能已被移除，忽略 */ }
  activePreview = null
  // 预览结束立即放开跳过器：用户之后自行拖动控制条时仍应正常跳广告
  setPreviewHold(false)
}

/**
 * 在原播放器上预览指定分片
 *
 * 直接 seek 页面播放器，不额外请求分片数据：
 *   - 播放器已持有该 m3u8 的完整分片，画面就是真实内容
 *   - 无需 demux / MSE / CORS，也不受 TS 容器不被 <video> 直接支持的限制
 * 播放到该分片结束点后自动暂停。
 */
function handlePreview(segIndex: number, body: HTMLElement): void {
  if (!draftId || !previewCtx) return
  // 点击即转移高亮：即使后续预览因故失败，用户的操作焦点也已落在该条
  focusRow(segIndex, body)
  const wrap = body.querySelector('.sc-preview') as HTMLElement | null
  if (!wrap) return

  const video = previewCtx.findVideo()
  if (!video) {
    wrap.innerHTML = `<span class="sc-tip">${i18n('sample_preview_no_video')}</span>`
    return
  }

  // 直播等流无 seekable 区间，无法按时间点定位分片
  if (video.seekable.length === 0) {
    wrap.innerHTML = `<span class="sc-tip">${i18n('sample_preview_unseekable')}</span>`
    return
  }

  const seg = previewCtx.segs().find((s) => s.index === segIndex)
  const start = segStartTime(previewCtx, segIndex)
  if (!seg || start === null) {
    wrap.innerHTML = `<span class="sc-tip">${i18n('sample_preview_fail')}</span>`
    return
  }

  stopPreview()

  const end = start + seg.duration
  const onTimeUpdate = (): void => {
    if (video.currentTime >= end - 0.05) {
      stopPreview()
      if (wrap.isConnected) {
        wrap.innerHTML = `<span class="sc-tip">${i18n('sample_preview_finished', [
          String(segIndex),
          fmtDur(seg.duration),
        ])}</span>`
      }
    }
  }
  // 兜底：分片末尾可能卡在缓冲边界不再触发 timeupdate，定时检查防止无法自动暂停
  const timer = window.setInterval(onTimeUpdate, 200)
  video.addEventListener('timeupdate', onTimeUpdate)
  const state = { video, onTimeUpdate, timer, onSeeked: null as (() => void) | null }
  activePreview = state

  // 必须先于 seek 生效：跳过器的 timeupdate 监听会抢在本次 seek 后立刻把位置挪走
  setPreviewHold(true)

  wrap.innerHTML = `<span class="sc-tip">${i18n('sample_preview_playing', [
    String(segIndex),
    fmtDur(seg.duration),
  ])}</span>`

  // seek 完成后才能稳定播放：直接赋值若不等待 seeked，部分播放器会把 play 打断
  const playFrom = (): void => {
    video.play().then(
      () => { /* 成功无需处理 */ },
      (err: unknown) => {
        if (!cardEl || !wrap.isConnected) return
        const name = err instanceof Error ? err.name : ''
        // 自动播放被拦截时给出可操作提示，而不是静默失败让用户以为功能坏了
        const key = name === 'NotAllowedError' ? 'sample_preview_autoplay_blocked' : 'sample_preview_play_fail'
        wrap.innerHTML = `<span class="sc-tip">${i18n(key)}</span>`
      },
    )
  }

  const onSeeked = (): void => {
    video.removeEventListener('seeked', onSeeked)
    state.onSeeked = null
    playFrom()
  }

  try {
    video.currentTime = start
  } catch { /* 超出 seekable 范围时由下面的提示告知 */ }

  // 一律等 seeked 再播放：赋值后立即读 currentTime 仍是旧值，
  // 用「是否已到位」做快速判断会在 HLS 播放器上误判并打断 seek
  video.addEventListener('seeked', onSeeked)
  state.onSeeked = onSeeked

  // 兜底：部分播放器对同一分片重复 seek 不触发 seeked（位置本就未变），
  // 此时不能干等，否则表现为「已定位但不播放」
  setTimeout(() => {
    if (activePreview !== state || state.onSeeked !== onSeeked) return
    video.removeEventListener('seeked', onSeeked)
    state.onSeeked = null
    playFrom()
  }, 400)
}

async function handleVerdict(
  segIndex: number,
  verdict: 'ad' | 'content',
  body: HTMLElement,
): Promise<void> {
  if (!draftId) return
  const r = await sendMessage<{ ok?: boolean; error?: string }>({
    type: 'setDraftVerdict',
    payload: { draftId, segIndex, verdict },
  })
  if (!r?.ok) return
  segments = segments.map((s) => (s.index === segIndex ? { ...s, verdict } : s))
  focusedIndex = segIndex
  renderList(body)
}

async function handleLoadFullBlock(body: HTMLElement, btn?: HTMLButtonElement): Promise<void> {
  if (!draftId) return
  if (btn) btn.disabled = true
  const r = await sendMessage<{ ok?: boolean; segments?: SampleSegmentView[]; error?: string }>({
    type: 'loadFullBlock',
    payload: { draftId },
  })
  if (btn) btn.disabled = false
  if (!draftId) return
  if (!r?.ok || !r.segments) {
    alert(`${i18n('sample_load_block_fail')}: ${r?.error ?? ''}`)
    return
  }
  segments = r.segments
  // 完整块只有一次加载语义：加载后清单已覆盖全块，按钮再点不会新增内容
  if (btn) btn.style.display = 'none'
  renderList(body)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
}

/** 保存成功提示（自包含：主 frame 与 iframe 都需要，不能依赖调用方实现） */
function showResultToast(text: string): void {
  const id = '__adclear_sample_toast'
  document.getElementById(id)?.remove()
  const el = document.createElement('div')
  el.id = id
  el.textContent = text
  el.style.cssText = `
    position: fixed; left: 50%; top: 24px; transform: translateX(-50%);
    z-index: 2147483647; background: rgba(5,150,105,.95); color: #fff;
    font: 12px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    padding: 8px 16px; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.3);
  `
  document.body?.appendChild(el)
  setTimeout(() => el.remove(), 2500)
}

function showCard(data: CaptureResult, opts: SampleCardOptions): void {
  destroyCard()
  ensureStyles()

  draftId = data.draftId ?? null
  segments = data.segments ?? []
  if (!draftId) return

  previewCtx = {
    findVideo: opts.findVideo,
    baseTime: data.currentTime ?? 0,
    baseIndex: data.currentSegIndex ?? 0,
    // 传读取器而非快照：展开完整块会替换 segments，快照会让新分片无法预览
    segs: () => segments,
    holdChange: opts.onPreviewHoldChange,
  }

  const el = document.createElement('div')
  el.id = CARD_ID
  el.innerHTML = `
    <div class="sc-hd"><span class="sc-title">${i18n('sample_card_title')}</span></div>
    <div class="sc-sub">
      ${escapeHtml(data.pageHost ?? '')} · t=${(data.currentTime ?? 0).toFixed(1)}s · ${i18n('sample_card_sub')}
    </div>
    <div class="sc-preview"></div>
    <div class="sc-list"></div>
    <div class="sc-ft"></div>
  `
  const body = el
  renderList(body)

  const ft = el.querySelector('.sc-ft') as HTMLElement

  const expandable = data.expandable === true
  const blkBtn = document.createElement('button')
  blkBtn.textContent = i18n('sample_load_full_block')
  blkBtn.classList.add('sc-block')
  blkBtn.style.display = expandable ? '' : 'none'
  blkBtn.addEventListener('click', () => void handleLoadFullBlock(body, blkBtn))
  ft.appendChild(blkBtn)

  const cancel = document.createElement('button')
  cancel.textContent = i18n('sample_cancel')
  cancel.addEventListener('click', async () => {
    if (draftId) {
      await sendMessage({ type: 'cancelSampleDraft', payload: { draftId } })
    }
    restorePlayState?.()
    restorePlayState = null
    destroyCard()
  })
  ft.appendChild(cancel)

  const ok = document.createElement('button')
  ok.className = 'sc-ok'
  ok.textContent = i18n('sample_confirm_save')
  ok.addEventListener('click', async () => {
    if (!draftId) return
    ok.disabled = true
    const verdicts: Record<number, 'ad' | 'content'> = {}
    for (const s of segments) {
      if (s.verdict === 'ad' || s.verdict === 'content') verdicts[s.index] = s.verdict
    }
    const r = await sendMessage<{ ok?: boolean; error?: string; learned?: number; total?: number; revoked?: number }>({
      type: 'commitSample',
      payload: { draftId, verdicts },
    })
    if (!r?.ok) {
      ok.disabled = false
      alert(`${i18n('sample_commit_fail')}: ${r?.error ?? ''}`)
      if (r?.error === 'draft-expired') {
        restorePlayState?.()
        restorePlayState = null
        destroyCard()
      }
      return
    }
    restorePlayState?.()
    restorePlayState = null
    destroyCard()
    showResultToast(
      i18n('sample_saved_toast', [String(r.learned ?? 0), String(r.total ?? 0), String(r.revoked ?? 0)]),
    )
  })
  ft.appendChild(ok)

  cardEl = el
  document.body?.appendChild(el)
}

/**
 * 打开确认卡
 *
 * 暂停播放并记录原播放状态：取消或完成确认后恢复原状。
 * 直播等无法暂停的场景（seekable 为空）降级为不暂停，仅出清单。
 */
export async function openSampleCard(
  tabId: number,
  opts: SampleCardOptions,
): Promise<void> {
  const video = opts.findVideo()
  if (!video) {
    alert(i18n('popup_playback_read_fail') + ': ' + i18n('options_no_video_element'))
    return
  }
  // 重入保护：连点保存会生成两个草稿并渲染两张卡，先渲染的卡被覆盖后
  // 其草稿成为孤儿，且 restorePlayState 被覆盖导致原始暂停状态无法恢复
  if (draftId) {
    await sendMessage({ type: 'cancelSampleDraft', payload: { draftId } })
    restorePlayState?.()
    restorePlayState = null
    destroyCard()
  }
  // currentTime 必须在暂停前读取：暂停后部分播放器会保持值不变，
  // 但先读可避免与暂停动作的时序竞争，保证采样坐标与用户所见画面一致
  const currentTime = video.currentTime || 0

  const wasPaused = video.paused
  if (!wasPaused) {
    try {
      video.pause()
      restorePlayState = () => {
        if (!wasPaused) void video.play().catch(() => {})
      }
    } catch {
      restorePlayState = null
    }
  }

  const r = await sendMessage<CaptureResult>({
    type: 'captureSample',
    payload: { tabId, currentTime },
  })

  if (!r?.ok || !r.draftId) {
    restorePlayState?.()
    restorePlayState = null
    const err = r?.error
    const msg =
      err === 'site-inactive' ? i18n('popup_error_site_inactive')
      : err === 'no-m3u8-context' ? i18n('popup_error_no_m3u8_context')
      : err === 'sample-out-of-range' ? i18n('popup_error_sample_out_of_range')
      : i18n('popup_capture_fail', [err ?? i18n('popup_unknown_error')])
    alert(msg)
    return
  }

  logger.info('[AdClear sample] draft created:', r.draftId, 'segments:', r.segments?.length ?? 0)
  showCard(r, opts)
}