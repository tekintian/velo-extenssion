import { logger } from '@/lib/logger'

type AnyHandler = (
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
) => unknown | Promise<unknown> | true

const handlers = new Map<string, AnyHandler>()

export function registerHandler(
  type: string,
  handler: AnyHandler,
): void {
  if (handlers.has(type)) {
    logger.warn(`[messaging] Handler for "${type}" already registered, overwriting`)
  }
  handlers.set(type, handler)
}

export function unregisterHandler(type: string): void {
  handlers.delete(type)
}

function errorToResponse(e: unknown): { error: true; message: string; code: string } {
  if (e instanceof Error) {
    return { error: true, message: e.message, code: 'UNKNOWN_ERROR' }
  }
  return { error: true, message: String(e), code: 'UNKNOWN_ERROR' }
}

export function messageDispatcher(
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
): boolean {
  const type = message.type as string | undefined
  if (!type) {
    sendResponse({ error: true, message: 'Missing message type', code: 'MISSING_TYPE' })
    return false
  }

  const handler = handlers.get(type)
  if (!handler) {
    sendResponse({ error: true, message: `Unknown message type: ${type}`, code: 'UNKNOWN_TYPE' })
    return false
  }

  let result: unknown
  try {
    result = handler(message, sender)
  } catch (e) {
    sendResponse(errorToResponse(e))
    return false
  }

  if (result instanceof Promise) {
    result
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse(errorToResponse(e)))
    return true
  }

  if (result === true) return true

  sendResponse(result)
  return false
}

export function initMessageRouter(): void {
  chrome.runtime.onMessage.addListener(
    (message, sender, sendResponse) => {
      return messageDispatcher(
        message as Record<string, unknown>,
        sender,
        sendResponse,
      )
    },
  )
}
