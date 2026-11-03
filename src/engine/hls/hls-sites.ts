import { persistentStorage, settingsStore } from '@/lib/storage'
import { DEFAULT_SETTINGS, type Settings } from '@/types'

export const HLS_SITE_SEEDS: string[] = [
  'bilibili.com',
  'iqiyi.com',
  'youku.com',
  'tencent.com',
  'mgtv.com',
  'sohu.com',
  'pptv.com',
  'ixigua.com',
  'douyin.com',
  'kuaishou.com',
  'weibo.com',
  'huoshan.com',
  'migu.cn',
  'le.com',
  'pplive.cn',
  'letv.com',
  'youtube.com',
  'youtu.be',
  'netflix.com',
  'disneyplus.com',
  'hbo.com',
  'amazon.com',
  'primevideo.com',
  'hulu.com',
  'paramountplus.com',
  'crunchyroll.com',
  'funimation.com',
  'viki.com',
  'dailymotion.com',
  'douyu.com',
  'huya.com',
  'bigo.tv',
  'twitch.tv',
  'kick.com',
  'coursera.org',
  'edx.org',
  'udemy.com',
  'ted.com',
  'github.io',
  'streamable.com',
  'test-streams.mux.dev',
]

const SEED_INIT_KEY = 'hlsSitesSeeded'
const MAX_LEARNED_SITES = 500

export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export function matchDomain(domain: string, pattern: string): boolean {
  const d = domain.toLowerCase()
  const p = pattern.toLowerCase()
  if (d === p) return true
  if (d.endsWith('.' + p)) return true
  return false
}

export function isInList(list: string[], domain: string): boolean {
  if (!domain) return false
  const lower = domain.toLowerCase()
  return list.some((pattern) => matchDomain(lower, pattern))
}

export function addSite(list: string[], domain: string): string[] {
  const normalized = domain.toLowerCase().trim()
  if (!normalized) return list
  if (isInList(list, normalized)) return list
  return [...list, normalized]
}

export function removeSite(list: string[], domain: string): string[] {
  const normalized = domain.toLowerCase().trim()
  if (!normalized) return list
  return list.filter((s) => !matchDomain(s, normalized))
}

export function getActiveSiteList(settings: Settings): string[] {
  return settings.hlsRunMode === 'smart'
    ? settings.hlsLearnedSites
    : settings.hlsEnabledSites
}

export function isHlsSite(domain: string, settings: Settings): boolean {
  if (!domain) return false
  if (isInList(settings.hlsDisabledSites, domain)) return false
  return isInList(getActiveSiteList(settings), domain)
}

export async function initSeedSitesIfNeeded(runMode: 'smart' | 'manual'): Promise<void> {
  const alreadySeeded = await persistentStorage.get<boolean>(SEED_INIT_KEY)
  if (alreadySeeded) return

  const stored = await settingsStore.get<Partial<Settings>>()
  const settings = { ...DEFAULT_SETTINGS, ...stored }
  const targetList = runMode === 'smart'
    ? settings.hlsLearnedSites
    : settings.hlsEnabledSites

  const merged = [...new Set([...HLS_SITE_SEEDS, ...targetList])]

  if (runMode === 'smart') {
    await settingsStore.set<Partial<Settings>>({ hlsLearnedSites: merged })
  } else {
    await settingsStore.set<Partial<Settings>>({ hlsEnabledSites: merged })
  }
  await persistentStorage.set(SEED_INIT_KEY, true)
}

export async function supplementSeedSites(runMode: 'smart' | 'manual'): Promise<{ added: number }> {
  const stored = await settingsStore.get<Partial<Settings>>()
  const settings = { ...DEFAULT_SETTINGS, ...stored }
  const targetList = runMode === 'smart'
    ? settings.hlsLearnedSites
    : settings.hlsEnabledSites

  const currentSet = new Set(targetList.map((s) => s.toLowerCase()))
  const missingSeeds = HLS_SITE_SEEDS.filter((s) => !currentSet.has(s))

  if (missingSeeds.length === 0) return { added: 0 }

  const merged = [...targetList, ...missingSeeds]
  if (runMode === 'smart') {
    await settingsStore.set<Partial<Settings>>({ hlsLearnedSites: merged })
  } else {
    await settingsStore.set<Partial<Settings>>({ hlsEnabledSites: merged })
  }
  return { added: missingSeeds.length }
}

export async function addLearnedSite(domain: string): Promise<boolean> {
  const normalized = domain.toLowerCase().trim()
  if (!normalized) return false

  const stored = await settingsStore.get<Partial<Settings>>()
  const settings = { ...DEFAULT_SETTINGS, ...stored }

  if (isInList(settings.hlsDisabledSites, normalized)) return false
  if (isInList(settings.hlsLearnedSites, normalized)) return false

  const trimmed = settings.hlsLearnedSites.length >= MAX_LEARNED_SITES
    ? settings.hlsLearnedSites.slice(settings.hlsLearnedSites.length - MAX_LEARNED_SITES + 1)
    : settings.hlsLearnedSites
  const updated = [...trimmed, normalized]
  await settingsStore.set<Partial<Settings>>({ hlsLearnedSites: updated })
  return true
}