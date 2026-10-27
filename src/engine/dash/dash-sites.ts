/**
 * DASH 广告过滤 — 站点列表管理
 *
 * 内置已知 DASH 站点 + 用户自定义站点。
 * 仅在匹配站点上激活 DASH hook，非匹配站点零开销。
 */

import { persistentStorage } from '@/lib/storage'

const STORAGE_KEY = 'dashAdFilterUserSites'

export const BUILTIN_DASH_SITES: readonly string[] = [
  'bilibili.com',
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'dailymotion.com',
]

export interface DashSiteList {
  builtin: readonly string[]
  user: string[]
}

export async function loadDashSites(): Promise<DashSiteList> {
  const userSites = await persistentStorage.get<string[]>(STORAGE_KEY)
  return {
    builtin: BUILTIN_DASH_SITES,
    user: Array.isArray(userSites) ? userSites : [],
  }
}

export async function saveDashUserSites(sites: string[]): Promise<void> {
  const deduped = [...new Set(sites.map((s) => s.toLowerCase().trim()).filter(Boolean))]
  await persistentStorage.set(STORAGE_KEY, deduped)
}

export async function addDashSite(domain: string): Promise<string[]> {
  const sites = await loadDashSites()
  const normalized = domain.toLowerCase().trim()
  if (!normalized) return sites.user
  if (sites.user.includes(normalized) || sites.builtin.includes(normalized)) return sites.user
  const updated = [...sites.user, normalized]
  await saveDashUserSites(updated)
  return updated
}

export async function removeDashSite(domain: string): Promise<string[]> {
  const sites = await loadDashSites()
  const normalized = domain.toLowerCase().trim()
  const updated = sites.user.filter((s) => s !== normalized)
  await saveDashUserSites(updated)
  return updated
}

export function isDashSite(domain: string, siteList: DashSiteList): boolean {
  const lower = domain.toLowerCase()
  for (const pattern of siteList.builtin) {
    if (matchDomain(lower, pattern)) return true
  }
  for (const pattern of siteList.user) {
    if (matchDomain(lower, pattern)) return true
  }
  return false
}

function matchDomain(domain: string, pattern: string): boolean {
  if (domain === pattern) return true
  if (domain.endsWith('.' + pattern)) return true
  return false
}

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}