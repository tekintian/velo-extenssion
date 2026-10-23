/**
 * 站点规则库
 *
 * 移植自 NDM rules.js
 * 简化：用 AdClear 现有 persistentStorage 代替 chrome.storage.local 直接调用
 */

import { persistentStorage } from '@/lib/storage'
import type { SiteRule } from './types'

/** 内置规则库 */
export const BUILTIN_SITE_RULES: SiteRule[] = [
  {
    id: 'generic-ad-CDN',
    name: '通用广告 CDN 域名',
    hostPattern: '', // 空 = 兜底匹配所有
    adUrlPatterns: [
      '\\b(doubleclick|googlesyndication|googleadservices)\\.com\\b',
      '\\badservice\\.',
      '\\badm\\.\\w+\\.com',
      '\\bsponsor\\.',
      '\\b(adsrv|adserver|adnxs|rubiconproject)\\.',
    ],
    scoreThreshold: 3,
    forceKeep: [],
  },
  {
    id: 'streaming-preroll',
    name: '免费影视站 preroll/midroll',
    hostPattern: '(?:stream|watch|movie|tv|drama|film|video|kan|yun)\\w*\\.',
    adUrlPatterns: [
      '\\/(?:ads?|advert|preroll|midroll|postroll|promo|creative)\\/',
      '\\/static\\/ads?\\/',
      '\\bssp\\/',
      '[?&](ad_id|adid|spotid|adbreak)=',
    ],
    scoreThreshold: 3,
    forceKeep: [],
  },
  {
    id: 'live-broadcast-scte35',
    name: '直播/体育 SCTE-35 广告',
    hostPattern: '(?:live|sport|match|cctv|hupu|zhibo)\\w*\\.',
    adUrlPatterns: ['\\/ad\\d*\\/', '\\bclip\\/', '\\bbumper\\/'],
    scoreThreshold: 2, // 直播站 SCTE-35 信号强，放宽阈值
    // enumerate 模式已移除（与 m3u8-file 最终形态一致，且会导致推送静默丢弃）
    // 直播流改用 m3u8-file 模式，桌面端支持解析绝对 URL 的 m3u8 文本
    forceKeep: [],
  },
]

const USER_RULES_KEY = 'hlsUserRules'
const REMOTE_CACHE_KEY = 'hlsRemoteRulesCache'

/** 远程规则内存缓存 */
let remoteCache: { rules: SiteRule[]; ts: number } | null = null

/** host 匹配（空模式 = 兜底匹配所有） */
function hostMatch(host: string, pattern: string): boolean {
  if (!pattern) return true
  try {
    return new RegExp(pattern, 'i').test(host || '')
  } catch {
    return false
  }
}

/**
 * 加载用户规则
 */
export async function loadUserRules(): Promise<SiteRule[]> {
  try {
    const stored = await persistentStorage.get<SiteRule[]>(USER_RULES_KEY)
    return stored ?? []
  } catch {
    return []
  }
}

/**
 * 持久化用户规则
 */
export async function saveUserRules(rules: SiteRule[]): Promise<void> {
  await persistentStorage.set(USER_RULES_KEY, rules)
}

/**
 * 添加用户规则（同 id 覆盖）
 */
export async function addUserRule(rule: SiteRule): Promise<boolean> {
  if (!rule || !rule.hostPattern) return false
  const rules = await loadUserRules()
  const idx = rules.findIndex((r) => r.id === rule.id)
  if (idx >= 0) rules[idx] = rule
  else rules.push(rule)
  await saveUserRules(rules)
  return true
}

/**
 * 删除用户规则
 */
export async function removeUserRule(id: string): Promise<boolean> {
  const rules = await loadUserRules()
  const filtered = rules.filter((r) => r.id !== id)
  if (filtered.length === rules.length) return false
  await saveUserRules(filtered)
  return true
}

/**
 * 清空所有用户规则
 */
export async function clearUserRules(): Promise<void> {
  await saveUserRules([])
}

