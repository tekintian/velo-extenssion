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
 */

/** 缓存上下文失效状态：一旦失效永不恢复，避免反复触发 Proxy getter */
let contextInvalidated = false

/** 检查扩展上下文是否仍然有效 */
export function isContextValid(): boolean {
  if (contextInvalidated) return false
  try {
    if (chrome.runtime?.id === undefined) {
      contextInvalidated = true
      return false
    }
    return true
  } catch {
    contextInvalidated = true
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
    contextInvalidated = true
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
    contextInvalidated = true
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
    contextInvalidated = true
    return false
  }
}