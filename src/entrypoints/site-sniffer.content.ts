/**
 * 站点特殊嗅探 content script — NDM ct.js 100% 移植
 *
 * ## 概述
 * NDM 扩展的 ct.js 在页面 DOMContentLoaded 时执行两类特殊嗅探：
 *   1. YouTube/Vimeo 页面 `<script>` 标签内嵌的 formats JSON 解析
 *   2. Facebook 页面 MutationObserver 监听 `/videos/{id}/` 链接
 *
 * 本 content script 移植这两个逻辑，把解析后的数据通过 background handler
 * 推送到 velo-extension 的媒体列表。
 *
 * ## 移植映射
 *
 * | NDM ct.js 函数 | 本脚本对应实现 | background handler |
 * |----------------|----------------|---------------------|
 * | `za` YouTube 分支（行 19-23） | `scanYouTubeScripts` | `parseYouTubeScriptFormats` |
 * | `za` Vimeo 分支（行 20-22） | `scanVimeoScripts` | `parseVimeoScriptProgressive` |
 * | `la` MutationObserver（行 19-20） | `installFacebookObserver` | `sniffFacebookEmbed` |
 * | `ga` Facebook embed fetch | （在 background 完成） | `sniffFacebookEmbed` |
 *
 * ## 触发条件
 *   - YouTube：hostname 含 'youtube.com' 且 DOMContentLoaded 触发
 *   - Vimeo：hostname 含 'vimeo' 且 DOMContentLoaded 触发
 *   - Facebook：hostname 以 'facebook.com' 结尾，启动 MutationObserver 持续监听
 *
 * ## 与 background 嗅探器的协同
 * - YouTube：content script 扫描 `<script>` 是被动触发，background 的
 *   `sniffYouTubeWatchPage` 是主动触发（player API POST 后）。两者互补：
 *   用户直接打开 watch 页时 content script 捕获；用户在嵌入 iframe 中播放时
 *   background 捕获。
 * - Vimeo：content script 扫描 `<script>` 是 fallback；background 的
 *   `sniffVimeoProgressiveJson` 在 player.vimeo.com JSON 端点响应时触发。
 * - Facebook：完全由 content script 驱动（MutationObserver + embed fetch）。
 */

import { defineContentScript } from 'wxt/utils/define-content-script'
import { logger } from '@/lib/logger'

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: false,
  runAt: 'document_idle',

  main() {
    const host = location.hostname.toLowerCase()
    logger.info('[site-sniffer cs] loaded, host:', host)

    // === 1. YouTube <script> 标签扫描（NDM ct.js za YouTube 分支） ===
    if (host.includes('youtube.com')) {
      scanYouTubeScripts()
    }

    // === 2. Vimeo <script> 标签扫描（NDM ct.js za Vimeo 分支） ===
    if (host.includes('vimeo')) {
      scanVimeoScripts()
    }

    // === 3. Facebook MutationObserver（NDM ct.js T.la 函数） ===
    // NDM ct.js J(): hostname 以 'facebook.com' 结尾
    if (host.endsWith('facebook.com')) {
      installFacebookObserver()
    }
  },
})

/**
 * 扫描 YouTube 页面的所有 <script> 标签 innerText
 *
 * 移植自 NDM ct.js za() 函数 YouTube 分支（行 19-23）。
 *
 * ## 流程
 * 1. 等 DOMContentLoaded（已在 document_idle 阶段，直接执行）
 * 2. 遍历所有 `<script>` 标签的 innerText
 * 3. 找含 `"itag"` 且不含 `"signatureCipher"` 的脚本
 * 4. 发送给 background 调用 `parseYouTubeScriptFormats`
 *
 * ## NDM 原条件（行 19）
 * ```js
 * if (a && !h && -1 < d.indexOf("itag") && 0 > d.indexOf("signatureCipher"))
 * ```
 *   - a = DOMContentLoaded 事件（已触发）
 *   - !h = 之前未成功解析过（一次成功即停）
 *   - 脚本 innerText 含 "itag"
 *   - 脚本 innerText 不含 "signatureCipher"（加密流跳过）
 */
function scanYouTubeScripts(): void {
  const scripts = document.querySelectorAll<HTMLScriptElement>('script')
  let parsed = false

  for (const script of scripts) {
    if (parsed) break
    const text = script.textContent ?? script.innerText ?? ''
    if (!text || text.indexOf('itag') < 0) continue
    if (text.indexOf('signatureCipher') >= 0) continue

    // 发送给 background 解析
    void chrome.runtime.sendMessage({
      type: 'parseYouTubeScriptFormats',
      payload: { scriptText: text },
    }).then((resp) => {
      const r = resp as { parsed?: boolean } | null
      if (r?.parsed) {
        logger.info('[site-sniffer cs] YouTube <script> formats parsed successfully')
      }
    }).catch((e) => {
      logger.warn('[site-sniffer cs] parseYouTubeScriptFormats failed:', (e as Error).message)
    })

    // NDM 行为：一次成功即停（h = true 后续都跳过）
    // 这里乐观标记为 parsed，即使 background 还未返回（避免重复发送大文本）
    parsed = true
  }

  if (!parsed) {
    logger.info('[site-sniffer cs] YouTube: no <script> with formats found')
  }
}

