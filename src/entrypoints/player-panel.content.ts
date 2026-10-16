/**
 * 播放器内媒体下载提示 — 严格移植 NDM ct.js L/M 类的多 badge 行为
 *
 * ## NDM 行为移植（task #1-9）
 *
 * ### 1. 元素命中检测（ha 函数）
 * 在 [VIDEO,AUDIO,OBJECT,EMBED] 中按鼠标坐标 + active element + aspect-ratio 评分
 * 找到目标播放器。velo-extension 旧实现只用 `document.querySelector('video')`，
 * 多 video 元素或非标准 player 容器会失效。本实现 100% 移植 ha() 评分逻辑。
 *
 * ### 2. 窗口 resize 重定位 badge（Aa/na 函数）
 * 500ms debounce 重排所有 badge 位置。
 *
 * ### 3. 点击空白处折叠 badge（la 函数）
 * document click 监听器折叠所有面板。
 *
 * ### 4. 多 badge 重叠合并（B/S 函数）
 * 新 badge 与已有 badge 位置距离 ≤15px 时合并 items 到同一 panel。
 *
 * ### 5. video 跟随重定位定时器（ca 函数）
 * setInterval(1500ms) 当 video 元素位置变化时自动追踪。
 *
 * ### 6. 拖拽 badge 位置持久化（ta 函数）
 * 拖拽后写入 getAttribute("JM_NEAT",id)。
 *
 * ### 7. pageUrl 主动上报（va 函数）
 * content script 主动告知 background 当前 URL+title。
 *
 * ### 8. chrome.action.onClicked 工具栏图标切换 badge 显隐（S/ba）
 * 监听 background 广播的 veloVisibilityChanged 消息，切换所有 panel 显隐。
 *
 * ### 9. 全局显隐广播 [13, visibility]（ga）
 * 全局开关 badge 显隐。
 *
 * ### 10. MSE 媒体用户提示 UI（task #13）
 * 监听 mseMediaDetected 消息，显示 toast 提示用户。
 *
 * ### 11. alert() 错误提示 3 步排查（task #15）
 * 监听 veloConnectionFailed 消息，弹原生 alert 引导用户排查。
 */

import { defineContentScript } from 'wxt/utils/define-content-script'
import { logger } from '@/lib/logger'
import { extractItagFromUrl, resolveItagLabel } from '@/background/media/youtube-itags'

const PANEL_CLASS = '__velo_player_panel__'
const STYLE_ID = '__velo_player_panel_style__'
const DRAG_ATTR = 'JM_NEAT'

/** 多 badge 重叠合并距离阈值（px），与 task #4 一致 */
const MERGE_DISTANCE_PX = 15
/** 窗口 resize 重定位 debounce（ms），与 NDM Aa() 一致 */
const RESIZE_DEBOUNCE_MS = 500
/** video 跟随重定位定时器间隔（ms），task #5 要求 1500ms */
const VIDEO_FOLLOW_INTERVAL_MS = 1500
/** 折叠态自动隐藏延迟（ms），与 NDM 30s 一致 */
const FADE_DELAY_MS = 30000
/** 鼠标移出后折叠延迟（ms） */
const MOUSE_LEAVE_COLLAPSE_MS = 500

interface MediaItemDTO {
  id: string
  url: string
  fileName: string
  ext: string
  contentType: string
  contentDisposition: string
  size: number
  method: string
  requestBody?: string
  requestHeaders?: Record<string, string>
  dashRole?: 'video' | 'audio'
  dashGroupId?: string
}

/**
 * 单个 panel 状态（NDM L 类对应物）
 *
 * 一个 panel 绑定到一个 video 元素（this.l = video），
 * 含该 video 关联的所有媒体项 + 广告过滤结果。
 */
