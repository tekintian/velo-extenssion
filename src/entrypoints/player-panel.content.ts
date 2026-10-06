/**
 * 播放器内媒体下载提示 — 严格移植 NDM ct.js
 *
 * 原版设计：
 *   - 紧贴视频播放器画面内部左上角
 *   - 默认单行紧凑（折叠态），只显示文件数 + 第一项
 *   - 点击展开 → 显示完整文件列表
 *   - 鼠标移出 → 自动半透明 + 折叠
 *   - 鼠标移入 → 恢复不透明 + 展开
 *   - 多个媒体项不重叠，只有一个面板
 */

import { defineContentScript } from 'wxt/sandbox'
import { logger } from '@/lib/logger'

const PANEL_ID = '__adclear_player_panel__'
const STYLE_ID = '__adclear_player_panel_style__'

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  runAt: 'document_idle',

  main() {
    let currentTabId = 0
    let mediaItems: MediaItemDTO[] = []
    let hasAdFiltered = false
    let adFilterBaseName = ''
    let panel: HTMLDivElement | null = null
    let isExpanded = false
    let isHovering = false
    let fadeTimer: ReturnType<typeof setTimeout> | null = null

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

    // 获取 tabId
    chrome.runtime.sendMessage({ type: 'getCurrentTabId' }).then((resp) => {
      currentTabId = (resp as { tabId?: number })?.tabId ?? 0
      if (currentTabId > 0) {
        refreshMediaItems()
        setInterval(refreshMediaItems, 3000)
      }
    }).catch(() => {})

    // Delete 键旁路下载 (移植自 NDM ct.js M.R)
    // 按住 Delete 键点击链接 → 绕过 NDM，用浏览器原生下载
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
        // 用浏览器原生下载
        chrome.runtime.sendMessage({
          type: 'sendToDownload',
          payload: { url: link.href, method: 'GET', pageUrl: location.href },
        })
      }
    }, true)

    // 监听 SPA 路由变化 + HLS 过滤结果
    chrome.runtime.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== 'object') return false
      const msg = message as { type?: string; baseName?: string; report?: { ads?: number }; url?: string }

      // SPA 路由变化
      if (msg.type === 'pageUrlChanged') {
        mediaItems = []
        hasAdFiltered = false
        adFilterBaseName = ''
        if (panel) {
          panel.remove()
          panel = null
        }
        refreshMediaItems()
        return false
      }

      // HLS 过滤结果
      if (msg.type === 'hlsFilterResult' && msg.baseName) {
        hasAdFiltered = true
        adFilterBaseName = msg.baseName
        refreshMediaItems()
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
        const dashChanged = newArray.some((item, i) =>
          item.dashGroupId !== mediaItems[i]?.dashGroupId
          || item.dashRole !== mediaItems[i]?.dashRole,
        )
        if (newArray.length !== mediaItems.length || hasAdFiltered || dashChanged) {
          mediaItems = newArray
          showOrUpdatePanel()
        } else {
          mediaItems = newArray
        }
      } catch {
        // ignore
      }
    }

    function showOrUpdatePanel(): void {
      if (mediaItems.length === 0 && !hasAdFiltered) return

      ensureStyles()

      // 找到 video 元素的父容器
      const video = findVideoElement()
      const container = video?.parentElement ?? null
      if (!container) return

      // 确保 container 是 relative 定位
      if (getComputedStyle(container).position === 'static') {
        container.style.position = 'relative'
      }

      // 如果面板不在 container 里，移到 container 里
      if (!panel) {
        panel = document.createElement('div')
        panel.id = PANEL_ID
        container.appendChild(panel)
        bindPanelEvents()
      } else if (panel.parentElement !== container) {
        container.appendChild(panel)
      }

      renderPanel()
    }

    function findDashPair(groupId: string): { video: MediaItemDTO; audio: MediaItemDTO } | null {
      const video = mediaItems.find((m) => m.dashGroupId === groupId && m.dashRole === 'video')
      const audio = mediaItems.find((m) => m.dashGroupId === groupId && m.dashRole === 'audio')
      if (video && audio) return { video, audio }
      return null
    }

    function renderPanel(): void {
      if (!panel) return

      // 统计 DASH 配对数和未配对数
      const dashGroupIds = new Set<string>()
      for (const item of mediaItems) {
        if (item.dashGroupId) dashGroupIds.add(item.dashGroupId)
      }
      const dashPairCount = dashGroupIds.size
      const nonDashCount = mediaItems.filter((m) => !m.dashGroupId).length
      const totalCount = dashPairCount + nonDashCount + (hasAdFiltered ? 1 : 0)

      const firstItem = mediaItems[0]
      const firstLabel = dashPairCount > 0
        ? `DASH ${dashPairCount}组 + ${nonDashCount}文件`
        : firstItem
          ? `${firstItem.ext.toUpperCase()} File ${formatSize(firstItem.size)}`
          : hasAdFiltered
            ? adFilterBaseName ? `${adFilterBaseName} (ad-filtered)` : 'TS File (ad-filtered)'
            : ''

      // 折叠态：单行
      let html = `
        <div class="pp-bar" >
          <span class="pp-icon">N</span>
          <span class="pp-label">${escapeHtml(firstLabel)}</span>
          <span class="pp-count">${totalCount}</span>
          <span class="pp-toggle">${isExpanded ? '−' : '+'}</span>
        </div>
      `

      // 展开态：完整列表
      if (isExpanded) {
        html += '<div class="pp-list">'
        let idx = 1
        const renderedDashGroups = new Set<string>()
        for (const item of mediaItems) {
          // DASH 配对项：只渲染一次合并下载行
          if (item.dashGroupId) {
            if (renderedDashGroups.has(item.dashGroupId)) continue
            renderedDashGroups.add(item.dashGroupId)
            const pair = findDashPair(item.dashGroupId)
            if (pair) {
              html += `<div class="pp-row pp-dash" data-action="download-dash" data-group-id="${escapeAttr(item.dashGroupId)}">
                <span class="pp-idx">${idx}</span>
                <span class="pp-text pp-dash-label">🎬 合并下载 (V+A)</span>
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
        if (hasAdFiltered) {
          const adLabel = adFilterBaseName ? `${adFilterBaseName} (ad-filtered)` : 'TS File (ad-filtered)'
          html += `<div class="pp-row pp-ad" data-action="download-m3u8">
            <span class="pp-idx">${idx}</span>
            <span class="pp-text">${escapeHtml(adLabel)}</span>
          </div>`
        }
        html += '</div>'
      }

      panel.innerHTML = html
      panel.classList.toggle('pp-faded', !isHovering)
      bindRowEvents()
    }

    function bindPanelEvents(): void {
      if (!panel) return
      // 点击 bar 展开/折叠
      panel.addEventListener('click', (e) => {
        const target = e.target as HTMLElement
        if (target.classList.contains('pp-toggle') || target.classList.contains('pp-bar') || target.classList.contains('pp-icon') || target.classList.contains('pp-label') || target.classList.contains('pp-count')) {
          isExpanded = !isExpanded
          renderPanel()
        }
      })
      // 鼠标移入 → 不透明
      panel.addEventListener('mouseenter', () => {
        isHovering = true
        if (fadeTimer) clearTimeout(fadeTimer)
        panel!.classList.remove('pp-faded')
      })
      // 鼠标移出 → 半透明 + 折叠
      panel.addEventListener('mouseleave', () => {
        isHovering = false
        if (fadeTimer) clearTimeout(fadeTimer)
        fadeTimer = setTimeout(() => {
          isExpanded = false
          renderPanel()
        }, 500)
      })
    }

    function bindRowEvents(): void {
      if (!panel) return
      panel.querySelectorAll('.pp-row').forEach((row) => {
        row.addEventListener('click', async (e) => {
          e.stopPropagation()
          const action = (row as HTMLElement).dataset.action
          if (action === 'download-m3u8') {
            try {
              const pageTitle = cleanPageTitle()
              const r = (await chrome.runtime.sendMessage({
                type: 'downloadCleanedM3u8',
                payload: { tabId: currentTabId, fileName: pageTitle },
              })) as { ok: boolean; filename?: string; error?: string }
              if (r.ok) {
                alert(`✓ 已开始下载 ${r.filename ?? 'cleaned.m3u8'}`)
              } else {
                alert(`下载失败: ${r.error ?? 'unknown'}`)
              }
            } catch (err) {
              alert(`下载失败: ${(err as Error).message}`)
            }
          } else if (action === 'download-dash') {
            const groupId = (row as HTMLElement).dataset.groupId ?? ''
            const pair = findDashPair(groupId)
            if (!pair) {
              alert('DASH 配对信息丢失，请刷新页面重试')
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
                alert(r.message ? `✓ ${r.message}` : '✓ DASH 音视频下载已推送')
              } else {
                alert(`下载失败: ${r.message ?? 'unknown'}`)
              }
            } catch (err) {
              alert(`下载失败: ${(err as Error).message}`)
            }
          } else {
            const url = (row as HTMLElement).dataset.url ?? ''
            const name = (row as HTMLElement).dataset.name ?? ''
            logger.info('[AdClear player-panel] download clicked: url=', url, 'name=', name)
            if (!url) {
              alert('URL 为空，无法下载')
              return
            }
            // 找到对应的 mediaItem 传递完整信息
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
                },
              })) as { success: boolean; message?: string }
              if (!r.success) {
                alert(`下载失败: ${r.message ?? 'unknown'}`)
              }
            } catch (err) {
              alert(`下载失败: ${(err as Error).message}`)
            }
          }
        })
      })
    }

    function findVideoElement(): HTMLVideoElement | null {
      return document.querySelector('video')
    }

    function ensureStyles(): void {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
        #__adclear_player_panel__ {
          position: absolute; top: 4px; left: 4px; z-index: 2147483647;
          background: rgba(15,15,23,.85); color: #fff; border-radius: 6px;
          overflow: hidden; min-width: 180px; max-width: 280px;
          font: 11px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
          transition: opacity .3s; opacity: 1;
          box-shadow: 0 2px 8px rgba(0,0,0,.3);
        }
        #__adclear_player_panel__.pp-faded { opacity: .35; }
        #__adclear_player_panel__ .pp-bar {
          display: flex; align-items: center; gap: 6px;
          padding: 4px 8px; cursor: pointer;
        }
        #__adclear_player_panel__ .pp-icon {
          width: 16px; height: 16px; border-radius: 50%;
          background: #10b981; color: #fff; font-weight: 700; font-size: 9px;
          display: flex; align-items: center; justify-content: center; flex-shrink: 0;
        }
        #__adclear_player_panel__ .pp-label {
          flex: 1; color: #d4d4d8; font-size: 10px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        #__adclear_player_panel__ .pp-count {
          color: #10b981; font-weight: 600; font-size: 10px; flex-shrink: 0;
        }
        #__adclear_player_panel__ .pp-toggle {
          color: rgba(255,255,255,.5); font-size: 12px; cursor: pointer; flex-shrink: 0;
        }
        #__adclear_player_panel__ .pp-list { border-top: 1px solid rgba(255,255,255,.1); }
        #__adclear_player_panel__ .pp-row {
          display: flex; align-items: center; gap: 6px;
          padding: 4px 8px; cursor: pointer;
          border-bottom: 1px solid rgba(255,255,255,.05);
        }
        #__adclear_player_panel__ .pp-row:hover { background: rgba(16,185,129,.1); }
        #__adclear_player_panel__ .pp-row:last-child { border-bottom: none; }
        #__adclear_player_panel__ .pp-idx { color: #10b981; font-weight: 600; width: 12px; text-align: right; flex-shrink: 0; }
        #__adclear_player_panel__ .pp-text { color: #d4d4d8; font-size: 10px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #__adclear_player_panel__ .pp-ad .pp-text { color: #10b981; }
        #__adclear_player_panel__ .pp-dash { background: rgba(251,191,36,.12); cursor: pointer; }
        #__adclear_player_panel__ .pp-dash:hover { background: rgba(251,191,36,.22); }
        #__adclear_player_panel__ .pp-dash .pp-dash-label { color: #fbbf24; font-weight: 700; }
        #__adclear_player_panel__ .pp-dash-sub { padding-left: 20px; }
        #__adclear_player_panel__ .pp-dash-sub .pp-text { color: #a1a1aa; font-size: 9px; }
      `
      ;(document.head ?? document.documentElement).appendChild(style)
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
      // Level 1: video/audio 元素的 title 属性
      const videoEl = document.querySelector('video[title]') as HTMLVideoElement | null
      if (videoEl?.title?.trim()) {
        return sanitizeFileName(videoEl.title.trim())
      }
      const audioEl = document.querySelector('audio[title]') as HTMLAudioElement | null
      if (audioEl?.title?.trim()) {
        return sanitizeFileName(audioEl.title.trim())
      }

      // Level 2: 播放器附近的 h1/h2 标签
      const playerContainer = document.querySelector('video')?.closest('div[class], div[id], section, article')
        ?? document.querySelector('[class*="player"], [id*="player"], [class*="video"], [id*="video"]')
      if (playerContainer) {
        const heading = playerContainer.querySelector('h1, h2')
        if (heading?.textContent?.trim()) {
          return sanitizeFileName(heading.textContent.trim())
        }
      }
      // fallback: 页面主 h1
      const mainH1 = document.querySelector('h1')
      if (mainH1?.textContent?.trim()) {
        return sanitizeFileName(mainH1.textContent.trim())
      }

      // Level 3: 页面 <title> 标签（排除播放器名称）
      let title = document.title.trim()
      if (title && !PLAYER_NAME_RE.test(title)) {
        title = title
          .replace(/[-_]\s*哔哩哔哩_bilibili$/i, '')
          .replace(/[-_]\s*bilibili$/i, '')
          .replace(/[-_]\s*哔哩哔哩$/i, '')
          .replace(/\s*[-–—]\s*YouTube$/i, '')
          .replace(/\s*[-–—]\s*爱奇艺$/i, '')
          .replace(/\s*[-_]\s*优酷.*$/i, '')
          .replace(/\s*[-_]\s*腾讯视频.*$/i, '')
          .replace(/\s*[-_]\s*西瓜视频.*$/i, '')
          .replace(/\s*[-_]\s*抖音.*$/i, '')
        title = title.replace(/[\\/:*?"<>|\r\n]/g, '_').trim()
        if (title) return title
      }

      // Level 4: URL 尾部字符去特殊符号
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