/**
 * 按页面 host 取匹配结果
 *
 * 合并所有命中规则的 adUrlPatterns/forceKeep（并集），
 * 取最具体（hostPattern 最长）规则的 scoreThreshold/mode/id/name 作为覆盖项与报告标识。
 */
export async function getSiteRule(pageHost: string): Promise<{
  rule: SiteRule | null
  patterns: RegExp[]
  forceKeep: RegExp[]
}> {
  const userRules = await loadUserRules()
  const remoteRules = getRemoteRulesCached()
  const all = [...BUILTIN_SITE_RULES, ...remoteRules, ...userRules].filter((r) => r.id !== 'drm-protected-sites')
  const matches = all.filter((r) => r && hostMatch(pageHost, r.hostPattern))
  if (matches.length === 0) {
    return { rule: null, patterns: [], forceKeep: [] }
  }

  // 按 hostPattern 长度倒序（最具体在前）
  matches.sort((a, b) => (b.hostPattern || '').length - (a.hostPattern || '').length)
  const primary = matches[0]!

  // 合并所有命中规则的 adUrlPatterns / forceKeep
  const allPats: string[] = []
  const allKeep: string[] = []
  for (const r of matches) {
    for (const p of r.adUrlPatterns) allPats.push(p)
    for (const k of r.forceKeep) allKeep.push(k)
  }

  const patterns = allPats
    .map((s) => {
      try {
        return new RegExp(s, 'i')
      } catch {
        return null
      }
    })
    .filter((p): p is RegExp => p !== null)

  const forceKeep = allKeep
    .map((s) => {
      try {
        return new RegExp(s, 'i')
      } catch {
        return null
      }
    })
    .filter((p): p is RegExp => p !== null)

  return { rule: primary, patterns, forceKeep }
}

/**
 * 列出所有规则（含 builtin + user），用于 UI 展示
 */
export async function listAllRules(): Promise<Array<SiteRule & { _builtin?: boolean; _user?: boolean; _remote?: boolean }>> {
  const userRules = await loadUserRules()
  const remoteRules = getRemoteRulesCached()
  const builtin = BUILTIN_SITE_RULES.map((r) => ({ ...r, _builtin: true }))
  const remote = remoteRules.map((r) => ({ ...r, _remote: true }))
  const user = userRules.map((r) => ({ ...r, _user: true }))
  return [...builtin, ...remote, ...user].filter((r) => r.id !== 'drm-protected-sites')
}

/**
 * 获取远程规则缓存（同步，返回内存缓存）
 */
function getRemoteRulesCached(): SiteRule[] {
  return remoteCache?.rules ?? []
}

/**
 * 刷新远程规则（从 remoteRulesUrl 拉取）
 */
export async function refreshRemoteRules(remoteRulesUrl: string): Promise<{ rules: number; ts: number }> {
  if (!remoteRulesUrl) {
    remoteCache = { rules: [], ts: 0 }
    return { rules: 0, ts: 0 }
  }
  try {
    const resp = await fetch(remoteRulesUrl, { cache: 'no-store' })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const arr = (await resp.json()) as SiteRule[]
    if (!Array.isArray(arr)) {
      remoteCache = { rules: [], ts: 0 }
      return { rules: 0, ts: 0 }
    }
    remoteCache = { rules: arr, ts: Date.now() }
    await persistentStorage.set(REMOTE_CACHE_KEY, remoteCache)
    return { rules: arr.length, ts: remoteCache.ts }
  } catch {
    // 退回上次缓存
    const cached = (await persistentStorage.get<{ rules: SiteRule[]; ts: number }>(REMOTE_CACHE_KEY)) ?? { rules: [], ts: 0 }
    remoteCache = cached
    return { rules: cached.rules.length, ts: cached.ts }
  }
}

/**
 * 从 storage 加载远程规则缓存到内存
 */
export async function loadRemoteCacheFromStorage(): Promise<void> {
  const cached = (await persistentStorage.get<{ rules: SiteRule[]; ts: number }>(REMOTE_CACHE_KEY)) ?? null
  remoteCache = cached
}