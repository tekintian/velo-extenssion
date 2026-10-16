/**
 * Delete 键监听 content script — NDM ct.js 行 1-2 100% 移植
 *
 * ## 背景
 * NDM ct.js 在所有页面（http 与 https）注入一个简单的 keydown/keyup 监听器，
 * 当用户按下/松开 Delete 键时，通过 `chrome.runtime.sendMessage` 通知 background：
 *
 * ```js
 * // NDM ct.js 行 1-2（minified 后）
 * window.addEventListener("keydown", function(b) {
 *   46 == b.keyCode && chrome.runtime.sendMessage([4, !0])
 * }, !0);
 * window.addEventListener("keyup", function(b) {
 *   46 == b.keyCode && chrome.runtime.sendMessage([4, !1])
 * }, !0);
 * ```
 *
 * 46 是 Delete 键的 keyCode。NDM 用数组 `[4, true/false]` 作为消息体（4 = 消息类型 ID）。
 * velo-extension 改用对象 `{ type: 'deleteKeyStateChanged', payload: { pressed } }`。
 *
 * ## 触发条件
 *   - matches: http 与 https 所有路径
 *   - allFrames: false（只在主框架监听，子框架不重复）
 *   - runAt: document_start（尽早监听，避免错过页面加载早期的 keydown）
 *
 * ## 使用场景
 * 用户按住 Delete 键点击下载链接 → 跳过扩展拦截，走浏览器原生下载。
 * 这与 NDM 行为完全一致（NDM 行 219: if(b.isKeyDown){delete this.j[c]; return}）。
 *
 * 注意：MV3 service worker 可能被回收，所以 keydown 事件需要 sendMessage 触发 SW 启动。
 * 我们也在 SW 启动时验证状态未过期（见 delete-key-state.ts 的 STATE_STALE_MS=30s）。
 */

import { defineContentScript } from 'wxt/utils/define-content-script'
import { sendMessageFireAndForget, isContextValid } from '@/lib/runtime'

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: false,
  runAt: 'document_start',

  main() {
    if (!isContextValid()) return

    const onDeleteKeyDown = () => {
      sendMessageFireAndForget({ type: 'deleteKeyStateChanged', payload: { pressed: true } })
    }
    const onDeleteKeyUp = () => {
      sendMessageFireAndForget({ type: 'deleteKeyStateChanged', payload: { pressed: false } })
    }
    const onDeleteReset = () => {
      sendMessageFireAndForget({ type: 'deleteKeyStateChanged', payload: { pressed: false } })
    }

    window.addEventListener('keydown', (event) => {
      if (event.keyCode === 46) onDeleteKeyDown()
    }, true)

    window.addEventListener('keyup', (event) => {
      if (event.keyCode === 46) onDeleteKeyUp()
    }, true)

    window.addEventListener('blur', onDeleteReset, true)

    window.addEventListener('beforeunload', onDeleteReset, true)
  },
})