/**
 * 扫描 Vimeo 页面的所有 <script> 标签 innerText
 *
 * 移植自 NDM ct.js za() 函数 Vimeo 分支（行 20-22）。
 *
 * ## 流程
 * 1. 遍历所有无 src 属性的 `<script>` 标签
 * 2. 测试 innerText 是否匹配 `/"progressive":\s*\[/`
 * 3. 找到 `"progressive"` 位置，向后找 `]`
 * 4. 截取子串发送给 background 调用 `parseVimeoScriptProgressive`
 *
 * ## NDM 原条件（行 20）
 * ```js
 * if (0 <= document.location.host.toLowerCase().indexOf("vimeo")
 *     && !l.src
 *     && p.test(l.innerText))
 * ```
 *   - hostname 含 "vimeo"（已在 main 中过滤）
 *   - script 无 src 属性（内联脚本，不是外链 JS）
 *   - innerText 匹配 "progressive":\s*\[
 */
function scanVimeoScripts(): void {
  const scripts = document.querySelectorAll<HTMLScriptElement>('script')
  const progressiveRe = /"progressive":\s*\[/
  let parsed = false

  for (const script of scripts) {
    if (parsed) break
    // NDM 条件：!l.src — 内联脚本
    if (script.src) continue
    const text = script.textContent ?? script.innerText ?? ''
    if (!text || !progressiveRe.test(text)) continue

    void chrome.runtime.sendMessage({
      type: 'parseVimeoScriptProgressive',
      payload: { scriptText: text },
    }).then((resp) => {
      const r = resp as { parsed?: boolean } | null
      if (r?.parsed) {
        logger.info('[site-sniffer cs] Vimeo <script> progressive parsed successfully')
      }
    }).catch((e) => {
      logger.warn('[site-sniffer cs] parseVimeoScriptProgressive failed:', (e as Error).message)
    })

    parsed = true
  }

  if (!parsed) {
    logger.info('[site-sniffer cs] Vimeo: no <script> with progressive found')
  }
}

/**
 * 安装 Facebook MutationObserver 监听 /videos/{id}/ 链接
 *
 * 移植自 NDM ct.js T 构造函数 + la() 函数（行 16-17, 19-20）。
 *
 * ## 流程
 * 1. 创建 MutationObserver，监听 document 的 childList + subtree 变化
 * 2. 每次变化：调用 `processFacebookLinks(target)`
 * 3. `processFacebookLinks` 查询所有 `<a[href*="/videos/"]>` 链接
 * 4. 对未标记 NEAT_DM 的链接：
 *    - 标记 NEAT_DM=1（避免重复处理）
 *    - 从 href 提取 videoId（正则 `.*\/videos\/(\d+)\/.*`）
 *    - 发送给 background 调用 `sniffFacebookEmbed`
 *
 * ## NDM 原实现（行 16-17, 19-20）
 * ```js
 * this.oa = new window.MutationObserver(function(b) {
 *   b.forEach(function(c) { a.la(c.target) });
 * });
 * this.oa.observe(document, {childList: true, subtree: true});
 *
 * Q.la = function(a) {
 *   // 查询所有 a[href 包含 "/videos/"] 的链接
 *   // 对未标记 NEAT_DM 的链接：set NEAT_DM=1，提取 videoId，调用 ga()
 * };
 * ```
 */
function installFacebookObserver(): void {
  // 先处理当前 DOM 中已有的链接（MutationObserver 不会回溯历史）
  processFacebookLinks(document.documentElement)

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      processFacebookLinks(mutation.target as HTMLElement)
    }
  })

  observer.observe(document.documentElement, { childList: true, subtree: true })
  logger.info('[site-sniffer cs] Facebook MutationObserver installed')
}

/**
 * 处理元素内的 /videos/{id}/ 链接
 *
 * @param root 搜索根元素（document.documentElement 或 MutationObserver target）
 */
function processFacebookLinks(root: HTMLElement | Document | null): void {
  if (!root || !('querySelectorAll' in root)) return
  const links = root.querySelectorAll<HTMLAnchorElement>('a[href*="/videos/"]')
  if (links.length === 0) return

  for (const link of links) {
    // NDM: !c.getAttribute("NEAT_DM") — 已标记的跳过
    if (link.getAttribute('NEAT_DM')) continue
    link.setAttribute('NEAT_DM', '1')

    // NDM 正则：/.*\/videos\/(\d+)\/.*/i
    const match = link.href.match(/.*\/videos\/(\d+)\/.*/i)
    if (!match || !match[1]) continue

    const videoId = match[1]
    logger.info('[site-sniffer cs] Facebook /videos/ link found: videoId=', videoId)

    // 发送给 background 调用 sniffFacebookEmbed（fetch embed HTML + 提取 sd_src/hd_src）
    void chrome.runtime.sendMessage({
      type: 'sniffFacebookEmbed',
      payload: { videoId },
    }).catch((e) => {
      logger.warn('[site-sniffer cs] sniffFacebookEmbed failed:', (e as Error).message)
    })
  }
}