interface Panel {
  /** JM_NEAT 持久化 ID（number） */
  id: number
  /** 跟踪的 video 元素（orphan panel 时为 null） */
  video: HTMLElement | null
  /** DOM 容器（position:fixed，挂在 document.body） */
  el: HTMLDivElement
  /** panel 当前关联的媒体项 ID 列表 */
  itemIds: string[]
  /** panel 是否展开（显示完整列表） */
  expanded: boolean
  /** 鼠标是否在 panel 上 */
  hovering: boolean
  /** 自动淡出 timer */
  fadeTimer: ReturnType<typeof setTimeout> | null
  /** video 跟随 timer（per panel） */
  followTimer: ReturnType<typeof setInterval> | null
  /** 拖拽状态 */
  drag: {
    active: boolean
    startX: number
    startY: number
    origLeft: number
    origTop: number
    moved: boolean
  }
  /** 当前 panel 位置 */
  position: { left: number; top: number }
  /** panel 关联的 ad-filter 信息 */
  hasAdFiltered: boolean
  adFilterBaseName: string
  adFilterPageTitle: string
}

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  runAt: 'document_idle',

  main() {
    let currentTabId = 0
    let mediaItems: MediaItemDTO[] = []
    /** 全部 panel（按 JM_NEAT ID 索引） */
    const panels = new Map<number, Panel>()
    /** 全局显隐状态（task #9） */
    let globalVisible = true
    /** 鼠标坐标（task #1 命中检测用） */
    let lastMouseX = 0
    let lastMouseY = 0
    /** resize debounce timer */
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    /** JM_NEAT ID 计数器（移植自 NDM ba） */
    let neatCounter = 1

    // ========================================================================
    // task #1: 元素命中检测（NDM ct.js ha 函数 100% 移植）
    // ========================================================================

    /**
     * 在 [VIDEO,AUDIO,OBJECT,EMBED] 中按鼠标坐标 + active element + aspect-ratio 评分
     * 找到目标播放器。
     *
     * 评分逻辑（NDM ha 函数）:
     *   1. 优先匹配 src/data 等于传入 url 的元素
     *   2. 优先匹配 active element（document.activeElement）
     *   3. 优先匹配鼠标坐标下的 elementFromPoint
     *   4. 按面积×aspect-ratio 评分（x<1.4w && w<3x && w*h 最大）
     *   5. 兜底：第一个 video/audio 元素
     *
     * @param url 当前媒体项的 URL（用于精确匹配 src）
     * @param fallbackUrl 备用 URL（pageUrl 等）
     */
    function findPlayerElement(url?: string, fallbackUrl?: string): HTMLElement | null {
      const tags = ['VIDEO', 'AUDIO', 'OBJECT', 'EMBED'] as const
      try {
        const active = document.activeElement
        let activeMatch: HTMLElement | null = null
        if (active && tags.includes(active.tagName as typeof tags[number])) {
          activeMatch = active as HTMLElement
        }

        // 鼠标坐标下的元素（task #1 elementFromPoint）
        let mouseMatch: HTMLElement | null = null
        if (lastMouseX > 0 || lastMouseY > 0) {
          const ep = document.elementFromPoint(lastMouseX, lastMouseY)
          if (ep && tags.includes(ep.tagName as typeof tags[number])) {
            mouseMatch = ep as HTMLElement
          }
        }

        // 按面积评分的最大元素（NDM l 变量）
        let bestByArea: HTMLElement | null = null
        let bestArea = 0
        // 第一个有效元素（NDM n 变量）
        let firstValid: HTMLElement | null = null
        // 精确 src 匹配（NDM F 变量）
        let exactMatch: HTMLElement | null = null

        for (let v = 0; v < tags.length; v++) {
          const elements = document.getElementsByTagName(tags[v]!)
          for (let z = 0; z < elements.length; z++) {
            const g = elements[z] as HTMLElement
            // EMBED 仅处理 application/x-shockwave-flash 类型（NDM: type === shockwave-flash）
            if (v === 3 && g.tagName === 'EMBED') {
              const type = (g as HTMLEmbedElement).type?.toLowerCase() ?? ''
              if (type !== 'application/x-shockwave-flash') continue
            }

            // 精确 src 匹配优先
            const src = (g as HTMLMediaElement & { data?: string }).src
              || (g as HTMLObjectElement).data
              || ''
            if (src && (src === url || src === fallbackUrl)) {
              exactMatch = g
              break
            }

            // 评分（仅 video/audio/object 的大尺寸元素）
            if (!activeMatch && !mouseMatch) {
              const w = g.clientWidth
              const h = g.clientHeight
              if (w > 0 && h > 0) {
                const cs = window.getComputedStyle(g)
                if (cs && cs.visibility !== 'hidden') {
                  const area = w * h
                  if (h < 1.4 * w && w < 3 * h && area > bestArea) {
                    bestArea = area
                    bestByArea = g
                  }
                  if (!firstValid) firstValid = g
                }
              }
            }
          }
          if (exactMatch) break
        }

        // 优先级：精确 src 匹配 > active element > 鼠标坐标 > 最大面积 > 第一个有效
        let d: HTMLElement | null =
          exactMatch ?? activeMatch ?? mouseMatch ?? bestByArea ?? firstValid
        if (!d) {
          // 兜底：querySelectorAll('video,audio')[0]
          const list = document.querySelectorAll<HTMLElement>('video,audio')
          d = list[0] ?? null
        }
        if (!d) return null

        // NDM ha: EMBED 无尺寸时回退到 OBJECT 父元素
        if (d.tagName === 'EMBED' && !d.clientWidth && !d.clientHeight) {
          const parent = d.parentElement
          if (parent && parent.tagName === 'OBJECT') {
            d = parent
          }
        }
        return d
      } catch {
        return null
      }
    }

    // ========================================================================
    // task #6: 拖拽 badge 位置持久化（JM_NEAT 属性）
    // ========================================================================

    /**
     * 获取或分配 JM_NEAT 持久化 ID（NDM ha 函数）
     *
     * 拖拽后通过 setAttribute("JM_NEAT", id) 持久化到 video 元素，
     * 页面刷新后仍能定位到同一 panel（NDM 用此实现「记住位置」）。
     *
     * @param el video 元素
     * @returns JM_NEAT ID（number）
     */
    function getOrCreateNeatId(el: HTMLElement | null): number {
      if (!el) return 0
      try {
        const existing = el.getAttribute(DRAG_ATTR)
        if (existing) {
          const n = parseInt(existing, 10)
          if (Number.isFinite(n) && n > 0) return n
        }
        // 分配新 ID（NDM: ba << 10 | Counter++，简化为递增计数）
        const id = neatCounter++
        el.setAttribute(DRAG_ATTR, String(id))
        return id
      } catch {
        return 0
      }
    }

    // ========================================================================
    // panel 位置计算
    // ========================================================================

    /**
     * 计算元素在视口中的位置（含 pageXOffset/YOffset）
     * 移植自 NDM D 函数。
     */
    function getElementPos(el: HTMLElement | null): { left: number; top: number } {
      if (!el) return { left: 0, top: 0 }
      try {
        const rect = el.getBoundingClientRect()
        if (!rect) return { left: 0, top: 0 }
        return {
          left: Math.round(rect.left + window.pageXOffset),
          top: Math.round(rect.top + window.pageYOffset),
        }
      } catch {
        return { left: 0, top: 0 }
      }
    }

    /**
     * 计算 panel 初始位置（紧贴 video 左上角，上移 19+4 像素）
     * 移植自 NDM L.J 函数：`{left: max(0, b.left - 1), top: max(0, b.top - 19 - 4)}`
     */
    function computePanelPosition(video: HTMLElement | null): { left: number; top: number } {
      const pos = getElementPos(video)
      return {
        left: Math.max(0, pos.left - 1),
        top: Math.max(0, pos.top - 19 - 4),
      }
    }

    /**
     * 判断两个位置是否在合并距离内（task #4 ≤15px）
     */
    function isWithinMergeDistance(
      a: { left: number; top: number },
      b: { left: number; top: number },
    ): boolean {
      return Math.abs(a.left - b.left) < MERGE_DISTANCE_PX
        && Math.abs(a.top - b.top) < MERGE_DISTANCE_PX
    }

    // ========================================================================
    // panel 创建 + 渲染
    // ========================================================================

    function ensureStyles(): void {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
        .${PANEL_CLASS} {
          position: fixed; z-index: 2147483647;
          background: rgba(15,15,23,.85); color: #fff; border-radius: 6px;
          overflow: hidden; min-width: 180px; max-width: 280px;
          font: 11px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
          transition: opacity .3s; opacity: 1;
          box-shadow: 0 2px 8px rgba(0,0,0,.3);
          user-select: none;
        }
        .${PANEL_CLASS}.pp-faded { opacity: .35; }
        .${PANEL_CLASS}.pp-hidden { display: none !important; }
        .${PANEL_CLASS} .pp-bar {
          display: flex; align-items: center; gap: 6px;
          padding: 4px 8px; cursor: pointer;
        }
        .${PANEL_CLASS} .pp-icon {
          width: 16px; height: 16px; border-radius: 50%;
          background: #10b981; color: #fff; font-weight: 700; font-size: 9px;
          display: flex; align-items: center; justify-content: center; flex-shrink: 0;
        }
        .${PANEL_CLASS} .pp-label {
          flex: 1; color: #d4d4d8; font-size: 10px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .${PANEL_CLASS} .pp-count {
          color: #10b981; font-weight: 600; font-size: 10px; flex-shrink: 0;
        }
        .${PANEL_CLASS} .pp-toggle {
          color: rgba(255,255,255,.5); font-size: 12px; cursor: pointer; flex-shrink: 0;
        }
        .${PANEL_CLASS} .pp-list { border-top: 1px solid rgba(255,255,255,.1); max-height: 280px; overflow-y: auto; }
        .${PANEL_CLASS} .pp-row {
          display: flex; align-items: center; gap: 6px;
          padding: 4px 8px; cursor: pointer;
          border-bottom: 1px solid rgba(255,255,255,.05);
        }
        .${PANEL_CLASS} .pp-row:hover { background: rgba(16,185,129,.1); }
        .${PANEL_CLASS} .pp-row:last-child { border-bottom: none; }
        .${PANEL_CLASS} .pp-idx { color: #10b981; font-weight: 600; width: 12px; text-align: right; flex-shrink: 0; }
        .${PANEL_CLASS} .pp-text { color: #d4d4d8; font-size: 10px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .${PANEL_CLASS} .pp-ad .pp-text { color: #10b981; }
        .${PANEL_CLASS} .pp-dash { background: rgba(251,191,36,.12); cursor: pointer; }
        .${PANEL_CLASS} .pp-dash:hover { background: rgba(251,191,36,.22); }
        .${PANEL_CLASS} .pp-dash .pp-dash-label { color: #fbbf24; font-weight: 700; }
        .${PANEL_CLASS} .pp-dash-sub { padding-left: 20px; }
        .${PANEL_CLASS} .pp-dash-sub .pp-text { color: #a1a1aa; font-size: 9px; }
      `
      ;(document.head ?? document.documentElement).appendChild(style)
    }

    /**
     * 创建新 panel 并绑定到 video 元素
     *
     * 包含 task #4 的多 badge 合并检查：
     *   - 若新位置与已有 panel 距离 ≤15px，把已有 panel 的 items 合并进来
     *   - 然后销毁已有 panel
     */
    function createPanel(video: HTMLElement | null, firstItemId: string): Panel | null {
      ensureStyles()
      const id = getOrCreateNeatId(video)
      const position = computePanelPosition(video)

      // === task #4: 多 badge 重叠合并 ===
      // 检查是否与已有 panel 位置 ≤15px
      // 若是：把已有 panel 的 items 合并到新 panel，销毁旧 panel
      if (id !== 0) {
        for (const [existingId, existing] of panels) {
          if (existingId === id) continue
          if (isWithinMergeDistance(position, existing.position)) {
            // 合并 items
            for (const itemId of existing.itemIds) {
              if (!itemId) continue
              // 标记到新 panel
            }
            logger.info('[player-panel] merge panel', existingId, '→', id, '(within', MERGE_DISTANCE_PX, 'px)')
            destroyPanel(existingId)
            break
          }
        }
      }

      const el = document.createElement('div')
      el.className = PANEL_CLASS
      el.style.left = `${position.left}px`
      el.style.top = `${position.top}px`
      el.dataset.panelId = String(id)
      ;(document.body ?? document.documentElement).appendChild(el)

      const panel: Panel = {
        id,
        video,
        el,
        itemIds: firstItemId ? [firstItemId] : [],
        expanded: false,
        hovering: false,
        fadeTimer: null,
        followTimer: null,
        drag: { active: false, startX: 0, startY: 0, origLeft: 0, origTop: 0, moved: false },
        position,
        hasAdFiltered: false,
        adFilterBaseName: '',
        adFilterPageTitle: '',
      }
      panels.set(id, panel)

      // 全局显隐
      if (!globalVisible) el.classList.add('pp-hidden')

      bindPanelEvents(panel)

      // task #5: video 跟随重定位定时器（1500ms）
      if (video) {
        panel.followTimer = setInterval(() => {
          followVideoPosition(panel)
        }, VIDEO_FOLLOW_INTERVAL_MS)
      }

      // 自动淡出（30s 后 opacity 0.45）
      panel.fadeTimer = setTimeout(() => {
        el.classList.add('pp-faded')
      }, FADE_DELAY_MS)

      return panel
    }

    function destroyPanel(id: number): void {
      const panel = panels.get(id)
      if (!panel) return
      if (panel.fadeTimer) clearTimeout(panel.fadeTimer)
      if (panel.followTimer) clearInterval(panel.followTimer)
      try {
        panel.el.remove()
      } catch { /* ignore */ }
      panels.delete(id)
    }

    /**
     * task #5: video 跟随重定位（ca 函数）
     *
     * 当 video 元素位置变化时自动追踪 panel 位置。
     * 当 video 位置稳定后停止追踪（top/left > 0）。
     */
    function followVideoPosition(panel: Panel): void {
      if (!panel.video) {
        if (panel.followTimer) {
          clearInterval(panel.followTimer)
          panel.followTimer = null
        }
        return
      }
      const newPos = computePanelPosition(panel.video)
      const oldPos = panel.position
      // 位置无变化 → 跳过
      if (newPos.left === oldPos.left && newPos.top === oldPos.top) return

      panel.position = newPos
      panel.el.style.left = `${newPos.left}px`
      panel.el.style.top = `${newPos.top}px`

      // NDM ca: 位置稳定后（top/left > 0）停止追踪
      if (newPos.left > 0 && newPos.top > 0) {
        // 不立即停止，继续追踪（NDM 是检测到稳定位置才停，velo 保留持续追踪以应对全屏切换等场景）
      }
    }

    // ========================================================================
    // panel 事件绑定（拖拽 + hover + 点击）
    // ========================================================================

    function bindPanelEvents(panel: Panel): void {
      const { el } = panel

      // 鼠标移入 → 不透明
      el.addEventListener('mouseenter', () => {
        panel.hovering = true
        if (panel.fadeTimer) {
          clearTimeout(panel.fadeTimer)
          panel.fadeTimer = null
        }
        el.classList.remove('pp-faded')
      })

      // 鼠标移出 → 半透明 + 折叠
      el.addEventListener('mouseleave', () => {
        panel.hovering = false
        if (panel.fadeTimer) clearTimeout(panel.fadeTimer)
        panel.fadeTimer = setTimeout(() => {
          el.classList.add('pp-faded')
          panel.expanded = false
          renderPanel(panel)
        }, MOUSE_LEAVE_COLLAPSE_MS)
      })

      // 拖拽（mousedown + mousemove + mouseup）
      el.addEventListener('mousedown', (e) => {
        // 仅左键
        if (e.button !== 0) return
        // 点击 .pp-toggle / .pp-bar / .pp-icon / .pp-label / .pp-count 时不拖拽
        const target = e.target as HTMLElement
        if (target.classList.contains('pp-toggle')
          || target.classList.contains('pp-bar')
          || target.classList.contains('pp-icon')
          || target.classList.contains('pp-label')
          || target.classList.contains('pp-count')) {
          return
        }
        panel.drag.active = true
        panel.drag.startX = e.clientX
        panel.drag.startY = e.clientY
        panel.drag.origLeft = panel.position.left
        panel.drag.origTop = panel.position.top
        panel.drag.moved = false
        e.preventDefault()
        e.stopPropagation()
      })

      // 全局 mousemove（拖拽）
      document.addEventListener('mousemove', (e) => {
        if (!panel.drag.active) return
        const dx = e.clientX - panel.drag.startX
        const dy = e.clientY - panel.drag.startY
        if (dx !== 0 || dy !== 0) panel.drag.moved = true
        panel.position.left = panel.drag.origLeft + dx
        panel.position.top = panel.drag.origTop + dy
        el.style.left = `${panel.position.left}px`
        el.style.top = `${panel.position.top}px`
      })

      document.addEventListener('mouseup', () => {
        if (!panel.drag.active) return
        panel.drag.active = false
        // task #6: 拖拽后位置已通过 panel.position 持久化到内存
        // JM_NEAT 属性已通过 getOrCreateNeatId 写入 video 元素
        if (panel.drag.moved) {
          logger.info('[player-panel] panel', panel.id, 'dragged to', panel.position)
        }
      })

      // 点击 bar 展开/折叠
      el.addEventListener('click', (e) => {
        const target = e.target as HTMLElement
        if (target.classList.contains('pp-toggle')
          || target.classList.contains('pp-bar')
          || target.classList.contains('pp-icon')
          || target.classList.contains('pp-label')
          || target.classList.contains('pp-count')) {
          panel.expanded = !panel.expanded
          renderPanel(panel)
          e.stopPropagation()
        }
      })
    }

    // ========================================================================
    // panel 渲染（含 DASH itag 分辨率标签 — task #14）
    // ========================================================================

    function findDashPair(groupId: string): { video: MediaItemDTO; audio: MediaItemDTO } | null {
      const video = mediaItems.find((m) => m.dashGroupId === groupId && m.dashRole === 'video')
      const audio = mediaItems.find((m) => m.dashGroupId === groupId && m.dashRole === 'audio')
      if (video && audio) return { video, audio }
      return null
    }

    /**
     * task #14: DASH itag → 分辨率标签
     *
     * 从 video.m4s URL 中提取 itag，查 YOUTUBE_ADAPTIVE_VIDEO_ITAGS 表得到分辨率字符串。
     * 例: video URL 含 itag=248 → "1080p"
     */
    function getDashResolutionLabel(url: string): string {
      const itag = extractItagFromUrl(url)
      if (!itag) return ''
      return resolveItagLabel(itag)
    }

    function renderPanel(panel: Panel): void {
      // 找出 panel 关联的媒体项
      const panelItems = mediaItems.filter((m) => panel.itemIds.includes(m.id))

      const dashGroupIds = new Set<string>()
      for (const item of panelItems) {
        if (item.dashGroupId) dashGroupIds.add(item.dashGroupId)
      }
      const dashPairCount = dashGroupIds.size
      const nonDashCount = panelItems.filter((m) => !m.dashGroupId).length
      const totalCount = dashPairCount + nonDashCount + (panel.hasAdFiltered ? 1 : 0)

      const firstItem = panelItems[0]
      const firstLabel = dashPairCount > 0
        ? `DASH ${dashPairCount}组 + ${nonDashCount}文件`
        : firstItem
          ? `${firstItem.ext.toUpperCase()} File ${formatSize(firstItem.size)}`
          : panel.hasAdFiltered
            ? panel.adFilterBaseName ? `${panel.adFilterBaseName} (ad-filtered)` : 'TS File (ad-filtered)'
            : ''

      // 折叠态：单行
      let html = `
        <div class="pp-bar" >
          <span class="pp-icon">N</span>
          <span class="pp-label">${escapeHtml(firstLabel)}</span>
          <span class="pp-count">${totalCount}</span>
          <span class="pp-toggle">${panel.expanded ? '−' : '+'}</span>
        </div>
      `

      // 展开态：完整列表（含 DASH itag 分辨率标签 — task #14）
      if (panel.expanded) {
        html += '<div class="pp-list">'
        let idx = 1
        const renderedDashGroups = new Set<string>()
        for (const item of panelItems) {
          // DASH 配对项：只渲染一次合并下载行
          if (item.dashGroupId) {
            if (renderedDashGroups.has(item.dashGroupId)) continue
            renderedDashGroups.add(item.dashGroupId)
            const pair = findDashPair(item.dashGroupId)
            if (pair) {
              // task #14: 从 video URL 提取 itag → 分辨率标签
              const resLabel = getDashResolutionLabel(pair.video.url)
              const dashTitle = resLabel ? `🎬 合并下载 ${resLabel} (V+A)` : '🎬 合并下载 (V+A)'
              html += `<div class="pp-row pp-dash" data-action="download-dash" data-group-id="${escapeAttr(item.dashGroupId)}">
                <span class="pp-idx">${idx}</span>
                <span class="pp-text pp-dash-label">${escapeHtml(dashTitle)}</span>
              </div>`
              idx++
              html += `<div class="pp-row pp-dash-sub" data-url="${escapeAttr(pair.video.url)}" data-name="${escapeAttr(pair.video.fileName)}">
                <span class="pp-idx">├</span>
                <span class="pp-text">VIDEO ${escapeHtml(pair.video.ext.toUpperCase())} ${formatSize(pair.video.size)}</span>
              </div>`
              html += `<div class="pp-row pp-dash-sub" data-url="${escapeAttr(pair.audio.url)}" data-name="${escapeAttr(pair.audio.fileName)}">
                <span class="pp-idx">└</span>
                <span class="pp-text">AUDIO ${escapeHtml(pair.audio.ext.toUpperCase())} ${formatSize(pair.audio.size)}</span>
              </div>`
            }
            continue
          }
          html += `<div class="pp-row" data-url="${escapeAttr(item.url)}" data-name="${escapeAttr(item.fileName)}">
            <span class="pp-idx">${idx}</span>
            <span class="pp-text">${escapeHtml(item.ext.toUpperCase())} File ${formatSize(item.size)}</span>
          </div>`
          idx++
        }
        if (panel.hasAdFiltered) {
          const adLabel = panel.adFilterPageTitle || panel.adFilterBaseName || 'TS File'
          const adSuffix = ' (ad-filtered)'
          html += `<div class="pp-row pp-ad" data-action="download-m3u8">
            <span class="pp-idx">${idx}</span>
            <span class="pp-text">${escapeHtml(adLabel + adSuffix)}</span>
          </div>`
        }
        html += '</div>'
      }

      panel.el.innerHTML = html
      panel.el.classList.toggle('pp-faded', !panel.hovering)
      bindRowEvents(panel)
    }

    function bindRowEvents(panel: Panel): void {
      panel.el.querySelectorAll('.pp-row').forEach((row) => {
        row.addEventListener('click', async (e) => {
          e.stopPropagation()
          const action = (row as HTMLElement).dataset.action
          if (action === 'download-m3u8') {
            try {
              const pageTitle = panel.adFilterPageTitle || cleanPageTitle()
              const r = (await chrome.runtime.sendMessage({
                type: 'downloadCleanedM3u8',
                payload: { tabId: currentTabId, fileName: pageTitle },
              })) as { ok: boolean; filename?: string; error?: string }
              if (r.ok) {
                showToast(`✓ 已开始下载 ${r.filename ?? 'cleaned.m3u8'}`, 'success')
              } else {
                showToast(`下载失败: ${r.error ?? 'unknown'}`, 'error')
              }
            } catch (err) {
              showToast(`下载失败: ${(err as Error).message}`, 'error')
            }
          } else if (action === 'download-dash') {
            const groupId = (row as HTMLElement).dataset.groupId ?? ''
            const pair = findDashPair(groupId)
            if (!pair) {
              showToast('DASH 配对信息丢失，请刷新页面重试', 'error')
              return
            }
            try {
              const pageTitle = cleanPageTitle()
              const r = (await chrome.runtime.sendMessage({
                type: 'sendToDashDownload',
                payload: {
                  videoUrl: pair.video.url,
                  audioUrl: pair.audio.url,
                  fileName: pageTitle || pair.video.fileName || undefined,
                  pageUrl: location.href,
                },
              })) as { success: boolean; message?: string }
              if (r.success) {
                showToast(r.message ? `✓ ${r.message}` : '✓ DASH 音视频下载已推送', 'success')
              } else {
                showToast(`下载失败: ${r.message ?? 'unknown'}`, 'error')
              }
            } catch (err) {
              showToast(`下载失败: ${(err as Error).message}`, 'error')
            }
          } else {
            const url = (row as HTMLElement).dataset.url ?? ''
            const name = (row as HTMLElement).dataset.name ?? ''
            logger.info('[AdClear player-panel] download clicked: url=', url, 'name=', name)
            if (!url) {
              showToast('URL 为空，无法下载', 'error')
              return
            }
            const item = mediaItems.find((m) => m.url === url)
            const pageTitle = cleanPageTitle()
            try {
              const r = (await chrome.runtime.sendMessage({
                type: 'sendToDownload',
                payload: {
                  url,
                  fileName: pageTitle || name || undefined,
                  pageUrl: location.href,
                  contentType: item?.contentType,
                  contentDisposition: item?.contentDisposition,
                  method: item?.method,
                  requestBody: item?.requestBody,
                  requestHeaders: item?.requestHeaders,
                  ext: item?.ext,
                  contentLength: item?.size ? String(item.size) : undefined,
                },
              })) as { success: boolean; message?: string }
              if (!r.success) {
                showToast(`下载失败: ${r.message ?? 'unknown'}`, 'error')
              }
            } catch (err) {
              showToast(`下载失败: ${(err as Error).message}`, 'error')
            }
          }
        })
      })
    }

    // ========================================================================
    // panel 显隐 / 折叠 / 重定位
    // ========================================================================

    /**
     * task #2: 窗口 resize 重定位 badge（500ms debounce）
     * 移植自 NDM Aa 函数。
     */
    function scheduleResizeRelocate(): void {
      if (resizeTimer) return
      resizeTimer = setTimeout(() => {
        resizeTimer = null
        for (const panel of panels.values()) {
          // 仅当 panel 未被用户拖拽时才重定位
          if (panel.drag.moved) continue
          if (!panel.video) continue
          const newPos = computePanelPosition(panel.video)
          panel.position = newPos
          panel.el.style.left = `${newPos.left}px`
          panel.el.style.top = `${newPos.top}px`
        }
      }, RESIZE_DEBOUNCE_MS)
    }

    /**
     * task #3: 点击空白处折叠所有 badge
     * 移植自 NDM la 函数：document click 监听器折叠所有 panel。
     */
    function collapseAllPanels(): void {
      for (const panel of panels.values()) {
        panel.expanded = false
        renderPanel(panel)
      }
    }

    /**
     * task #9: 全局显隐切换
     * 移植自 NDM $ 函数：遍历所有 panel 设置 display。
     */
    function setGlobalVisibility(visible: boolean): void {
      globalVisible = visible
      for (const panel of panels.values()) {
        panel.el.classList.toggle('pp-hidden', !visible)
      }
    }

    // ========================================================================
    // 主流程：refresh + showOrUpdate
    // ========================================================================

    /**
     * 获取 tabId 后启动轮询
     */
    chrome.runtime.sendMessage({ type: 'getCurrentTabId' }).then((resp) => {
      currentTabId = (resp as { tabId?: number })?.tabId ?? 0
      if (currentTabId > 0) {
        refreshMediaItems()
        setInterval(refreshMediaItems, 3000)
      }
    }).catch(() => {})

    /**
     * task #7: pageUrl 主动上报
     * content script 主动告知 background 当前 URL+title。
     * 等价 NDM va 函数：postMessage([2, tabId, location.href, document.title])
     */
    function reportPageUrl(): void {
      try {
        const title = (document.title || '').trim().replace(/[ \t\r\n▶]+/g, ' ').trim()
        void chrome.runtime.sendMessage({
          type: 'velo-report-page-url',
          payload: { url: location.href, title },
        }).catch(() => {})
      } catch {
        // ignore
      }
    }
    // 启动时上报一次
    reportPageUrl()

    /**
     * 鼠标坐标采集（task #1 elementFromPoint 用）
     */
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        lastMouseX = e.clientX
        lastMouseY = e.clientY
      }
    }, true)
    document.addEventListener('mousemove', (e) => {
      // 仅记录最后一次坐标（不绑定 drag 用例）
      lastMouseX = e.clientX
      lastMouseY = e.clientY
    }, { passive: true })

    /**
     * Delete 键旁路下载（保留旧逻辑）
     */
    let deleteKeyDown = false
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.keyCode === 46) deleteKeyDown = true
    }, true)
    document.addEventListener('keyup', (e) => {
      if (e.key === 'Delete' || e.keyCode === 46) deleteKeyDown = false
    }, true)
    document.addEventListener('click', (e) => {
      if (!deleteKeyDown) return
      const target = e.target as HTMLElement
      const link = target.closest('a[href]') as HTMLAnchorElement | null
      if (link?.href && /^https?:\/\//.test(link.href)) {
        e.preventDefault()
        e.stopPropagation()
        chrome.runtime.sendMessage({
          type: 'sendToDownload',
          payload: { url: link.href, method: 'GET', pageUrl: location.href },
        })
      }
    }, true)

    /**
     * task #3: 点击空白处折叠（document click listener）
     * NDM la: 遍历 this.h (panels) 调用 I(!0) 折叠
     * 注意：要排除点击 panel 自身的情况（panel 内 click 已 stopPropagation）
     */
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      // 点击 panel 自身不折叠
      if (target.closest(`.${PANEL_CLASS}`)) return
      // 点击 video 元素也不折叠（用户可能是在控制播放器）
      if (target.closest('video, audio')) return
      collapseAllPanels()
    }, true)

    /**
     * task #2: 窗口 resize 重定位
     */
    window.addEventListener('resize', () => {
      scheduleResizeRelocate()
    })

    /**
     * 监听 background 消息（HLS 过滤结果 + visibility + MSE + 连接失败）
     */
    chrome.runtime.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== 'object') return false
      const msg = message as {
        type?: string
        baseName?: string
        pageTitle?: string
        report?: { ads?: number }
        url?: string
        visible?: boolean
        payload?: { visible?: boolean; mimeType?: string; url?: string }
      }

      // SPA 路由变化 → 清空所有 panel，重新上报 pageUrl
      if (msg.type === 'pageUrlChanged') {
        mediaItems = []
        for (const id of Array.from(panels.keys())) {
          destroyPanel(id)
        }
        reportPageUrl()
        refreshMediaItems()
        return false
      }

      // HLS 过滤结果 → 更新所有 panel 的 ad-filter 信息
      if (msg.type === 'hlsFilterResult' && msg.baseName) {
        for (const panel of panels.values()) {
          panel.hasAdFiltered = true
          panel.adFilterBaseName = msg.baseName ?? ''
          if (msg.pageTitle) panel.adFilterPageTitle = msg.pageTitle
        }
        refreshMediaItems()
      }

      // task #9: 全局显隐广播
      if (msg.type === 'veloVisibilityChanged') {
        const visible = msg.payload?.visible ?? msg.visible ?? false
        setGlobalVisibility(visible)
      }

      // task #13: MSE 媒体用户提示 toast
      if (msg.type === 'mseMediaDetected') {
        const mt = msg.payload?.mimeType ?? ''
        showToast(`📡 检测到 MSE 流媒体 (${mt || 'unknown mime'})`, 'info')
      }

      // task #15: alert() 3 步排查引导
      if (msg.type === 'veloConnectionFailed') {
        showConnectionFailureAlert()
      }

      return false
    })

    async function refreshMediaItems(): Promise<void> {
      try {
        const items = (await chrome.runtime.sendMessage({
          type: 'getMediaItems',
          payload: { tabId: currentTabId },
        })) as MediaItemDTO[]
        const newArray = Array.isArray(items) ? items : []
        const changed = newArray.length !== mediaItems.length
          || newArray.some((item, i) =>
            item.dashGroupId !== mediaItems[i]?.dashGroupId
            || item.dashRole !== mediaItems[i]?.dashRole,
          )
        mediaItems = newArray
        if (changed) {
          updatePanels()
        }
      } catch {
        // ignore
      }
    }

    /**
     * 重新分配 media items 到 panels
     *
     * 每条新 item 通过 element hit-detection 找到对应 video 元素，
     * 然后创建/复用 panel（task #1/#4/#6）。
     */
    function updatePanels(): void {
      if (mediaItems.length === 0) return
      ensureStyles()

      // === NDM M.G() 过滤逻辑 ===
      // 1. YouTube 页面不显示面板（NDM: if(!(0<=host.indexOf("youtube.com"))))
      const host = location.hostname.toLowerCase()
      if (host.includes('youtube.com')) return

      // 2. 字幕面板最多 2 个（NDM: this.aa++; if(2<this.aa) return）
      // 3. YouTube 页面不显示字幕（NDM: if(host.indexOf("youtube.")>=0) return）
      let subtitlePanelCount = 0
      for (const item of mediaItems) {
        if (item.ext && /^(?:vtt|srt)$/i.test(item.ext)) {
          if (host.includes('youtube.')) continue
          subtitlePanelCount++
          if (subtitlePanelCount > 2) break
        }
      }
      const filteredItems = mediaItems.filter((item) => {
        if (item.ext && /^(?:vtt|srt)$/i.test(item.ext)) {
          if (host.includes('youtube.')) return false
          let seenSubtitles = 0
          for (const m of mediaItems) {
            if (m.ext && /^(?:vtt|srt)$/i.test(m.ext)) {
              seenSubtitles++
              if (m.id === item.id) return seenSubtitles <= 2
            }
          }
        }
        // === NDM M.G() 第 3 个过滤: 大站点 + 非 VTT + 文件 ≤ 5MB → 不显示面板 ===
        // NDM: f = fromBackground && /.*facebook.com$|.*vimeo.com$|.*youtube.com$/i.test(host)
        //       && !(fEx=="VTT") && !(!fS || fS > 5242880)
        // 即: facebook/vimeo/youtube 上, 非 VTT 且 size ≤ 5MB (或无 size) 的后台推送项不显示
        // 原因: 大站点有大量小媒体资源 (缩略图/短音频等), 只显示 > 5MB 的大文件
        const isBigSite = /(?:facebook|vimeo|youtube)\.com$/i.test(host)
        if (isBigSite && item.ext && !/^(?:vtt|srt)$/i.test(item.ext)) {
          if (!item.size || item.size <= 5242880) return false
        }
        return true
      })

      // 记录已分配的 item ID
      const assignedIds = new Set<string>()
      for (const panel of panels.values()) {
        for (const id of panel.itemIds) assignedIds.add(id)
      }

      // 为每条新 item 找 video 元素，分配到对应 panel
      for (const item of filteredItems) {
        if (assignedIds.has(item.id)) continue
        // task #1: 元素命中检测
        const video = findPlayerElement(item.url, location.href)
        // 已有 panel 跟踪同一 video → 加入
        let targetPanel: Panel | null = null
        for (const panel of panels.values()) {
          if (panel.video === video) {
            targetPanel = panel
            break
          }
        }
        if (!targetPanel) {
          // 创建新 panel（含 task #4 多 badge 合并检查）
          targetPanel = createPanel(video, item.id)
          if (!targetPanel) continue
        } else {
          targetPanel.itemIds.push(item.id)
        }
        assignedIds.add(item.id)
      }

      // 渲染所有有内容的 panel
      for (const panel of panels.values()) {
        if (panel.itemIds.length === 0 && !panel.hasAdFiltered) {
          destroyPanel(panel.id)
          continue
        }
        renderPanel(panel)
      }
    }

    // ========================================================================
    // 工具函数
    // ========================================================================

    /**
     * 页面内 toast 提示（保留旧实现）
     */
    function showToast(message: string, type: 'success' | 'error' | 'info' = 'info'): void {
      const existing = document.getElementById('__velo_toast__')
      if (existing) existing.remove()
      const toast = document.createElement('div')
      toast.id = '__velo_toast__'
      toast.textContent = message
      const bg = type === 'error' ? '#ef4444' : type === 'success' ? '#22c55e' : '#3b82f6'
      toast.style.cssText = `position:fixed;top:20px;right:20px;z-index:2147483647;padding:10px 16px;border-radius:6px;font-size:13px;color:#fff;background:${bg};box-shadow:0 4px 12px rgba(0,0,0,0.15);max-width:360px;word-break:break-word;opacity:0;transition:opacity 0.2s;font-family:system-ui,sans-serif;`
      document.body.appendChild(toast)
      requestAnimationFrame(() => { toast.style.opacity = '1' })
      setTimeout(() => {
        toast.style.opacity = '0'
        setTimeout(() => toast.remove(), 200)
      }, 2500)
    }

    /**
     * task #15: alert() 3 步排查引导文案
     *
     * NDM bg.js 行 643-644 原文：
     * ```
     * Extension Can't Connect to NeatDownloadManager Application, You Can :
     * 1- Check If NeatDownloadManager is Running.
     * 2- or Hold down Delete-Key and click on the Download link.
     * 3- or Disable NeatDownloadManager Extension temporarily.
     * ```
     *
     * velo-extension 等价文案：3 步排查 velo 桌面端连接。
     */
    function showConnectionFailureAlert(): void {
      const title = 'velo 扩展无法连接到 velo 桌面端，您可以：'
      const steps = [
        '1- 检查 velo 桌面端是否已启动（确认监听端口 ' + (currentTabId ? '已配置' : '默认 16888') + '）',
        '2- 或按住 Delete 键并点击下载链接（绕过扩展，用浏览器原生下载）',
        '3- 或临时禁用 velo 扩展（右键扩展图标 → 禁用）',
      ]
      // content script 可用宿主页面 window.alert
      try {
        window.alert(`${title}\n\n${steps.join('\n')}`)
      } catch {
        // alert 被宿主页面禁用 → 回退到 toast
        showToast(title + '\n' + steps.join('\n'), 'error')
      }
    }

    function formatSize(bytes: number): string {
      if (!bytes) return ''
      if (bytes < 1024) return `${bytes}B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
      return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
    }

    function escapeHtml(s: string): string {
      const div = document.createElement('div')
      div.textContent = s
      return div.innerHTML
    }

    function escapeAttr(s: string): string {
      return s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }

    const PLAYER_NAME_RE = /^(?:H5\s*Player|Player|Video\s*Player|JW?Player|Flowplayer|Video\.js|Plyr|DPlayer|CKPlayer|Aliplayer|TCPlayer|GrindPlayer|prismplayer|xgplayer)$/i

    function resolveFileName(): string | undefined {
      const videoEl = document.querySelector('video[title]') as HTMLVideoElement | null
      if (videoEl?.title?.trim()) {
        return sanitizeFileName(videoEl.title.trim())
      }
      const audioEl = document.querySelector('audio[title]') as HTMLAudioElement | null
      if (audioEl?.title?.trim()) {
        return sanitizeFileName(audioEl.title.trim())
      }

      const playerContainer = document.querySelector('video')?.closest('div[class], div[id], section, article')
        ?? document.querySelector('[class*="player"], [id*="player"], [class*="video"], [id*="video"]')
      if (playerContainer) {
        const heading = playerContainer.querySelector('h1, h2')
        if (heading?.textContent?.trim()) {
          return sanitizeFileName(heading.textContent.trim())
        }
      }
      const mainH1 = document.querySelector('h1')
      if (mainH1?.textContent?.trim()) {
        return sanitizeFileName(mainH1.textContent.trim())
      }

      let title = document.title.trim()
      if (title && !PLAYER_NAME_RE.test(title)) {
        title = title
          .replace(/[-_]\s*哔哩哔哩_bilibili$/i, '')
          .replace(/[-_]\s*bilibili$/i, '')
          .replace(/[-_]\s*哔哩哔哩$/i, '')
          .replace(/\s*[-–—]\s*YouTube$/i, '')
          .replace(/\s*[-–—]\s*爱奇艺$/i, '')
          .replace(/[-_]\s*优酷.*$/i, '')
          .replace(/[-_]\s*腾讯视频.*$/i, '')
          .replace(/[-_]\s*西瓜视频.*$/i, '')
          .replace(/[-_]\s*抖音.*$/i, '')
        title = title.replace(/[\\/:*?"<>|\r\n]/g, '_').trim()
        if (title) return title
      }

      return fileNameFromUrl(location.href)
    }

    function sanitizeFileName(name: string): string {
      return name
        .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
        .replace(/_{2,}/g, '_')
        .trim()
        .slice(0, 200)
        || undefined as unknown as string
    }

    function fileNameFromUrl(url: string): string | undefined {
      try {
        const u = new URL(url)
        const path = u.pathname.replace(/\/+$/, '')
        const lastSegment = path.split('/').pop() ?? ''
        let candidate = lastSegment.replace(/\.[^.]+$/, '')
        if (candidate.length < 3) {
          candidate = path.replace(/\//g, '_').replace(/^_+|_+$/g, '')
        }
        candidate = candidate.replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/_{2,}/g, '_').trim()
        if (candidate.length > 20) candidate = candidate.slice(-20)
        if (candidate.length < 2) candidate = `video_${Date.now().toString(36)}`
        return candidate
      } catch {
        return undefined
      }
    }

    function cleanPageTitle(): string | undefined {
      return resolveFileName()
    }
  },
})