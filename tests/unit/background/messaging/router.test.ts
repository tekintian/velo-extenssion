import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { registerHandler, unregisterHandler, messageDispatcher } from '@/background/messaging/router'

describe('MessageRouter', () => {
  beforeEach(() => {
    unregisterHandler('test-type')
    unregisterHandler('async-type')
  })

  it('dispatches sync handler and returns result', () => {
    registerHandler('test-type', () => ({ ok: true }))
    const sendResponse = vi.fn()
    messageDispatcher({ type: 'test-type', payload: {} }, {} as chrome.runtime.MessageSender, sendResponse)
    expect(sendResponse).toHaveBeenCalledWith({ ok: true })
  })

  it('dispatches async handler and returns true', () => {
    registerHandler('async-type', async () => ({ ok: true, async: true }))
    const sendResponse = vi.fn()
    const result = messageDispatcher({ type: 'async-type', payload: {} }, {} as chrome.runtime.MessageSender, sendResponse)
    expect(result).toBe(true)
  })

  it('returns error for unknown message type', () => {
    const sendResponse = vi.fn()
    messageDispatcher({ type: 'nonexistent', payload: {} }, {} as chrome.runtime.MessageSender, sendResponse)
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ error: true }))
  })

  it('returns error for missing message type', () => {
    const sendResponse = vi.fn()
    messageDispatcher({ type: '', payload: {} }, {} as chrome.runtime.MessageSender, sendResponse)
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ error: true, code: 'MISSING_TYPE' }))
  })

  it('handles handler error', () => {
    registerHandler('test-type', () => { throw new Error('handler failed') })
    const sendResponse = vi.fn()
    messageDispatcher({ type: 'test-type', payload: {} }, {} as chrome.runtime.MessageSender, sendResponse)
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ error: true, message: 'handler failed' }))
  })
})
