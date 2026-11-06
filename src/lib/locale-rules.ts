export interface LocaleIssue {
  key: string
  detail: string
}

export interface LocaleFileIssue extends LocaleIssue {
  file: string
}

export interface LocaleEntry {
  message?: unknown
  placeholders?: unknown
}

const NAME_RE = /^[A-Z][A-Z0-9_]*$/
const TOKEN_RE = /\$([^$\s]+)\$/g
const CONTENT_RE = /^\$([1-9]\d*)$/

export function collectTokens(message: string): string[] {
  const tokens: string[] = []
  TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(message)) !== null) {
    const token = m[1]
    if (token !== undefined) tokens.push(token)
  }
  return tokens
}

export function checkEntry(key: string, entry: unknown): LocaleIssue[] {
  const issues: LocaleIssue[] = []
  const add = (detail: string) => issues.push({ key, detail })

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    add('entry 必须是对象')
    return issues
  }

  const record = entry as Record<string, unknown>
  const message = record.message
  if (typeof message !== 'string' || message.trim() === '') {
    add('message 必须是非空字符串')
    return issues
  }

  const placeholders = record.placeholders ?? {}
  if (typeof placeholders !== 'object' || Array.isArray(placeholders)) {
    add('placeholders 必须是对象')
    return issues
  }

  const declared = Object.keys(placeholders as Record<string, unknown>)
  const tokens = collectTokens(message)

  for (const token of tokens) {
    if (!NAME_RE.test(token)) {
      add(`非法占位符名 $${token}$（必须匹配 $[A-Z][A-Z0-9_]*$）`)
    } else if (!declared.includes(token)) {
      add(`占位符 $${token}$ 未在 placeholders 中声明`)
    }
  }

  for (const name of declared) {
    if (!NAME_RE.test(name)) {
      add(`placeholders 键 "${name}" 非法（必须匹配 [A-Z][A-Z0-9_]*）`)
    }
    if (!tokens.includes(name)) {
      add(`placeholders 声明了未使用的 "${name}"`)
    }

    const placeholder = (placeholders as Record<string, unknown>)[name]
    if (!placeholder || typeof placeholder !== 'object' || Array.isArray(placeholder)) {
      add(`placeholders["${name}"] 必须是对象`)
      continue
    }

    const content = (placeholder as Record<string, unknown>).content
    if (typeof content !== 'string' || !CONTENT_RE.test(content)) {
      add(`placeholders["${name}"].content 必须是 "$数字" 形式，实际为 ${JSON.stringify(content)}`)
    }
  }

  return issues
}

export function checkLocaleData(file: string, data: Record<string, unknown>): LocaleFileIssue[] {
  const issues: LocaleFileIssue[] = []
  for (const [key, entry] of Object.entries(data)) {
    for (const issue of checkEntry(key, entry)) {
      issues.push({ file, key: issue.key, detail: issue.detail })
    }
  }
  return issues
}

export interface LocaleKeySet {
  file: string
  keys: Set<string>
}

export function checkKeyParity(entries: LocaleKeySet[]): LocaleFileIssue[] {
  const issues: LocaleFileIssue[] = []
  const reference = entries[0]
  if (!reference) return issues

  for (const current of entries.slice(1)) {
    for (const key of reference.keys) {
      if (!current.keys.has(key)) {
        issues.push({ file: current.file, key, detail: `缺少 ${reference.file} 中存在的 key` })
      }
    }
    for (const key of current.keys) {
      if (!reference.keys.has(key)) {
        issues.push({ file: current.file, key, detail: `${reference.file} 中不存在此 key` })
      }
    }
  }
  return issues
}