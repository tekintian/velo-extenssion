/**
 * 安全的 chrome.runtime API 包装
 *
 * 扩展热重载/更新后，旧 content script 的扩展上下文失效，
 * 任何 chrome.runtime 调用都会同步抛出 "Extension context invalidated"。
 * 此模块提供安全包装，在上下文失效时静默返回 undefined 而非抛出异常。
 */

/** 检查扩展上下文是否仍然有效 */
function isContextValid(): boolean {
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
    return chrome.runtime.sendMessage(message) as Promise<T>
  } catch {
    return Promise.resolve(undefined)
  }
}

/**
 * 安全的 chrome.runtime.sendMessage 同步版本（用于事件监听器中）
 *
 * 返回 void，不等待响应。扩展上下文失效时静默忽略。
 */
export function sendMessageFireAndForget(message: unknown): void {
  if (!isContextValid()) return
  try {
    void chrome.runtime.sendMessage(message).catch(() => {})
  } catch {
    // ignore
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