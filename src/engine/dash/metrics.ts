/**
 * DASH 监控指标收集
 *
 * 指标项:
 *   - manifestIntercepted: DASH manifest 拦截次数
 *   - adDetected: 广告检测命中次数
 *   - cleanSuccess: 清洗成功次数
 *   - fingerprintHit: 指纹库命中次数
 *   - parseFail: 解析失败次数
 *   - rebuildFail: 重建失败次数
 *   - drmDetected: DRM 检测次数
 *   - dynamicPassthrough: 动态 MPD passthrough 次数
 */

import { persistentStorage } from '@/lib/storage'
import { logger } from '@/lib/logger'

const DASH_METRICS_KEY = 'dashMetrics'

export interface DashMetrics {
  manifestIntercepted: number
  adDetected: number
  cleanSuccess: number
  fingerprintHit: number
  parseFail: number
  rebuildFail: number
  drmDetected: number
  dynamicPassthrough: number
}

const EMPTY_METRICS: DashMetrics = {
  manifestIntercepted: 0,
  adDetected: 0,
  cleanSuccess: 0,
  fingerprintHit: 0,
  parseFail: 0,
  rebuildFail: 0,
  drmDetected: 0,
  dynamicPassthrough: 0,
}

let cached: DashMetrics | null = null

export async function getMetrics(): Promise<DashMetrics> {
  if (cached) return cached
  try {
    const stored = await persistentStorage.get<DashMetrics>(DASH_METRICS_KEY)
    cached = stored ?? { ...EMPTY_METRICS }
  } catch {
    cached = { ...EMPTY_METRICS }
  }
  return cached!
}

async function inc(key: keyof DashMetrics, delta = 1): Promise<void> {
  const m = await getMetrics()
  m[key] += delta
  cached = m
  try {
    await persistentStorage.set(DASH_METRICS_KEY, m)
  } catch (e) {
    logger.warn('[dash-metrics] persist failed:', (e as Error).message)
  }
}

export async function incManifestIntercepted(): Promise<void> { await inc('manifestIntercepted') }
export async function incAdDetected(): Promise<void> { await inc('adDetected') }
export async function incCleanSuccess(): Promise<void> { await inc('cleanSuccess') }
export async function incFingerprintHit(): Promise<void> { await inc('fingerprintHit') }
export async function incParseFail(): Promise<void> { await inc('parseFail') }
export async function incRebuildFail(): Promise<void> { await inc('rebuildFail') }
export async function incDrmDetected(): Promise<void> { await inc('drmDetected') }
export async function incDynamicPassthrough(): Promise<void> { await inc('dynamicPassthrough') }

export async function clearMetrics(): Promise<void> {
  cached = { ...EMPTY_METRICS }
  try {
    await persistentStorage.set(DASH_METRICS_KEY, cached)
  } catch { /* ignore */ }
}