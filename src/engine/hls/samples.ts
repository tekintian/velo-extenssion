import { persistentStorage } from '@/lib/storage'
import type { Segment } from './types'
import { computeFingerprint, learnFingerprint } from './fingerprint'

const KEY = 'hlsAdSamples'
const MAX = 100
const DEFAULT_WINDOW = 3

export interface SampleSegment {
  readonly index: number
  readonly url: string
  readonly duration: number
  readonly discontinuity: boolean
  readonly seqNum: number | null
  readonly isCurrent: boolean
  readonly signals: readonly string[]
}

export interface AdSample {
  readonly id: string
  readonly ts: number
  readonly pageHost: string
  readonly baseUrl: string
  readonly currentTime: number
  readonly currentSegIndex: number
  readonly appliedRule: { id: string; name: string } | null
  readonly report: { ads: number; total: number; adDuration: number } | null
  readonly window: SampleSegment[]
  note: string
}

export function findSegIndexAtTime(segments: readonly Segment[], currentTime: number): number {
  if (!segments || segments.length === 0) return -1
  let t = 0
  for (let i = 0; i < segments.length; i++) {
    const dur = segments[i]!.duration || 0
    if (currentTime < t + dur) return i
    t += dur
  }
  return segments.length - 1
}

export function captureSample(
  segments: readonly Segment[],
  currentTime: number,
  pageHost: string,
  baseUrl: string,
  report: { ads: number; total: number; adDuration: number; appliedRule?: { id: string; name: string } | null } | null,
  reasons: Record<number, string[]> | undefined,
  N = DEFAULT_WINDOW,
): AdSample | null {
  const cur = findSegIndexAtTime(segments, currentTime)
  if (cur < 0) return null
  const start = Math.max(0, cur - N)
  const end = Math.min(segments.length - 1, cur + N)
  const win: SampleSegment[] = []
  for (let i = start; i <= end; i++) {
    const s = segments[i]!
    win.push({
      index: s.index, url: s.url, duration: s.duration,
      discontinuity: s.discontinuity, seqNum: s.seqNum,
      isCurrent: i === cur, signals: reasons?.[s.index] ?? [],
    })
  }
  return {
    id: `sample-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    ts: Date.now(), pageHost: pageHost || '', baseUrl: baseUrl || '',
    currentTime, currentSegIndex: cur,
    appliedRule: report?.appliedRule ?? null,
    report: report ? { ads: report.ads, total: report.total, adDuration: report.adDuration } : null,
    window: win, note: '',
  }
}

export async function recordSample(sample: AdSample): Promise<boolean> {
  if (!sample) return false
  const list = (await persistentStorage.get<AdSample[]>(KEY)) ?? []
  list.unshift(sample)
  if (list.length > MAX) list.length = MAX
  await persistentStorage.set(KEY, list)
  return true
}

export async function listSamples(): Promise<AdSample[]> {
  return (await persistentStorage.get<AdSample[]>(KEY)) ?? []
}

export async function clearSamples(): Promise<void> {
  await persistentStorage.set(KEY, [])
}

export async function removeSample(id: string): Promise<boolean> {
  const list = await listSamples()
  const filtered = list.filter((s) => s.id !== id)
  if (filtered.length === list.length) return false
  await persistentStorage.set(KEY, filtered)
  return true
}

export async function setSampleNote(id: string, note: string): Promise<boolean> {
  const list = await listSamples()
  const s = list.find((x) => x.id === id)
  if (!s) return false
  s.note = note
  await persistentStorage.set(KEY, list)
  return true
}

export async function getSampleCount(): Promise<number> {
  const list = await listSamples()
  return list.length
}

export async function autoLearnFromSample(sample: AdSample): Promise<number> {
  if (!sample || !sample.window) return 0
  const curIdx = sample.window.findIndex((w) => w.isCurrent)
  if (curIdx < 0) return 0

  let blockStart = curIdx
  if (!sample.window[curIdx]!.discontinuity) {
    for (let i = curIdx - 1; i >= 0; i--) {
      if (sample.window[i]!.discontinuity) { blockStart = i; break }
    }
  }
  let blockEnd = curIdx
  for (let i = curIdx + 1; i < sample.window.length; i++) {
    if (sample.window[i]!.discontinuity) break
    blockEnd = i
  }

  let learnedCount = 0
  for (let j = blockStart; j <= blockEnd; j++) {
    const w = sample.window[j]!
    try {
      const hash = await computeFingerprint(w.url)
      if (hash) {
        const added = await learnFingerprint(hash, { adName: `user-sample:${sample.pageHost || '?'}`, source: 'user-marked' })
        if (added) learnedCount++
      }
    } catch { /* ignore */ }
  }
  return learnedCount
}
