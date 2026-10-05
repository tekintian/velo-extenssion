import { persistentStorage } from '@/lib/storage'
import type { SiteRule } from './types'

export const BUILTIN_SITE_RULES: SiteRule[] = [
  {
    id: 'generic-ad-CDN',
    name: '通用广告 CDN 域名',
    hostPattern: '',
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
    scoreThreshold: 2,
    mode: 'enumerate',
    forceKeep: [],
  },
]

const USER_RULES_KEY = 'hlsUserRules'
const REMOTE_CACHE_KEY = 'hlsRemoteRulesCache'

let remoteCache: { rules: SiteRule[]; ts: number } | null = null

function hostMatch(host: string, pattern: string): boolean {
  if (!pattern) return true
  try {
    return new RegExp(pattern, 'i').test(host || '')
  } catch {
    return false
  }
}

export async function loadUserRules(): Promise<SiteRule[]> {
  try {
    const stored = await persistentStorage.get<SiteRule[]>(USER_RULES_KEY)
    return stored ?? []
  } catch {
    return []
  }
}

export async function saveUserRules(rules: SiteRule[]): Promise<void> {
  await persistentStorage.set(USER_RULES_KEY, rules)
}

export async function addUserRule(rule: SiteRule): Promise<boolean> {
  if (!rule || !rule.hostPattern) return false
  const rules = await loadUserRules()
  const idx = rules.findIndex((r) => r.id === rule.id)
  if (idx >= 0) rules[idx] = rule
  else rules.push(rule)
  await saveUserRules(rules)
  return true
}

export async function removeUserRule(id: string): Promise<boolean> {
  const rules = await loadUserRules()
  const filtered = rules.filter((r) => r.id !== id)
  if (filtered.length === rules.length) return false
  await saveUserRules(filtered)
  return true
}

export async function clearUserRules(): Promise<void> {
  await saveUserRules([])
}

export async function getSiteRule(pageHost: string): Promise<{
  rule: SiteRule | null
  patterns: RegExp[]
  forceKeep: RegExp[]
}> {
  const userRules = await loadUserRules()
  const remoteRules = getRemoteRulesCached()
  const all = [...BUILTIN_SITE_RULES, ...remoteRules, ...userRules]
  const matches = all.filter((r) => r && hostMatch(pageHost, r.hostPattern))
  if (matches.length === 0) {
    return { rule: null, patterns: [], forceKeep: [] }
  }

  matches.sort((a, b) => (b.hostPattern || '').length - (a.hostPattern || '').length)
  const primary = matches[0]!

  const allPats: string[] = []
  const allKeep: string[] = []
  for (const r of matches) {
    for (const p of r.adUrlPatterns) allPats.push(p)
    for (const k of r.forceKeep) allKeep.push(k)
  }

  const patterns = allPats.map((s) => { try { return new RegExp(s, 'i') } catch { return null } }).filter((p): p is RegExp => p !== null)
  const forceKeep = allKeep.map((s) => { try { return new RegExp(s, 'i') } catch { return null } }).filter((p): p is RegExp => p !== null)

  return { rule: primary, patterns, forceKeep }
}

export async function listAllRules(): Promise<Array<SiteRule & { _builtin?: boolean; _user?: boolean; _remote?: boolean }>> {
  const userRules = await loadUserRules()
  const remoteRules = getRemoteRulesCached()
  const builtin = BUILTIN_SITE_RULES.map((r) => ({ ...r, _builtin: true }))
  const remote = remoteRules.map((r) => ({ ...r, _remote: true }))
  const user = userRules.map((r) => ({ ...r, _user: true }))
  return [...builtin, ...remote, ...user]
}

function getRemoteRulesCached(): SiteRule[] {
  return remoteCache?.rules ?? []
}

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
    const cached = (await persistentStorage.get<{ rules: SiteRule[]; ts: number }>(REMOTE_CACHE_KEY)) ?? { rules: [], ts: 0 }
    remoteCache = cached
    return { rules: cached.rules.length, ts: cached.ts }
  }
}

export async function loadRemoteCacheFromStorage(): Promise<void> {
  const cached = (await persistentStorage.get<{ rules: SiteRule[]; ts: number }>(REMOTE_CACHE_KEY)) ?? null
  remoteCache = cached
}
