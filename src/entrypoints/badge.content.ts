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

import { defineContentScript } from 'wxt/utils/define-content-script'
import { logger } from '@/lib/logger'
import { i18n } from '@/lib/i18n'
import { sendMessage, onMessageAddListener } from '@/lib/runtime'

const BADGE_ID = '__adclear_hls_badge__'
const STYLE_ID = '__adclear_hls_badge_style__'
const TOAST_ID = '__adclear_adskip_toast'
const DL_BTN_ID = '__adclear_dl_btn'
const FADE_MS = 12000
const VISIBLE_MS = 6000

const BAD_TITLE_RE =
  /^(?:index|home|homepage|main|default|start|top|bottom|left|right|middle|center|content|body|page|p|menu|header|footer|sidebar|aside|section|wrapper|container|app|root|layout|component|video|player|h5\s*player|web\s*player|online\s*player|online|play|index\.html|home\.html|main\.html|default\.html|404|500|error|not\s*found|loading|正在加载|加载中|页面加载中|new\s*tab|新标签页|无标题|无标题文档|untitled|unknown|test|demo|sample|example|mixed|playlist|master|vod|hls|dash|audio|segment|segments|ts|m3u8|mp4|flv|3gp|img|images|image|photo|pic|thumb|thumbnail|cdn|static|public|assets|resource|resources|file|files|stream|streams|media|live|origin|backup|temp|tmp|cache|tempfile|downloads|download|upload|uploads|api|admin|user|login|register|auth|profile|search|list|all|new|create|edit|delete|update|view|show|add|remove)$/i

