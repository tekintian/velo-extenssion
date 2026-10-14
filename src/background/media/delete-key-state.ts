/**
 * Delete 键按下状态（NDM bg.js `B` 全局变量 100% 移植）
 *
 * ## 背景
 * NDM bg.js 的 `B` 变量是一个布尔值，由 content script 通过 `chrome.runtime.onMessage`
 * 监听消息（case 4: B=b[1]）更新。当用户按下 Delete 键时 B=true，松开时 B=false。
 *
 * 在 onHeadersReceived 检测到非媒体下载扩展名（`ca` 白名单）时，会检查 `b.isKeyDown`
 * （即 B 的快照，在 onBeforeSendHeaders 阶段捕获）：
 *   - Delete 键按下：跳过拦截，让浏览器原生下载（用户绕过扩展的一次性意图）
 *   - Delete 键未按下：拦截 + 推送到 NDM + 返回 `{redirectUrl:"javascript:"}`
 *
 * NDM bg.js 行 264:
 * ```js
 * W.O = function(a) {
 *   if (!(0 > a.tabId || 0 > a.frameId)) {
 *     var b = this.j[a.requestId];
 *     b && (b.isKeyDown = B, b.l = a.requestHeaders)
 *   }
 * }
 * ```
 * 这里在 onBeforeSendHeaders 阶段把全局 `B` 快照到 per-request 的 `b.isKeyDown` 字段，
 * 避免请求中途 Delete 键状态变化导致行为不一致。
 *
 * ## 实现
 * - 本模块导出 `getDeleteKeyDown()` / `setDeleteKeyDown(state)` 两个函数
 * - sniffer 在 onBeforeSendHeaders 中调用 `getDeleteKeyDown()` 把快照存入 pendingRequests
 * - handler 在收到 content script 消息时调用 `setDeleteKeyDown(state)`
 *
 * 注：MV3 service worker 可能被回收重启，重启后 B 会重置为 false（与 NDM 行为一致 —
 * NDM 的 B 是 persistent background page 的全局变量，浏览器重启也会重置）。
 */

/** Delete 键按下状态（true = 用户当前按住 Delete 键） */
let deleteKeyDown = false

/** 时间戳（ms），用于检测过期状态（content script 长时间无心跳时认为键已松开） */
let deleteKeyDownAt = 0

/** 状态过期阈值（30s）：超过此时间无 keydown 事件更新，认为键已松开 */
const STATE_STALE_MS = 30000

/**
 * 读取 Delete 键按下状态（带过期检测）
 *
 * @returns true 表示用户当前按住 Delete 键（或在 30s 内按过且未松开）
 */
export function getDeleteKeyDown(): boolean {
  if (!deleteKeyDown) return false
  // 过期检测：30s 内无更新视为松开（防止 content script 崩溃后状态卡死）
  if (Date.now() - deleteKeyDownAt > STATE_STALE_MS) {
    deleteKeyDown = false
    return false
  }
  return true
}

/**
 * 设置 Delete 键按下状态
 *
 * @param pressed true=按下，false=松开
 */
export function setDeleteKeyDown(pressed: boolean): void {
  deleteKeyDown = pressed
  deleteKeyDownAt = Date.now()
}
