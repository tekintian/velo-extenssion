/**
 * 广告过滤统计持久化看板 — 移植自 NDM stats.js
 *
 * 用途：跨会话累计过滤统计，让用户看到长期价值（已过滤多少广告/节省多少广告时间）
 * 按 host/规则/日期维度聚合，保留最近 50 条报告明细
 *
 * 数据结构 (chrome.storage.local.hlsStats):
 *   { total:   {ads, adDuration, contentDuration, reports},
 *     byHost:  { 'watch.x.com': {ads, adDuration, reports, lastSeen} },
 *     byRule:  { 'streaming-preroll': {ads, reports} },
 *     byDay:   { '2026-09-29': {ads, adDuration} },
 *     recent:  [ {host, ads, adDuration, rule, ts}, ... ] (≤50) }
 */

import { persistentStorage } from '@/lib/storage'

const KEY = 'hlsStats'

export interface HlsStats {
  total: { ads: number; adDuration: number; contentDuration: number; reports: number }
  byHost: Record<string, { ads: number; adDuration: number; reports: number; lastSeen: number }>
  byRule: Record<string, { ads: number; reports: number }>
  byDay: Record<string, { ads: number; adDuration: number }>
  recent: Array<{ host: string; ads: number; adDuration: number; rule: string | null; ts: number }>
}

function emptyStats(): HlsStats {
  return {
    total: { ads: 0, adDuration: 0, contentDuration: 0, reports: 0 },
    byHost: {},
    byRule: {},
    byDay: {},
    recent: [],
  }
}

function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function fmtDur(sec: number): string {
  const s = Math.round(sec || 0)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}m${r ? `${r}s` : ''}`
}

/**
 * 记录一次过滤报告
 */
export async function recordStats(
  report: { ads: number; adDuration: number; contentDuration: number; appliedRule?: { id: string } | null },
  pageHost: string,
): Promise<boolean> {
  if (!report || !report.ads) return false
  const cache = (await persistentStorage.get<HlsStats>(KEY)) ?? emptyStats()
  const now = Date.now()
  const ads = report.ads || 0
  const adDur = report.adDuration || 0
  const conDur = report.contentDuration || 0

  cache.total.ads += ads
  cache.total.adDuration += adDur
  cache.total.contentDuration += conDur
  cache.total.reports += 1

  if (pageHost) {
    const h = cache.byHost[pageHost] ?? { ads: 0, adDuration: 0, reports: 0, lastSeen: 0 }
    h.ads += ads
    h.adDuration += adDur
    h.reports += 1
    h.lastSeen = now
    cache.byHost[pageHost] = h
  }

  if (report.appliedRule?.id) {
    const rid = report.appliedRule.id
    const r = cache.byRule[rid] ?? { ads: 0, reports: 0 }
    r.ads += ads
    r.reports += 1
    cache.byRule[rid] = r
  }

  const dk = dayKey(now)
  const d = cache.byDay[dk] ?? { ads: 0, adDuration: 0 }
  d.ads += ads
  d.adDuration += adDur
  cache.byDay[dk] = d

  cache.recent.unshift({
    host: pageHost || '',
    ads,
    adDuration: adDur,
    rule: report.appliedRule?.id ?? null,
    ts: now,
  })
  if (cache.recent.length > 50) cache.recent.length = 50

  await persistentStorage.set(KEY, cache)
  return true
}

/**
 * 获取全部统计
 */
export async function getStats(): Promise<HlsStats> {
  return (await persistentStorage.get<HlsStats>(KEY)) ?? emptyStats()
}

/**
 * 清空统计
 */
export async function clearStats(): Promise<void> {
  await persistentStorage.set(KEY, emptyStats())
}
