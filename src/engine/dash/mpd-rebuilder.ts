/**
 * MPD XML 重建器（模式 A — 移除广告 Period + 时间重排 + XML 序列化）
 *
 * 核心逻辑：
 *   1. 从 DOM 树中移除广告 Period 节点
 *   2. 重排后续 Period 的 @start 属性（保持时间连续性）
 *   3. 序列化回 XML 字符串
 */

import type { MpdManifest, MpdPeriod } from './types'

export interface MpdRebuildResult {
  success: boolean
  cleanedXml: string | null
  removedPeriodIds: string[]
  reason?: string
}

export function rebuildMpd(
  mpd: MpdManifest,
  adPeriodIds: Set<string>,
): MpdRebuildResult {
  if (adPeriodIds.size === 0) {
    return { success: true, cleanedXml: null, removedPeriodIds: [] }
  }

  const remaining = mpd.periods.filter((p) => !adPeriodIds.has(p.id ?? ''))
  const removedPeriodIds = mpd.periods
    .filter((p) => adPeriodIds.has(p.id ?? ''))
    .map((p) => p.id ?? '')

  if (remaining.length === 0) {
    return {
      success: false,
      cleanedXml: null,
      removedPeriodIds,
      reason: 'all-periods-ad',
    }
  }

  const parser = new DOMParser()
  const doc = parser.parseFromString(mpd.rawXml, 'application/xml')

  const parseError = doc.querySelector('parsererror')
  if (parseError) {
    return {
      success: false,
      cleanedXml: null,
      removedPeriodIds,
      reason: 'xml-parse-error',
    }
  }

  const mpdEl = doc.getElementsByTagNameNS('urn:mpeg:dash:schema:mpd:2011', 'MPD')[0]
    ?? doc.getElementsByTagName('MPD')[0]

  if (!mpdEl) {
    return {
      success: false,
      cleanedXml: null,
      removedPeriodIds,
      reason: 'no-mpd-element',
    }
  }

  const periodEls = collectPeriodElements(mpdEl)

  const removedStartTimes = new Map<number, number>()
  let removedCumulativeDuration = 0

  for (let i = 0; i < periodEls.length; i++) {
    const periodEl = periodEls[i]!
    const periodId = periodEl.getAttribute('id') ?? ''

    if (adPeriodIds.has(periodId)) {
      const startAttr = periodEl.getAttribute('start')
      const start = startAttr ? parseDurationToSeconds(startAttr) : 0
      const durAttr = periodEl.getAttribute('duration')
      const dur = durAttr ? parseDurationToSeconds(durAttr) : 0

      removedStartTimes.set(i, start)
      removedCumulativeDuration += dur

      mpdEl.removeChild(periodEl)
    }
  }

  if (removedCumulativeDuration > 0) {
    reperiodStartTimes(mpdEl, mpd.periods, adPeriodIds)
  }

  const serializer = new XMLSerializer()
  let cleanedXml = serializer.serializeToString(doc)

  if (!cleanedXml.startsWith('<?xml')) {
    cleanedXml = '<?xml version="1.0" encoding="UTF-8"?>\n' + cleanedXml
  }

  return { success: true, cleanedXml, removedPeriodIds }
}

function collectPeriodElements(mpdEl: Element): Element[] {
  const result: Element[] = []
  const nsPeriods = mpdEl.getElementsByTagNameNS('urn:mpeg:dash:schema:mpd:2011', 'Period')
  if (nsPeriods.length > 0) {
    for (let i = 0; i < nsPeriods.length; i++) result.push(nsPeriods[i]!)
  } else {
    const fallback = mpdEl.getElementsByTagName('Period')
    for (let i = 0; i < fallback.length; i++) result.push(fallback[i]!)
  }
  return result
}

/**
 * 重排 Period@start 时间
 *
 * 移除广告 Period 后，后续 Period 的 @start 需要前移，
 * 确保播放器看到连续的时间轴。
 *
 * 算法：
 *   1. 遍历原始 periods 数组（已排序）
 *   2. 对每个非广告 Period，计算新的 start = 原始 start - 累计被移除的时长
 *   3. 更新 DOM 中对应 Period 元素的 @start 属性
 */
function reperiodStartTimes(
  mpdEl: Element,
  originalPeriods: MpdPeriod[],
  adPeriodIds: Set<string>,
): void {
  let cumulativeRemovedDuration = 0
  let lastContentEnd = 0

  const periodEls = collectPeriodElements(mpdEl)
  const elById = new Map<string, Element>()
  for (const el of periodEls) {
    const id = el.getAttribute('id')
    if (id) elById.set(id, el)
  }

  for (const period of originalPeriods) {
    const periodId = period.id ?? ''

    if (adPeriodIds.has(periodId)) {
      cumulativeRemovedDuration += period.duration ?? 0
      continue
    }

    const el = elById.get(periodId)
    if (!el) continue

    const originalStart = period.start ?? lastContentEnd
    const newStart = Math.max(0, originalStart - cumulativeRemovedDuration)

    if (newStart > 0 || originalStart > 0) {
      el.setAttribute('start', formatDuration(newStart))
    }

    lastContentEnd = originalStart + (period.duration ?? 0)
  }
}

function parseDurationToSeconds(val: string): number {
  const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(val)
  if (!match) return 0
  const h = parseFloat(match[1] ?? '0')
  const m = parseFloat(match[2] ?? '0')
  const s = parseFloat(match[3] ?? '0')
  return h * 3600 + m * 60 + s
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'PT0S'

  const h = Math.floor(seconds / 3600)
  const remaining = seconds - h * 3600
  const m = Math.floor(remaining / 60)
  const s = remaining - m * 60

  const parts: string[] = ['PT']
  if (h > 0) parts.push(`${h}H`)
  if (m > 0) parts.push(`${m}M`)
  if (s > 0) {
    const sStr = Number.isInteger(s) ? `${s}` : s.toFixed(3).replace(/\.?0+$/, '')
    parts.push(`${sStr}S`)
  }
  if (parts.length === 1) parts.push('0S')

  return parts.join('')
}