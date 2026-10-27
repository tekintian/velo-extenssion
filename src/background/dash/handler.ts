/**
 * DASH 广告过滤 handler
 *
 * 处理消息:
 *   - processDashManifest(rawText, url, pageUrl)
 *     content script 拦截到 playurl/MPD 请求后发来原文
 *     background 调用 engine/dash 处理，返回清洗结果
 *
 *   返回结构:
 *     { mode, cleanedText?, summary?, reason? }
 */

import { registerHandler } from '@/background/messaging/router'
import { logger } from '@/lib/logger'
import { persistentStorage } from '@/lib/storage'
import { processManifest, detectManifestType } from '@/engine/dash/dash-filter'
import type { CleanedDashContext, DashAdFilterConfig } from '@/engine/dash/types'
import { getLearnedCount, clearLearned, listLearnedFingerprints, removeLearnedFingerprint } from '@engine/shared/fingerprint'
import { refreshRemoteRules, listAllRules, addUserRule, removeUserRule } from '@engine/shared/rules'
import { listPending, approve, dismiss } from '@engine/shared/suggest'
import { getMetrics, clearMetrics } from '@/engine/dash/metrics'
import { loadDashSites, isDashSite, extractDomain, addDashSite, removeDashSite, saveDashUserSites, BUILTIN_DASH_SITES } from '@/engine/dash/dash-sites'

const CLEANED_DASH_KEY = 'dashLastCleaned'

export function registerDashHandlers(): void {
  registerHandler<{ rawText: string; url: string; pageUrl: string; authHeaders?: Record<string, string>; config?: Partial<DashAdFilterConfig> }>('processDashManifest', async (message, _sender) => {
    const { rawText, url, pageUrl, authHeaders } = message.payload
    logger.info('[dash] processDashManifest called, url:', url.slice(0, 80), 'tabId:', _sender.tab?.id, 'textLen:', rawText.length)

    try {
      const stored = await persistentStorage.get<Partial<DashAdFilterConfig>>('dashFilterConfig')
      const config = { ...stored, ...message.payload.config }
      const result = await processManifest(rawText, url, pageUrl, authHeaders, config)
      logger.info('[dash] processManifest result mode:', result.mode)

      if (result.mode === 'manifest-file' || result.mode === 'data-url') {
        const ctx: CleanedDashContext = {
          url,
          pageUrl,
          manifestType: detectManifestType(rawText, url),
          cleanedText: result.cleanedText,
          adTargetCount: result.summary.adTargets,
          originalTargetCount: result.summary.totalTargets,
          timestamp: Date.now(),
        }
        await persistentStorage.set(CLEANED_DASH_KEY, ctx)
      }

      return result
    } catch (e) {
      logger.error('[dash] processManifest error:', (e as Error).message)
      return { mode: 'passthrough' as const, summary: { totalTargets: 0, adTargets: 0, signals: {} }, reason: 'internal-error' }
    }
  })

  registerHandler('getDashDelegation', async (_message, sender) => {
    try {
      const cfg = await persistentStorage.get<{ enabled?: boolean }>('dashFilterConfig')
      const enabled = cfg?.enabled ?? true
      if (!enabled) {
        return { mode: 'delegated' as const, reason: 'disabled' }
      }

      const pageUrl = sender.tab?.url ?? ''
      const domain = extractDomain(pageUrl)
      if (domain) {
        const siteList = await loadDashSites()
        if (!isDashSite(domain, siteList)) {
          return { mode: 'delegated' as const, reason: 'site-not-allowed' }
        }
      }

      return { mode: 'active' as const, reason: undefined }
    } catch {
      return { mode: 'active' as const }
    }
  })

  registerHandler('getDashFingerprintStats', async () => {
    return { learned: getLearnedCount() }
  })

  registerHandler('clearDashFingerprints', async () => {
    await clearLearned()
    return { ok: true }
  })

  registerHandler('refreshDashRemoteRules', async (message) => {
    const url = (message.payload as { url?: string })?.url ?? ''
    return await refreshRemoteRules(url)
  })

  registerHandler('listDashRules', async () => {
    return await listAllRules()
  })

  registerHandler('listDashSuggestPending', async () => {
    return await listPending()
  })

  registerHandler('approveDashSuggest', async (message) => {
    const id = (message.payload as { id?: string })?.id ?? ''
    return await approve(id)
  })

  registerHandler('dismissDashSuggest', async (message) => {
    const id = (message.payload as { id?: string })?.id ?? ''
    return await dismiss(id)
  })

  registerHandler('getDashMetrics', async () => {
    return await getMetrics()
  })

  registerHandler('clearDashMetrics', async () => {
    await clearMetrics()
    return { ok: true }
  })

  registerHandler('getDashSites', async () => {
    return await loadDashSites()
  })

  registerHandler('addDashSite', async (message) => {
    const domain = (message.payload as { domain?: string })?.domain ?? ''
    const updated = await addDashSite(domain)
    return { sites: updated }
  })

  registerHandler('removeDashSite', async (message) => {
    const domain = (message.payload as { domain?: string })?.domain ?? ''
    const updated = await removeDashSite(domain)
    return { sites: updated }
  })

  registerHandler('saveDashUserSites', async (message) => {
    const sites = (message.payload as { sites?: string[] })?.sites ?? []
    await saveDashUserSites(sites)
    return { ok: true }
  })

  registerHandler('getBuiltinDashSites', async () => {
    return { sites: BUILTIN_DASH_SITES }
  })

  registerHandler('listDashLearnedFingerprints', async () => {
    return { fingerprints: await listLearnedFingerprints() }
  })

  registerHandler('removeDashLearnedFingerprint', async (message) => {
    const hash = (message.payload as { hash?: string })?.hash ?? ''
    return { ok: await removeLearnedFingerprint(hash) }
  })

  registerHandler('addDashUserRule', async (message) => {
    const rule = (message.payload as { rule?: unknown })?.rule
    return { ok: await addUserRule(rule as import('@engine/shared/types').SiteRule) }
  })

  registerHandler('removeDashUserRule', async (message) => {
    const id = (message.payload as { id?: string })?.id ?? ''
    return { ok: await removeUserRule(id) }
  })
}

export async function getCleanedDashContext(): Promise<CleanedDashContext | null> {
  try {
    const ctx = await persistentStorage.get<CleanedDashContext>(CLEANED_DASH_KEY)
    return ctx ?? null
  } catch {
    return null
  }
}