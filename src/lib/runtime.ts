/**
 * 安全的 chrome.runtime API 包装
 *
 * 扩展热重载/更新后，旧 content script 的扩展上下文失效，
 * 任何 chrome.runtime 调用都会同步抛出 "Extension context invalidated"。
 * 此模块提供安全包装，在上下文失效时静默返回 undefined 而非抛出异常。
 *
 * ## 关键细节
 * 上下文失效时 `chrome.runtime` 变为失效 Proxy，访问其任何属性（包括 `id`）
 * 都会抛出 "Extension context invalidated"。可选链 `?.` 无法阻止此异常，
 * 因为 `chrome.runtime` 既非 null 也非 undefined，而是 Proxy getter 抛异常。
 * 因此必须用 try/catch 包裹所有 `chrome.runtime` 访问。
 *
 * ## 修复：不再缓存失效状态
 * 旧实现"一旦失效永不恢复"，导致扩展热重载后旧 content script 的上下文失效，
 * contextInvalidated 被永久锁为 true，后续所有 sendMessage 全部静默返回 undefined，
 * HLS 过滤永久失效（直到页面刷新）。
 *
 * 修复：每次检查都重新探测 chrome.runtime.id，不再缓存失效状态。
 * 性能影响：Proxy getter 开销极小（< 1μs），而 HLS 处理频率远低于此。
 * 如果上下文确实已失效，反复探测也只是多触发几次 Proxy getter，不会产生副作用。
 */

/** 检查扩展上下文是否仍然有效 */
export function isContextValid(): boolean {
  try {
    return chrome.runtime?.id !== undefined
  } catch {
    return false
  }
}

/**
 * 安全的 chrome.runtime.sendMessage
 *
 * 扩展上下文失效时返回 undefined 而非抛出 "Extension context invalidated"。
 * 同时处理消息发送后的异步拒绝（如 background 未注册 listener）。
 */
export function sendMessage<T = unknown>(message: unknown): Promise<T | undefined> {
  if (!isContextValid()) return Promise.resolve(undefined)
  try {
    return chrome.runtime.sendMessage(message).catch(() => undefined) as Promise<T | undefined>
  } catch {
    return Promise.resolve(undefined)
  }
}

/**
 * 安全的 chrome.runtime.sendMessage 同步版本（用于事件监听器中）
 *
 * 返回 void，不等待响应。扩展上下文失效时静默忽略。
 * Promise rejection 立即捕获，避免 unhandled rejection 冒泡为控制台错误。
 */
export function sendMessageFireAndForget(message: unknown): void {
  if (!isContextValid()) return
  try {
    const p = chrome.runtime.sendMessage(message)
    if (p && typeof p.catch === 'function') {
      p.catch(() => {})
    }
  } catch {
    // context invalidated — ignore
  }
}

/**
 * 安全的 chrome.runtime.onMessage.addListener
 *
 * 扩展上下文失效时静默忽略，不注册监听器。
 * 返回 true 表示监听器已注册，false 表示上下文已失效。
 */
export function onMessageAddListener(
  callback: (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean | void,
): boolean {
  if (!isContextValid()) return false
  try {
    chrome.runtime.onMessage.addListener(callback)
    return true
  } catch {
    return false
  }
}