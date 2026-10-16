/**
 * 类型转换辅助函数
 *
 * 集中管理项目中高频出现的 `as unknown as` 双重断言，
 * 提供语义清晰的辅助函数，减少重复代码并提高可维护性。
 *
 * 设计原则：
 *   - 所有辅助函数内聚单一转换职责
 *   - 函数名自文档化，调用处无需注释解释断言原因
 *   - 运行时零开销（内联后等价于直接断言）
 */

/** window 作为属性字典的类型 */
export type WindowRecord = Record<string, unknown>

/** 被 hook 标记的函数/方法携带的标记接口 */
export interface HookedMarker {
  __adc_clear_hooked?: boolean
}

/**
 * 将 window 转为属性字典
 *
 * scriptlet 需要在 window 上读写自定义属性（如 __HLS_HOOK_NAMESPACE__），
 * TypeScript 的 Window 接口不包含这些属性，必须通过 Record<string, unknown> 访问。
 */
export function asWin(): WindowRecord {
  return window as unknown as WindowRecord
}

/**
 * 将任意对象转为属性字典
 *
 * 用于 XHR this 上下文等需要动态属性访问的场景。
 */
export function asRecord<T>(obj: T): Record<string, unknown> {
  return obj as unknown as Record<string, unknown>
}

/**
 * 标记函数/方法已被 hook
 *
 * 防止同一原型方法被重复 hook（如多个 scriptlet 都 hook addEventListener）。
 */
export function markHooked(fn: unknown): void {
  ;(fn as unknown as HookedMarker).__adc_clear_hooked = true
}

/**
 * 检查函数/方法是否已被 hook
 */
export function isHooked(fn: unknown): boolean {
  return !!(fn as unknown as HookedMarker).__adc_clear_hooked
}