function resolveBadgeFileName(): string | undefined {
  function isMeaningful(name: string | null | undefined): boolean {
    if (!name) return false
    const trimmed = name.trim()
    if (!trimmed) return false
    if (trimmed.length < 3) return false
    if (BAD_TITLE_RE.test(trimmed)) return false
    if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(trimmed)) return false
    return true
  }
  function sanitize(n: string): string {
    return n.replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/_{2,}/g, '_').trim().slice(0, 200)
  }
  const og = document.querySelector('meta[property="og:title"]') as HTMLMetaElement | null
  if (og?.content?.trim()) {
    const t = sanitize(og.content.trim())
    if (isMeaningful(t)) return t
  }
  let title = document.title.trim()
  if (title) {
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
    title = sanitize(title)
    if (isMeaningful(title)) return title
  }
  try {
    const u = new URL(location.href)
    const segs = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean)
    const meaningful = segs
      .map((s) => s.replace(/\.[^.]+$/, ''))
      .filter((s) => s.length >= 3 && !BAD_TITLE_RE.test(s))
    let name = meaningful.join('_')
    if (!name) {
      const fallback = segs.map((s) => s.replace(/\.[^.]+$/, '')).filter((s) => !BAD_TITLE_RE.test(s))
      name = fallback.join('_') || u.hostname.replace(/^www\./, '')
    }
    return sanitize(name)
  } catch {
    return undefined
  }
}

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  runAt: 'document_idle',

  main() {
    if (window.self !== window.top) {
      runAdSkipInFrame()
      return
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

    function destroyBadge(): void {
      const el = document.getElementById(BADGE_ID)
      if (el) el.remove()
      const style = document.getElementById(STYLE_ID)
      if (style) style.remove()
      const btn = document.getElementById(DL_BTN_ID)
      if (btn) btn.remove()
      const toast = document.getElementById(TOAST_ID)
      if (toast) toast.remove()
      stats = null
      dismissed = false
      if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null }
      if (visibleTimer) { clearTimeout(visibleTimer); visibleTimer = null }
      adSkipState.ranges = []
      adSkipState.skipping = false
      adSkipState.inRuntimeAd = false
      if (adSkipState.observer) { adSkipState.observer.disconnect(); adSkipState.observer = null }
    }

    // 监听 background 消息
    onMessageAddListener((message: unknown, _sender, sendResponse) => {
      if (!message || typeof message !== 'object') return false
      const msg = message as { type?: string; report?: unknown; adRanges?: unknown; baseName?: string; pageTitle?: string; payload?: { visible?: boolean } }
      if (msg.type === 'hlsFilterReport') {
        handleReport(msg.report as { ads?: number; adDuration?: number; contentDuration?: number; appliedRule?: { name?: string } | null } | undefined)
      }
      if (msg.type === 'hlsFilterResult') {
        console.info('[AdClear AdSkip][DIAG-4] hlsFilterResult received, adRanges:', (msg.adRanges as unknown[] | undefined)?.length ?? 0, 'baseName:', msg.baseName)
        // 页面播放始终是原始列表，区间有效即直接安装跳过器
        if (msg.adRanges && (msg.adRanges as unknown[]).length > 0) {
          setupAdSkipper(
            msg.adRanges as Array<{ start: number; end: number; duration: number }>,
          )
        }
        if (msg.baseName) {
          const displayName = resolveBadgeFileName() ?? msg.pageTitle ?? msg.baseName
          showDownloadButton(displayName, (msg.report as { ads?: number } | undefined)?.ads ?? 0)
        }
      }
      // SPA 路由变化 → 销毁所有 badge UI，等待新页面的 m3u8 检测重新创建
      if (msg.type === 'pageUrlChanged') {
        destroyBadge()
        return false
      }
      // 全局显隐切换
      if (msg.type === 'veloVisibilityChanged') {
        const visible = msg.payload?.visible
        if (visible === false) {
          destroyBadge()
        }
        return false
      }
      // 响应 popup 的播放状态查询（保存广告样本时需要 currentTime）
      if (msg.type === 'getPlayback') {
        const v = findVideo()
        if (v) {
          sendResponse({ ok: true, currentTime: v.currentTime || 0, duration: v.duration || 0, src: v.currentSrc || v.src || '' })
        } else {
          sendResponse({ ok: false, error: i18n('options_no_video_element') ?? 'No video element found' })
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

    function setupAdSkipper(
      adRanges: Array<{ start: number; end: number; duration: number }>,
    ): void {
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

    /**
     * 判断播放器时间轴是否仍包含广告
     *
     * 页面播放链路永不替换数据源，播放器拿到的始终是原始 m3u8，
     * 广告分片仍在时间轴上，因此只要下发了区间就必须 seek 跳过。
     */
    function timelineHasAds(_video: HTMLVideoElement): boolean {
      return true
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
          showSkipToast(i18n('badge_runtime_ad_detected', [range.duration.toFixed(1)]) ?? `⏭ Ad detected ${range.duration.toFixed(1)}s (recorded, will skip next time)`)
          adSkipState.prevTime = t
          return
        }
        // 运行时 seekbar 重置检测
        if (!adSkipState.skipping && adSkipState.prevTime > 30 && t < adSkipState.prevTime - 10 && t < 30) {
          adSkipState.seekbarResetCount++
          adSkipState.inRuntimeAd = true
          adSkipState.runtimeAdStart = adSkipState.prevTime
          showSkipToast(i18n('badge_seekbar_reset_detected') ?? '⏭ Ad insertion detected (seekbar reset), recording...')
          adSkipState.prevTime = t
          return
        }
        // 常规广告区间跳过
        if (!adSkipState.skipping && adSkipState.ranges.length > 0) {
          // 时间轴已被清洗（页面 hook 替换了响应）时广告不在轴上，不能按原坐标 seek
          if (!timelineHasAds(video)) return
          for (const r of adSkipState.ranges) {
            if (t >= r.start && t < r.end) {
              adSkipState.skipping = true
              video.currentTime = r.end + 0.05
              showSkipToast(i18n('badge_ad_skipped', [(r.duration || 0).toFixed(1)]) ?? `⏭ Ad skipped ${(r.duration || 0).toFixed(1)}s`)
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
            'transition:opacity .3s;opacity:0;user-select:none;' +
            'display:flex;align-items:flex-start;gap:6px;'
          btn.innerHTML = `
            <span class="dl-body" style="flex:1;white-space:pre-line"></span>
            <span class="dl-close" title="${i18n('badge_close')}" style="cursor:pointer;color:rgba(255,255,255,.6);font-size:14px;line-height:1;padding:0 2px;margin:-2px -6px 0 0;flex-shrink:0;">×</span>
          `
          btn.querySelector('.dl-close')!.addEventListener('click', (e) => {
            e.stopPropagation()
            btn!.style.opacity = '0'
            setTimeout(() => btn!.remove(), 300)
          })
          btn.addEventListener('click', async () => {
            const body = btn!.querySelector('.dl-body') as HTMLElement
            body.textContent = '⏬ ' + i18n('badge_downloading')
            try {
              const tabResp = (await sendMessage<{ tabId?: number }>({ type: 'getCurrentTabId' }))
              const fileName = resolveBadgeFileName()
              const r = await sendMessage<{ ok: boolean; filename?: string; error?: string }>({
                type: 'downloadCleanedM3u8',
                payload: { tabId: tabResp?.tabId ?? 0, fileName: fileName || undefined },
              })
              if (r?.ok) {
                body.textContent = '✓ ' + i18n('badge_downloaded') + ' ' + (r.filename ?? 'cleaned.m3u8')
                btn!.style.background = '#0f766e'
                setTimeout(() => {
                  btn!.style.opacity = '0'
                  setTimeout(() => btn!.remove(), 300)
                }, 3000)
              } else {
                body.textContent = '✗ ' + (r?.error ?? i18n('badge_download_failed'))
                btn!.style.background = '#dc2626'
                setTimeout(() => {
                  body.textContent = i18n('badge_download_m3u8')
                  btn!.style.background = '#059669'
                }, 2500)
              }
            } catch (e) {
              body.textContent = '✗ ' + (e as Error).message
            }
          })
          ;(document.body ?? document.documentElement).appendChild(btn)
        }
        const body = btn.querySelector('.dl-body') as HTMLElement
        body.textContent = i18n('badge_download_m3u8') + (adCount > 0 ? ` (${i18n('badge_ad_filtered', String(adCount))})` : '') + '\n📁 ' + displayName + '_cleaned.m3u8'
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
          <div class="b-title"><span class="b-dot"></span><span>${i18n('badge_title')}</span></div>
          <span class="b-close" title="${i18n('badge_close')}">×</span>
        </div>
        <div class="b-body">
          <div class="b-row"><span>${i18n('badge_ad_segments')}</span><b class="b-ads">0</b></div>
          <div class="b-row"><span>${i18n('badge_ad_duration')}</span><b class="b-adv">0s</b></div>
          <div class="b-row"><span>${i18n('badge_content_duration')}</span><b class="b-cv">0s</b></div>
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
          ruleEl.textContent = `${i18n('badge_matched_rule')}: ${s.ruleName}`
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

interface SkipRange {
  readonly start: number
  readonly end: number
  readonly duration: number
}

function runAdSkipInFrame(): void {
  let ranges: SkipRange[] = []
  let skipping = false
  let attached = false

  // 页面播放链路永不替换数据源，时间轴上广告始终存在，有区间即 seek
  function timelineHasAds(_video: HTMLVideoElement): boolean {
    return true
  }

  function findFrameVideo(): HTMLVideoElement | null {
    const direct = document.querySelector('video')
    if (direct) return direct
    for (const f of Array.from(document.querySelectorAll('iframe'))) {
      try {
        const v = f.contentDocument?.querySelector('video')
        if (v) return v as HTMLVideoElement
      } catch {
        continue
      }
    }
    return null
  }

  function attach(video: HTMLVideoElement): void {
    if (attached) return
    attached = true
    video.addEventListener('timeupdate', () => {
      if (skipping || ranges.length === 0) return
      const t = video.currentTime
      if (!timelineHasAds(video)) return
      for (const r of ranges) {
        if (t >= r.start && t < r.end) {
          skipping = true
          video.currentTime = r.end + 0.05
          setTimeout(() => {
            skipping = false
          }, 500)
          break
        }
      }
    })
  }

  function tryAttach(): void {
    const v = findFrameVideo()
    if (v) {
      attach(v)
      return
    }
    if (ranges.length === 0) return
    const mo = new MutationObserver(() => {
      const vv = findFrameVideo()
      if (vv) {
        attach(vv)
        mo.disconnect()
      }
    })
    mo.observe(document.documentElement ?? document.body!, { childList: true, subtree: true })
  }

  onMessageAddListener((message: unknown) => {
    if (!message || typeof message !== 'object') return false
    const msg = message as { type?: string; adRanges?: unknown }
    if (msg.type !== 'hlsFilterResult') return false
    const list = Array.isArray(msg.adRanges) ? (msg.adRanges as SkipRange[]) : []
    if (list.length === 0) return false
    chrome.storage.local.get(['hlsFilterConfig'], (cfg) => {
      const c = (cfg?.hlsFilterConfig as { enableAdSkip?: boolean }) ?? {}
      if (c.enableAdSkip === false) return
      ranges = list
      tryAttach()
      logger.info('[AdClear AdSkip] frame skipper ready, ranges:', list.length)
    })
    return false
  })

  tryAttach()
}