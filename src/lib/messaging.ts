/**
 * 扩展页 → background 消息请求封装
 *
 * background 的 message router 在「handler 未注册」或「handler 抛错」时，
 * 会返回 `{ error: true, message, code }` 结构。该对象是 truthy，
 * 若调用方直接 `if (res) setState(res as T[])`，错误对象就会进入 React 状态，
 * 渲染期执行 `state.map(...)` 时抛出 "xxx.map is not a function"，
 * 整个页面白屏（options-dash-filter 曾因此崩溃）。
 *
 * 此封装统一在 IPC 边界把错误响应/异常收敛为 undefined 并打日志，
 * 调用方只需做类型守卫（Array.isArray / 字段校验）即可安全使用。
 */

import { sendMessage } from '@/lib/runtime'

export interface MessageErrorResponse {
  error: true
  message: string
  code: string
}

export function isMessageError(res: unknown): res is MessageErrorResponse {
  return (
    typeof res === 'object' &&
    res !== null &&
    (res as { error?: unknown }).error === true
  )
}

/**
 * 发送消息并取回响应
 *
 * 上下文失效、无接收方、background 返回错误响应时均返回 undefined。
 * 底层复用 runtime.sendMessage，扩展上下文失效的探测与静默处理只在
 * runtime.ts 一处实现，避免两套重复逻辑。
 */
export async function request<T = unknown>(type: string, payload?: unknown): Promise<T | undefined> {
  const res = await sendMessage<unknown>({ type, payload })
  if (isMessageError(res)) {
    console.warn(`[messaging] "${type}" 返回错误:`, res.message, `(${res.code})`)
    return undefined
  }
  return res as T | undefined
}

/** 发送消息并保证拿到数组（非数组响应一律视为失败） */
export async function requestArray<T>(type: string, payload?: unknown): Promise<T[] | undefined> {
  const res = await request<unknown>(type, payload)
  return Array.isArray(res) ? (res as T[]) : undefined
}