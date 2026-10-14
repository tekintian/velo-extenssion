/**
 * POST 请求体完整解析（NDM bg.js `ia()` 函数 100% 移植）
 *
 * ## 背景
 * Chrome MV3 的 `chrome.webRequest.WebRequestBody` 有两种形态：
 *
 * 1. **raw 模式**：`requestBody.raw` 是 `UploadData[]` 数组，每个元素有 `bytes` 字段
 *    （ArrayBuffer）。Chrome 不会合并多个 chunk，必须手动拼接。
 *    旧 velo-extension 只取 `raw[0].bytes` → 大于 64KB 的 POST body 会丢失后续 chunk。
 *
 * 2. **formData 模式**：`requestBody.formData` 是 `Record<string, string[]>` 对象
 *    （字段名 → 值数组）。Chrome 只在 Content-Type 为 application/x-www-form-urlencoded
 *    或 multipart/form-data 时才解析为 formData；其他情况仍走 raw 模式。
 *
 * NDM bg.js 的 `ia(a, b)` 函数完整处理两种模式：
 *   - raw 模式：拼接所有 chunk 的 bytes 为字符串
 *   - formData + urlencoded：重组为 `key1=value1&key2=value2` 形式
 *   - formData + multipart：从 Content-Type 提取 boundary，重组完整 multipart body
 *
 * ## 移植映射
 *
 * | NDM bg.js | velo-extension |
 * |-----------|-----------------|
 * | `ia(a, b)` | `parseRequestBody(requestBody, contentType)` |
 * | `J(b)` | 内联实现（取 Content-Type 首段，去 charset 参数） |
 * | `Z(b, "boundary")` | `extractHeaderParam(contentType, "boundary")` |
 *
 * ## 注意事项
 *
 * - NDM 的 `M(b.s, "Content-Type")` 取的是**请求头** Content-Type（即 POST body 的 MIME），
 *   不是响应头。我们调用方需传入请求阶段的 Content-Type。
 * - NDM `encodeURIComponent` + `split(" ").map(...).join("+")` 模拟表单编码：
 *   先用 encodeURIComponent 把空格编码为 %20，再把所有空格（未被编码的）替换为 +。
 *   这与浏览器表单提交的标准编码一致（application/x-www-form-urlencoded 用 + 不用 %20）。
 */

/**
 * Chrome MV3 webRequest 的请求体类型（内联在 OnBeforeRequestDetails.requestBody 中）
 *
 * @types/chrome 未导出为独立接口，这里用结构性类型抽取
 */
export type WebRequestBody =
  | {
      readonly error?: string
      readonly formData?: { readonly [key: string]: readonly (string | ArrayBuffer)[] }
      readonly raw?: readonly { readonly bytes?: ArrayBuffer }[]
    }
  | undefined
  | null

/**
 * 解析 POST 请求体（移植自 NDM bg.js `ia(a, b)` 函数）
 *
 * @param requestBody Chrome 的 `details.requestBody`（包含 raw 或 formData）
 * @param requestContentType 请求头 Content-Type（POST body 的 MIME）
 * @returns 重组后的请求体字符串，或 null（无 body）
 */
export function parseRequestBody(
  requestBody: WebRequestBody,
  requestContentType?: string | undefined,
): string | null {
  if (!requestBody) return null

  // === 1. raw 模式：拼接所有 chunk（修复旧实现只取 raw[0] 的 bug） ===
  const raw = requestBody.raw
  if (raw && raw.length > 0) {
    // NDM 原版用 String.fromCharCode 逐字节拼接，但 17899 字节以上的 body 会有 callstack 问题。
    // 我们用 TextDecoder 一次性解码（性能更好，且支持 UTF-8 多字节字符）。
    //
    // 注意：必须先合并所有 chunk 的 bytes 再 decode，否则 UTF-8 多字节字符可能跨 chunk 分割。
    const chunks: Uint8Array[] = []
    let totalLen = 0
    for (const chunk of raw) {
      if (!chunk.bytes) continue
      const u8 = new Uint8Array(chunk.bytes)
      chunks.push(u8)
      totalLen += u8.length
    }
    if (totalLen === 0) return null
    const merged = new Uint8Array(totalLen)
    let offset = 0
    for (const u8 of chunks) {
      merged.set(u8, offset)
      offset += u8.length
    }
    try {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(merged)
      return text.length > 0 ? text : null
    } catch {
      return null
    }
  }

  // === 2. formData 模式（NDM bg.js `ia` 函数 formData 分支） ===
  const formData = requestBody.formData
  if (!formData) return null

  // 取 Content-Type 首段（去 charset 等参数）
  const mime = firstSegment(requestContentType).toLowerCase()

  // === 2a. application/x-www-form-urlencoded（NDM 原版逻辑） ===
  if (mime === 'application/x-www-form-urlencoded') {
    const parts: string[] = []
    for (const [name, values] of Object.entries(formData)) {
      // NDM: e.split(" ").map(encodeURIComponent).join("+")
      // 把字段名用 encodeURIComponent 编码（空格→%20），再把空格替换为 +
      const encodedName = encodeURIComponent(name).split('%20').join('+')
      // 注：encodeURIComponent 不编码空格为 + 而是编码为 %20，需手动转 + 以符合 urlencoded 规范
      // NDM 写作 e.split(" ").map(encodeURIComponent).join("+") 实际等价：
      //   先按空格分割 → 各段 encodeURIComponent → 用 "+" 重新 join
      //   即把每个空格替换为 +（保留其他 %XX 编码）
      for (const rawValue of values) {
        if (parts.length > 0) parts.push('&')
        // FormDataItem 可能是 string 或 ArrayBuffer，仅 string 可直接编码
        const strValue = typeof rawValue === 'string' ? rawValue : ''
        parts.push(encodedName, '=', encodeFormValue(strValue))
      }
    }
    return parts.length > 0 ? parts.join('') : null
  }

  // === 2b. multipart/form-data（NDM 原版逻辑） ===
  if (mime === 'multipart/form-data') {
    // NDM: (f=Z(b,"boundary"))||(f="----WebKitFormBoundary"+Math.random().toString(36).substr(2))
    // 从 Content-Type 提取 boundary；缺失时用 Chrome 默认前缀生成（极少见）
    let boundary = extractHeaderParam(requestContentType, 'boundary')
    if (!boundary) {
      boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2)
    }

    const parts: string[] = []
    for (const [name, values] of Object.entries(formData)) {
      for (const rawValue of values) {
        // NDM 行 170-171:
        //   a.push("--",f,'\r\nContent-Disposition: form-data; name="',e,'"\r\n\r\n',d[b],"\r\n");
        const strValue = typeof rawValue === 'string' ? rawValue : ''
        parts.push(
          '--', boundary,
          '\r\nContent-Disposition: form-data; name="', name, '"\r\n\r\n',
          strValue, '\r\n',
        )
      }
    }
    // NDM 行 172: a.push("--",f,"--\r\n");
    parts.push('--', boundary, '--\r\n')
    return parts.join('')
  }

  // 其他 Content-Type（如 application/json）：formData 形态不应出现，但保守返回 null
  return null
}

