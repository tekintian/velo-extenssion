/**
 * HLS 广告过滤角标 — 严格移植 NDM badge.js
 *
 * 三个 UI 元素（全部在页面层，不在播放器内）:
 *
 * 1. 右下角角标 (badge):
 *    显示广告检测结果 — 已过滤广告分片数 / 广告时长 / 内容时长 / 命中规则
 *    高亮 6s + 半透明 12s 后隐藏
 *
 * 2. 顶部 toast (AdSkip):
 *    自动跳过广告时显示「⏭ 已自动跳过广告 Xs」
 *    2.5s 后淡出
 *
 * 3. 左上角下载按钮:
 *    检测到 m3u8 广告后才显示 — 「📥 下载去广告 m3u8 (N 广告已过滤)」
 *    点击 → 调 background downloadCleanedM3u8
 */

import { defineContentScript } from 'wxt/sandbox'
import { logger } from '@/lib/logger'

const BADGE_ID = '__adclear_hls_badge__'
const STYLE_ID = '__adclear_hls_badge_style__'
const TOAST_ID = '__adclear_adskip_toast'
const DL_BTN_ID = '__adclear_dl_btn'
const FADE_MS = 12000
const VISIBLE_MS = 6000

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: false,
  runAt: 'document_idle',

  main() {
    try {
      if (window.self !== window.top) return
    } catch {
      // cross-origin top → 也在顶层，继续
    }

    let stats: BadgeStats | null = null
    let fadeTimer: ReturnType<typeof setTimeout> | null = null
    let visibleTimer: ReturnType<typeof setTimeout> | null = null
    let dismissed = false

    // AdSkip 状态
    const adSkipState = {
      ranges: [] as Array<{ start: number; end: number; duration: number; runtime?: boolean }>,
      skipping: false,
      observer: null as MutationObserver | null,
      prevTime: 0,
      seekbarResetCount: 0,
      inRuntimeAd: false,
      runtimeAdStart: 0,
    }

    interface BadgeStats {
      ads: number
      adDuration: number
      contentDuration: number
      reports: number
      ruleName: string | null
      lastUpdate: number
    }

    // 监听 background 消息
    chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      if (!message || typeof message !== 'object') return false
      const msg = message as { type?: string; report?: unknown; adRanges?: unknown; baseName?: string; pageTitle?: string }
      if (msg.type === 'hlsFilterReport') {
        handleReport(msg.report as { ads?: number; adDuration?: number; contentDuration?: number; appliedRule?: { name?: string } | null } | undefined)
      }
      if (msg.type === 'hlsFilterResult') {
        // 有广告区间时设 AdSkipper
        if (msg.adRanges && (msg.adRanges as unknown[]).length > 0) {
          setupAdSkipper(msg.adRanges as Array<{ start: number; end: number; duration: number }>)
        }
        // 有 baseName 时显示下载按钮（即使无广告也显示，用户可下载清洗后的 m3u8）
        if (msg.baseName) {
          const displayName = msg.pageTitle || msg.baseName
          showDownloadButton(displayName, (msg.report as { ads?: number } | undefined)?.ads ?? 0)
        }
      }
      // 响应 popup 的播放状态查询（保存广告样本时需要 currentTime）
      if (msg.type === 'getPlayback') {
        const v = findVideo()
        if (v) {
          sendResponse({ ok: true, currentTime: v.currentTime || 0, duration: v.duration || 0, src: v.currentSrc || v.src || '' })
        } else {
          sendResponse({ ok: false, error: '未找到 video 元素' })
        }
        return true // 异步 sendResponse
      }
      return false
    })

    function handleReport(report: { ads?: number; adDuration?: number; contentDuration?: number; appliedRule?: { name?: string } | null } | undefined): void {
      if (!report) return
      // 读配置检查 showPageBadge 开关
      chrome.storage.local.get(['hlsFilterConfig'], (cfg) => {
        const c = (cfg?.hlsFilterConfig as { showPageBadge?: boolean }) ?? {}
        if (c.showPageBadge === false) return // 用户关闭了角标
        doShow(report)
      })
    }

    function doShow(report: { ads?: number; adDuration?: number; contentDuration?: number; appliedRule?: { name?: string } | null }): void {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => doShow(report), { once: true })
        return
      }
      const el = ensureBadge()
      if (!el || dismissed) return

      if (!stats) {
        stats = { ads: 0, adDuration: 0, contentDuration: 0, reports: 0, ruleName: null, lastUpdate: 0 }
      }
      stats.ads += report.ads ?? 0
      stats.adDuration += report.adDuration ?? 0
      stats.contentDuration = report.contentDuration ?? stats.contentDuration
      stats.reports += 1
      if (report.appliedRule?.name) stats.ruleName = report.appliedRule.name
      stats.lastUpdate = Date.now()

      render(el, stats)
      el.style.display = 'block'
      el.classList.remove('faded')

      if (visibleTimer) clearTimeout(visibleTimer)
      if (fadeTimer) clearTimeout(fadeTimer)
      visibleTimer = setTimeout(() => el.classList.add('faded'), VISIBLE_MS)
      fadeTimer = setTimeout(() => {
        el.style.display = 'none'
      }, FADE_MS)
    }

    function setupAdSkipper(adRanges: Array<{ start: number; end: number; duration: number }>): void {
      if (!adRanges || adRanges.length === 0) return
      // 读配置检查 enableAdSkip 开关
      chrome.storage.local.get(['hlsFilterConfig'], (cfg) => {
        const c = (cfg?.hlsFilterConfig as { enableAdSkip?: boolean }) ?? {}
        if (c.enableAdSkip === false) return // 用户关闭了页面跳过
        adSkipState.ranges = adRanges
        const v = findVideo()
        if (v) {
          attachSkipper(v)
        } else {
          if (adSkipState.observer) adSkipState.observer.disconnect()
          adSkipState.observer = new MutationObserver(() => {
            const vv = findVideo()
            if (vv) {
              attachSkipper(vv)
              if (adSkipState.observer) {
                adSkipState.observer.disconnect()
                adSkipState.observer = null
              }
            }
          })
          adSkipState.observer.observe(document.documentElement ?? document.body!, { childList: true, subtree: true })
        }
        logger.info('[AdClear AdSkip] 监听', adRanges.length, '个广告区间')
      })
    }

    function findVideo(): HTMLVideoElement | null {
      let v = document.querySelector('video')
      if (!v) {
        const ifs = document.querySelectorAll('iframe')
        for (const f of ifs) {
          try {
            v = (f.contentDocument?.querySelector('video') as HTMLVideoElement) ?? null
            if (v) break
          } catch {
            // cross-origin
          }
        }
      }
      return v
    }

    function attachSkipper(video: HTMLVideoElement): void {
      if ((video as HTMLVideoElement & { _adclearSkipAttached?: boolean })._adclearSkipAttached) return
      ;(video as HTMLVideoElement & { _adclearSkipAttached?: boolean })._adclearSkipAttached = true
      video.addEventListener('timeupdate', () => {
        const t = video.currentTime
        // 运行时广告结束检测
        if (adSkipState.inRuntimeAd && t > adSkipState.runtimeAdStart + 5 && !adSkipState.skipping) {
          const range = { start: adSkipState.runtimeAdStart, end: t, duration: t - adSkipState.runtimeAdStart, runtime: true }
          adSkipState.ranges.push(range)
          adSkipState.inRuntimeAd = false
          showSkipToast(`⏭ 运行时检测到广告 ${range.duration.toFixed(1)}s (已记录, 下次自动跳过)`)
          adSkipState.prevTime = t
          return
        }
        // 运行时 seekbar 重置检测
        if (!adSkipState.skipping && adSkipState.prevTime > 30 && t < adSkipState.prevTime - 10 && t < 30) {
          adSkipState.seekbarResetCount++
          adSkipState.inRuntimeAd = true
          adSkipState.runtimeAdStart = adSkipState.prevTime
          showSkipToast('⏭ 检测到广告插入 (seekbar 重置), 记录中...')
          adSkipState.prevTime = t
          return
        }
        // 常规广告区间跳过
        if (!adSkipState.skipping && adSkipState.ranges.length > 0) {
          for (const r of adSkipState.ranges) {
            if (t >= r.start && t < r.end) {
              adSkipState.skipping = true
              video.currentTime = r.end + 0.05
              showSkipToast(`⏭ 已自动跳过广告 ${(r.duration || 0).toFixed(1)}s`)
              setTimeout(() => {
                adSkipState.skipping = false
              }, 500)
              break
            }
          }
        }
        adSkipState.prevTime = t
      })
    }

    function showSkipToast(text: string): void {
      try {
        let t = document.getElementById(TOAST_ID)
        if (!t) {
          t = document.createElement('div')
          t.id = TOAST_ID
          t.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
            'background:#059669;color:#fff;font:600 13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;' +
            'padding:8px 16px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.25);' +
            'transition:opacity .3s;opacity:0;pointer-events:none;'
          ;(document.body ?? document.documentElement).appendChild(t)
        }
        t.textContent = text
        t.style.opacity = '1'
        clearTimeout((t as HTMLElement & { _timer?: ReturnType<typeof setTimeout> })._timer)
        ;(t as HTMLElement & { _timer?: ReturnType<typeof setTimeout> })._timer = setTimeout(() => {
          t!.style.opacity = '0'
        }, 2500)
      } catch {
        // ignore
      }
    }

    function showDownloadButton(displayName: string, adCount: number): void {
      try {
        let btn = document.getElementById(DL_BTN_ID) as HTMLDivElement | null
        if (!btn) {
          btn = document.createElement('div')
          btn.id = DL_BTN_ID
          btn.style.cssText = 'position:fixed;left:12px;top:12px;z-index:2147483647;' +
            'background:#059669;color:#fff;font:600 12px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;' +
            'padding:8px 14px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer;' +
            'transition:opacity .3s;opacity:0;user-select:none;'
          btn.addEventListener('click', async () => {
            btn!.textContent = '⏬ 下载中...'
            try {
              // content script 不能用 chrome.tabs.query，通过 background 获取 tabId
              const tabResp = (await chrome.runtime.sendMessage({ type: 'getCurrentTabId' })) as { tabId?: number }
              const r = (await chrome.runtime.sendMessage({
                type: 'downloadCleanedM3u8',
                payload: { tabId: tabResp?.tabId ?? 0, fileName: document.title.replace(/[\\/:*?"<>|]/g, '_').replace(/[-_]\s*哔哩哔哩_bilibili$/i, '').replace(/[-_]\s*bilibili$/i, '').replace(/[-_]\s*哔哩哔哩$/i, '').trim() || undefined },
              })) as { ok: boolean; filename?: string; error?: string }
              if (r.ok) {
                btn!.textContent = '✓ 已下载 ' + (r.filename ?? 'cleaned.m3u8')
                btn!.style.background = '#0f766e'
                setTimeout(() => {
                  btn!.style.opacity = '0'
                }, 3000)
              } else {
                btn!.textContent = '✗ ' + (r.error ?? '下载失败')
                btn!.style.background = '#dc2626'
                setTimeout(() => {
                  btn!.textContent = '📥 下载去广告 m3u8'
                  btn!.style.background = '#059669'
                }, 2500)
              }
            } catch (e) {
              btn!.textContent = '✗ ' + (e as Error).message
            }
          })
          ;(document.body ?? document.documentElement).appendChild(btn)
        }
        btn.textContent = '📥 下载去广告 m3u8' + (adCount > 0 ? ` (${adCount} 广告已过滤)` : '') + '\n📁 ' + displayName + '_cleaned.m3u8'
        btn.style.whiteSpace = 'pre-line'
        btn.style.background = '#059669'
        btn.style.opacity = '1'
      } catch {
        // ignore
      }
    }

    function ensureBadge(): HTMLElement | null {
      ensureStyles()
      let el = document.getElementById(BADGE_ID)
      if (el) return el
      el = document.createElement('div')
      el.id = BADGE_ID
      el.innerHTML = `
        <div class="b-hd">
          <div class="b-title"><span class="b-dot"></span><span>AdClear 广告过滤</span></div>
          <span class="b-close" title="关闭">×</span>
        </div>
        <div class="b-body">
          <div class="b-row"><span>已过滤广告分片</span><b class="b-ads">0</b></div>
          <div class="b-row"><span>广告时长</span><b class="b-adv">0s</b></div>
          <div class="b-row"><span>内容时长</span><b class="b-cv">0s</b></div>
          <div class="b-rule" style="display:none"></div>
        </div>
      `
      document.documentElement.appendChild(el)

      // 拖拽
      let dragging = false
      let sx = 0, sy = 0, sl = 0, st = 0
      el.addEventListener('mousedown', (e) => {
        if ((e.target as HTMLElement).classList.contains('b-close')) return
        dragging = true
        sx = e.clientX
        sy = e.clientY
        const rect = el!.getBoundingClientRect()
        sl = rect.left
        st = rect.top
        el!.style.right = 'auto'
        el!.style.bottom = 'auto'
        e.preventDefault()
      })
      document.addEventListener('mousemove', (e) => {
        if (!dragging) return
        el!.style.left = `${sl + e.clientX - sx}px`
        el!.style.top = `${st + e.clientY - sy}px`
      })
      document.addEventListener('mouseup', () => {
        dragging = false
      })

      // 关闭
      el.querySelector('.b-close')?.addEventListener('click', (e) => {
        e.stopPropagation()
        dismissed = true
        el!.style.display = 'none'
      })

      return el
    }

    function ensureStyles(): void {
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
        #__adclear_hls_badge {
          position: fixed; right: 12px; bottom: 12px; z-index: 2147483647;
          background: rgba(15,15,23,.92); color: #fff;
          font: 11px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
          border-radius: 10px; padding: 8px 10px;
          min-width: 180px; max-width: 260px;
          box-shadow: 0 4px 14px rgba(0,0,0,.25);
          backdrop-filter: blur(6px);
          transition: opacity .4s; opacity: 1;
          cursor: move; user-select: none;
          display: none;
        }
        #__adclear_hls_badge.faded { opacity: .55; }
        #__adclear_hls_badge .b-hd { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
        #__adclear_hls_badge .b-title { font-weight: 600; font-size: 11px; display: flex; align-items: center; gap: 5px; }
        #__adclear_hls_badge .b-dot { width: 7px; height: 7px; border-radius: 50%; background: #059669; box-shadow: 0 0 6px #10b981; }
        #__adclear_hls_badge .b-close { cursor: pointer; color: #a8a29e; font-size: 13px; line-height: 1; padding: 0 2px; }
        #__adclear_hls_badge .b-close:hover { color: #fff; }
        #__adclear_hls_badge .b-body { font-size: 11px; }
        #__adclear_hls_badge .b-row { display: flex; justify-content: space-between; padding: 2px 0; color: #d4d4d8; }
        #__adclear_hls_badge .b-row b { color: #10b981; font-weight: 600; }
        #__adclear_hls_badge .b-rule { margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(255,255,255,.1); font-size: 10px; color: #a8a29e; }
      `
      document.head?.appendChild(style)
    }

    function render(el: HTMLElement, s: BadgeStats): void {
      const adsEl = el.querySelector('.b-ads')
      const advEl = el.querySelector('.b-adv')
      const cvEl = el.querySelector('.b-cv')
      const ruleEl = el.querySelector('.b-rule') as HTMLElement | null
      if (adsEl) adsEl.textContent = String(s.ads)
      if (advEl) advEl.textContent = fmtDur(s.adDuration)
      if (cvEl) cvEl.textContent = fmtDur(s.contentDuration)
      if (ruleEl) {
        if (s.ruleName && s.reports > 0) {
          ruleEl.style.display = ''
          ruleEl.textContent = `命中规则: ${s.ruleName}`
        } else {
          ruleEl.style.display = 'none'
        }
      }
    }

    function fmtDur(sec: number): string {
      const s = Math.round(sec || 0)
      if (s < 60) return `${s}s`
      const m = Math.floor(s / 60)
      const r = s % 60
      return `${m}m${r ? `${r}s` : ''}`
    }

    logger.info('[AdClear badge] content script loaded')
  },
})