/**
 * 取 Content-Type/Disposition 的首段（去参数）
 *
 * 对应 NDM bg.js `J(a)` 函数：
 * ```js
 * function J(a) {
 *   return a && unescape(a.split(";", 1).shift().trim()) || ""
 * }
 * ```
 *
 * 例：
 *   'multipart/form-data; boundary=----WebKitFormBoundaryABC123'
 *     → 'multipart/form-data'
 *   'attachment; filename="foo.zip"'
 *     → 'attachment'
 */
export function firstSegment(headerValue?: string | undefined): string {
  if (!headerValue) return ''
  const first = headerValue.split(';', 1)[0]
  if (!first) return ''
  try {
    return unescape(first.trim())
  } catch {
    return first.trim()
  }
}

/**
 * 从 Content-Type/Disposition 提取参数值（移植自 NDM bg.js `Z(a, b)` 函数）
 *
 * 例：
 *   extractHeaderParam('multipart/form-data; boundary=----WebKitFormBoundaryABC', 'boundary')
 *     → '----WebKitFormBoundaryABC'
 *   extractHeaderParam('attachment; filename="foo.zip"', 'filename')
 *     → 'foo.zip'
 *   extractHeaderParam("attachment; filename*=UTF-8''foo.zip", 'filename')
 *     → 'foo.zip'（RFC 5987 ext-values：charset'lang'value 三段，取最后一段）
 *
 * @param headerValue 完整的 Content-Type 或 Content-Disposition 头值
 * @param paramName 参数名（小写，不含 =）
 * @returns 参数值（已 unescape + 去引号），未找到返回 null
 */
export function extractHeaderParam(
  headerValue: string | undefined | null,
  paramName: string,
): string | null {
  if (!headerValue) return null
  const target = paramName.toLowerCase()
  const segments = headerValue.split(';')
  // 移除首段（主值，如 'attachment' 或 'multipart/form-data'）
  segments.shift()

  for (const seg of segments) {
    const eqIdx = seg.indexOf('=')
    if (eqIdx > 0) {
      let key = seg.substring(0, eqIdx).trim().toLowerCase()
      // RFC 5987 ext-parameter: filename*=UTF-8'lang'value
      const isExt = key.endsWith('*')
      if (isExt) key = key.substring(0, key.length - 1).trimEnd()
      if (key === target) {
        let value = seg.substring(eqIdx + 1).trim()
        // 去掉双引号
        const last = value.length - 1
        if (value[0] === '"' && value[last] === '"') {
          value = value.substring(1, last)
        }
        if (isExt) {
          // RFC 5987: charset'lang'value
          const segs = value.split("'")
          // 取最后一段（value 部分）
          value = segs.length >= 3 ? segs[segs.length - 1] ?? '' : value
        }
        try {
          return unescape(value)
        } catch {
          return value
        }
      }
    } else if (eqIdx < 0 && seg.trim().toLowerCase() === target) {
      // NDM: 0>d && e.trim().toLowerCase()==b → 无 = 但参数名匹配，返回空字符串
      return ''
    }
  }
  return null
}

/**
 * 表单字段值编码（NDM bg.js `d[b].split(" ").map(encodeURIComponent).join("+")`）
 *
 * NDM 行 166: `d[b].split(" ").map(encodeURIComponent).join("+")`
 * 即：把每个空格替换为 +（保留 %XX 编码）
 *
 * encodeURIComponent 把空格编码为 %20（而非 +），所以需要手动转换：
 *   'hello world' → 'hello+world'
 *   'a&b' → 'a%26b'
 */
function encodeFormValue(value: string): string {
  return encodeURIComponent(value).split('%20').join('+')
}