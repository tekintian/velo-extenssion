/**
 * HLS 广告分片过滤 handler
 *
 * 处理消息:
 *   - processHlsPlaylist(text, baseUrl, pageUrl)
 *     content script 拦截到 m3u8 请求后发来原文
 *     background 调用 engine/hls 处理，返回清洗结果
 *
 *   返回结构（content script 用）:
 *     { mode, url?, cleaned?, report, segments?, adRanges? }
 *     - mode='disabled'        HLS 过滤关闭，content script 原样放行
 *     - mode='master'          master 列表，content script 原样放行（递归处理 variants）
 *     - mode='no-ads'          无广告，原样放行
 *     - mode='passthrough'     调试模式，原样放行（但返回 reasons/adRanges 供 UI）
 *     - mode='m3u8-file'        返回 cleaned m3u8 文本，content script 可下载
 *     - mode='data-url'        返回 data: URL，content script 可直接播放
 */

import { registerHandler } from '@/background/messaging/router'
import { logger } from '@/lib/logger'
import { i18n } from '@/lib/i18n'
import { PushUnconfirmedError } from '@/background/push-client'
import { extractBaseName, isBadName } from '@/lib/naming'
import { persistentStorage, settingsStore } from '@/lib/storage'
import type { BackupPayload } from '@/engine/hls/io'
import { DEFAULT_SETTINGS, type Settings } from '@/types'
import { buildConfig, DEFAULT_CONFIG, processPlaylist, resolveMediaVariant } from '@/engine/hls/hls-filter'
import type { ProcessResult } from '@/engine/hls/types'
import { consider, listPending, approve, dismiss } from '@/engine/hls/suggest'
import { recordStats, getStats, clearStats } from '@/engine/hls/stats'
import {
  captureSample,
  recordSample,
  autoLearnFromSample,
  listSamples,
  removeSample,
  clearSamples,
  setSampleNote,
  computeDiscontinuityBlock,
  resolveSampleBlock,
  resolveVerdict,
  applyVerdict,
  applyFullBlock,
  isValidVerdict,
  revokeFingerprint,
  type AdSample,
  type SampleSegment,
} from '@/engine/hls/samples'
import { buildExport, applyImport } from '@/engine/hls/io'
import { getLearnedCount, clearLearned } from '@/engine/hls/fingerprint'
import { refreshRemoteRules, listAllRules } from '@/engine/hls/hls-rules'
import { getDownloadConfig, sendToAria2, sendToNative, sendToNdm, sendToVeloM3u8, materializeDataUrl, getPushClient, buildVeloHeaders } from '@/background/media/download-client'
import { getMediaItems, resolveHlsDelegation } from '@/background/media/sniffer'
import {
  addSite,
  removeSite,
  supplementSeedSites,
  isInList,
  extractDomain,
  HLS_SITE_SEEDS,
} from '@/engine/hls/hls-sites'

/** per-tab 最近清洗后的 m3u8 上下文（供下载按钮用） */
export interface CleanedContext {
  readonly cleaned: string
  readonly baseName: string
  readonly pageTitle?: string
  readonly report: { ads: number; total: number; adDuration: number; contentDuration: number; appliedRule?: { id: string; name: string } | null }
  readonly segments: ReadonlyArray<{ index: number; url: string; duration: number; discontinuity: boolean; seqNum: number | null; title: string; byterange: string | null; cueState: 'out' | null; scte35: string | null; dateRangeAd: string | null }>
  readonly reasons: Record<number, string[]>
  readonly pageHost: string
  readonly baseUrl: string
  readonly detectedAt: number
  /**
   * 播放器实际播放的列表来源
   *
   * 页面播放链路永不替换播放器拿到的 m3u8 响应（clean 后的 m3u8 只用于下发下载客户端），
   * 因此播放器时间轴上广告分片始终存在，恒为 'original'。
   * 'cleaned' 仅为历史类型保留，当前链路不会产生该值。
   */
  readonly playback?: 'cleaned' | 'original'
}

const CLEANED_KEY = 'hlsLastCleaned'

/** 样本草稿有效期：用户离开页面后草稿失效，避免内存泄漏 */
const DRAFT_TTL_MS = 5 * 60 * 1000

interface SampleDraft {
  sample: AdSample
  /** 当前片所属的完整 discontinuity 块，供「载入完整广告块」使用 */
  readonly fullBlock: SampleSegment[]
  readonly tabId: number
  readonly createdAt: number
}

/**
 * 样本草稿（仅存内存，不落盘）
 *
 * 保存样本改为两段式：captureSample 生成草稿 → 页面确认卡复核 →
 * commitSample 才落库并学指纹。草稿不落盘，页面关闭即自然丢失。
 */
const drafts = new Map<string, SampleDraft>()

function pruneDrafts(): void {
  const now = Date.now()
  for (const [id, d] of drafts) {
    if (now - d.createdAt > DRAFT_TTL_MS) drafts.delete(id)
  }
}

/**
 * 取草稿并校验 TTL
 *
 * 所有草稿访问都必须走这里：只在创建时 prune 不够，
 * 用户可能停在确认卡上超过 TTL 再点确认，此时草稿必须视为已失效，
 * 否则会用过期的分片元数据落库并学习指纹。
 */
function getDraft(draftId: string): SampleDraft | null {
  const d = drafts.get(draftId)
  if (!d) return null
  if (Date.now() - d.createdAt > DRAFT_TTL_MS) {
    drafts.delete(draftId)
    return null
  }
  return d
}

/** 生成草稿：captureSample 唯一入口 */
async function handleCaptureDraft(
  tabId: number,
  currentTime: number,
): Promise<
  | { ok: false; error: string }
  | { ok: true; draftId: string; pageHost: string; currentTime: number; currentSegIndex: number; segments: ReturnType<typeof mapSegment>[]; expandable: boolean }
> {
  let pageUrl = ''
  try {
    pageUrl = (await chrome.tabs.get(tabId)).url ?? ''
  } catch (e) {
    logger.warn('[hls] captureSample: tab lookup failed, tabId:', tabId, (e as Error).message)
  }
  if (!pageUrl) return { ok: false, error: 'no-m3u8-context' }

  const delegation = await resolveHlsDelegation(pageUrl)
  if (!delegation.active) return { ok: false, error: 'site-inactive' }

  const ctx = await loadCleanedContext(tabId)
  if (!ctx || !ctx.segments || ctx.segments.length === 0) {
    return { ok: false, error: 'no-m3u8-context' }
  }

  let sample: AdSample | null = null
  try {
    sample = captureSample(ctx.segments, currentTime, ctx.pageHost, ctx.baseUrl, ctx.report, ctx.reasons)
  } catch (e) {
    logger.warn('[hls] captureSample failed:', (e as Error).message)
    return { ok: false, error: 'capture-failed' }
  }
  if (!sample) return { ok: false, error: 'sample-out-of-range' }

  const fullBlock: SampleSegment[] = []
  const blk = computeDiscontinuityBlock(ctx.segments, sample.currentSegIndex)
  if (blk) {
    for (let i = blk.start; i <= blk.end; i++) {
      const seg = ctx.segments[i]!
      const known = sample.block?.find((b) => b.index === seg.index)
      const signals = known?.signals ?? []
      fullBlock.push({
        index: seg.index,
        url: seg.url,
        duration: seg.duration,
        discontinuity: seg.discontinuity,
        seqNum: seg.seqNum,
        isCurrent: i === sample.currentSegIndex,
        signals,
        verdict: known?.verdict ?? (signals.length > 0 ? 'ad' : 'unknown'),
      })
    }
  }

  const draftId = `draft-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  drafts.set(draftId, { sample, fullBlock, tabId, createdAt: Date.now() })
  pruneDrafts()

  // 完整块是否比当前可见清单更大：只有更大时才需要给用户「载入完整广告块」入口。
  // 不能简单判断 block 是否存在 —— 无 discontinuity 时 block 恒等于整段，
  // 与 window 完全重合，此时按钮点了也不会多加载任何分片。
  const visible = resolveSampleBlock(sample)
  const expandable = fullBlock.length > visible.length

  return {
    ok: true,
    draftId,
    pageHost: sample.pageHost,
    currentTime: sample.currentTime,
    currentSegIndex: sample.currentSegIndex,
    segments: visible.map(mapSegment),
    expandable,
  }
}

/** 分片 → 前端可用的精简结构（不暴露 URL，避免被拼装成任意请求） */
function mapSegment(s: SampleSegment) {
  return {
    index: s.index,
    duration: s.duration,
    discontinuity: s.discontinuity,
    isCurrent: s.isCurrent,
    signals: s.signals,
    verdict: resolveVerdict(s),
  }
}


export function registerHlsHandlers(): void {
  registerHandler<{ text: string; baseUrl: string; pageUrl: string }>('processHlsPlaylist', async (message, _sender) => {
    const { text, baseUrl, pageUrl } = message.payload
    logger.info('[hls] processHlsPlaylist called, baseUrl:', baseUrl.slice(0, 80), 'tabId:', _sender.tab?.id, 'textLen:', text.length)

    // 1. 读 Settings，检查 HLS 过滤是否启用（合并 DEFAULT_SETTINGS 防止旧版缺字段）
    try {
      const stored = await settingsStore.get<typeof DEFAULT_SETTINGS>()
      const settings = { ...DEFAULT_SETTINGS, ...stored }
      if (!settings.enableHlsAdFilter) {
        logger.info('[hls] HLS filter disabled by settings')
        return { mode: 'disabled' as const }
      }
    } catch (e) {
      logger.warn('[hls] read settings failed, default to disabled:', (e as Error).message)
      return { mode: 'disabled' as const }
    }

    // 2. 构建 pageHost
    let pageHost = ''
    try {
      if (pageUrl) pageHost = new URL(pageUrl).host
    } catch {
      // ignore
    }

    // 3. 构建运行时配置（合并默认 + 用户 + 站点规则）
    try {
      // DEFAULT_CONFIG.logToConsole 跟随 settings.enableLogging
      const stored = await settingsStore.get<typeof DEFAULT_SETTINGS>()
      const settings = { ...DEFAULT_SETTINGS, ...stored }
      // 合并指纹库配置
      const fpCfg = (await persistentStorage.get<Record<string, unknown>>('hlsFilterConfig')) ?? {}
      const cfg = await buildConfig(
        {
          ...DEFAULT_CONFIG,
          // 页面播放链路固定 passthrough：只计算广告区间与报告，绝不产出清洗结果
          // 投递模式（m3u8-file / data-url）只对媒体下载与推送链路生效，
          // 播放器数据源必须保持原样（data-url 并非所有播放器支持，且会破坏相对路径解析）
          mode: 'passthrough' as const,
          enabled: true,
          logToConsole: settings.enableLogging,
          enableFingerprint: (fpCfg.enableFingerprint as boolean) ?? false,
          fingerprintMode: ((fpCfg.fingerprintMode as string) ?? 'suspicious-only') as 'off' | 'suspicious-only' | 'all',
          autoLearnFingerprints: (fpCfg.autoLearnFingerprints as boolean) ?? true,
          remoteFingerprintsUrl: (fpCfg.remoteFingerprintsUrl as string) ?? '',
        },
        pageHost,
      )

      // 4. 调用 processPlaylist（从嗅探器提取 requestHeaders 供指纹 fetch 认证）
      let hlsAuthHeaders: Record<string, string> | undefined
      try {
        const tabId = _sender.tab?.id ?? 0
        const items = getMediaItems(tabId)
        const m3u8Item = items.find((i) => i.ext === 'm3u8' || i.ext === 'm3u')
        if (m3u8Item?.requestHeaders && Object.keys(m3u8Item.requestHeaders).length > 0) {
          hlsAuthHeaders = m3u8Item.requestHeaders
        }
      } catch { /* ignore */ }
      const raw = await processPlaylist(text, baseUrl, pageUrl, cfg, hlsAuthHeaders)

      // master 列表下钻：主列表只有变体索引，广告在变体媒体列表里。
      // 页面链路固定 passthrough，只拿区间与报告，数据源保持原样。
      // 下钻结果一次性复用：检测、区间下发、下载清洗都以它为准，避免重复拉取变体导致
      // 两次解析结果漂移（曾出现 popup 已显示广告数但下发区间为空的错位）。
      let resolved: ProcessResult = raw
      let mediaUrl = baseUrl
      let mediaText = text
      if (raw.mode === 'master') {
        const variant = await resolveMediaVariant(text, baseUrl, cfg, hlsAuthHeaders)
        if (!variant) {
          logger.info('[hls] master playlist has no usable variant, baseUrl:', baseUrl.slice(0, 80))
          return { mode: 'master' as const, adRanges: [], report: raw.report }
        }
        mediaUrl = variant.url
        mediaText = variant.text
        resolved = await processPlaylist(variant.text, variant.url, pageUrl, cfg, hlsAuthHeaders)
      }

      // 5. 广播报告给当前 tab 的 badge content script（阶段 3a）
      if (resolved.report && _sender.tab?.id) {
        try {
          await chrome.tabs.sendMessage(_sender.tab.id, {
            type: 'hlsFilterReport',
            report: resolved.report,
          })
        } catch {
          // badge 未注入 — 忽略
        }
      }

      // 5b. 区间下发统一在第 7 阶段（cleaned 广播）处理：
      //     本链路是页面 hook 主动请求过滤，响应必然被替换，区间恒空，此处不再重复发送

      // 6. 阶段 3b: 规则自动建议（从命中 reasons 提取 url-pattern 候选）
      if ('reasons' in resolved && resolved.reasons && Object.keys(resolved.reasons).length > 0) {
        try {
          const considerPageHost = (() => {
            try {
              return pageUrl ? new URL(pageUrl).host : ''
            } catch {
              return ''
            }
          })()
          await consider(resolved.reasons, considerPageHost, cfg._appliedRule?.id)
        } catch (e) {
          logger.warn('[hls] suggest failed:', (e as Error).message)
        }
      }

      // 7. 阶段 3: 页面播放只下发广告区间；清洗结果单独计算并持久化，仅供下载/推送
      //    页面播放数据源绝不修改（passthrough），广告由 badge 按区间 seek 跳过
      if (resolved.report && _sender.tab?.id) {
        const adRanges = ('adRanges' in resolved ? resolved.adRanges : []) as Array<{ start: number; end: number; duration: number }>
        const baseName = extractBaseName(mediaUrl)
        let pageTitle = ''
        try {
          const tab = await chrome.tabs.get(_sender.tab.id)
          pageTitle = tab?.title?.trim() || ''
        } catch { /* ignore */ }

        // 下载/推送链路：独立用投递模式算一次清洗结果，失败不影响播放
        // master 情况必须基于已下钻的实际媒体列表，否则下载到的仍是只有变体索引的主列表。
        // mediaText/mediaUrl 已在上方一次性解析，此处不再重复下钻拉取变体。
        if (adRanges.length > 0) {
          try {
            const dlCfg = await buildConfig(
              { ...cfg, mode: 'm3u8-file' as const },
              pageHost,
            )
            const dlResult = await processPlaylist(mediaText, mediaUrl, pageUrl, dlCfg, hlsAuthHeaders)
            if ('cleaned' in dlResult && typeof dlResult.cleaned === 'string') {
              const ctx: CleanedContext = {
                cleaned: dlResult.cleaned,
                baseName,
                pageTitle,
                report: dlResult.report as CleanedContext['report'],
                segments: ('segments' in dlResult ? dlResult.segments : []) as CleanedContext['segments'],
                reasons: ('reasons' in dlResult ? dlResult.reasons : {}) as Record<number, string[]>,
                pageHost,
                baseUrl: mediaUrl,
                detectedAt: Date.now(),
                playback: 'original',
              }
              await persistCleanedContext(_sender.tab.id, ctx)
            }
            try {
              await recordStats(dlResult.report as { ads: number; adDuration: number; contentDuration: number; appliedRule?: { id: string } | null }, pageHost)
            } catch (e) {
              logger.warn('[hls] recordStats failed:', (e as Error).message)
            }
          } catch (e) {
            logger.warn('[hls] download-mode filter failed:', (e as Error).message)
          }
        }

        // 广播 hlsFilterResult 给 player-panel（下载按钮 + AdSkipper 区间）
        try {
          await chrome.tabs.sendMessage(_sender.tab.id, {
            type: 'hlsFilterResult',
            adRanges,
            baseName,
            pageTitle,
            report: resolved.report,
          })
          logger.info('[hls] hlsFilterResult broadcasted, ranges:', adRanges.length, 'baseName:', baseName)
        } catch {
          // player-panel 未注入 — 忽略
        }
      }

      // 8. 返回（序列化 Set/Map → array/object 便于跨消息传递）
      const ret: Record<string, unknown> = { mode: resolved.mode }
      if ('url' in resolved) ret.url = resolved.url
      if ('cleaned' in resolved) ret.cleaned = resolved.cleaned
      ret.report = resolved.report
      if ('segments' in resolved) ret.segments = resolved.segments
      if ('adRanges' in resolved) ret.adRanges = resolved.adRanges
      return ret as { mode: string; url?: string; cleaned?: string; report?: unknown; segments?: unknown; adRanges?: unknown }
    } catch (e) {
      logger.error('[hls] processHlsPlaylist failed:', (e as Error).message)
      // 失败时返回 disabled，content script 原样放行（不阻塞视频播放）
      return { mode: 'disabled' as const, error: (e as Error).message }
    }
  })

  // === 阶段 3b: 规则建议管理 ===
  registerHandler('listSuggestPending', async () => {
    return await listPending()
  })

  // 别名：前端调用 listSuggestions 时映射到 listSuggestPending
  registerHandler('listSuggestions', async () => {
    return await listPending()
  })

  registerHandler<{ id: string }>('approveSuggestion', async (message) => {
    const { id } = message.payload
    const ok = await approve(id)
    if (!ok) throw new Error('Suggestion not found')
    return { success: true as const }
  })

  registerHandler<{ id: string }>('dismissSuggestion', async (message) => {
    const { id } = message.payload
    const ok = await dismiss(id)
    if (!ok) throw new Error('Suggestion not found')
    return { success: true as const }
  })

  // === 阶段 3: 样本管理 ===
  registerHandler('listSamples', async () => {
    return await listSamples()
  })

  // 删除样本连带撤销其 user-marked 指纹：删样本必须能真正回滚误标
  registerHandler<{ id: string }>('removeSample', async (message) => {
    const { id } = message.payload
    const revoked = await removeSample(id)
    return { success: true as const, revoked: revoked ?? 0 }
  })

  // 别名：options 页历史代码调用 deleteSample
  registerHandler<{ id: string }>('deleteSample', async (message) => {
    const { id } = message.payload
    const revoked = await removeSample(id)
    return { success: true as const, revoked: revoked ?? 0 }
  })

  registerHandler('clearSamples', async () => {
    const revoked = await clearSamples()
    return { success: true as const, revoked }
  })

  registerHandler<{ id: string; note: string }>('setSampleNote', async (message) => {
    const { id, note } = message.payload
    await setSampleNote(id, note)
    return { success: true as const }
  })

  registerHandler<{ tabId: number; currentTime: number }>('captureSample', async (message) => {
    // 两段式保存：只生成草稿，等用户确认后才落库并学指纹。
    // 直接落库会在误标时立刻污染指纹库，而删样本不会删指纹，无法回滚。
    return await handleCaptureDraft(message.payload.tabId, message.payload.currentTime)
  })

  registerHandler<{ draftId: string }>('loadFullBlock', async (message) => {
    const { draftId } = message.payload
    const d = getDraft(draftId)
    if (!d) return { ok: false as const, error: 'draft-expired' }
    if (d.fullBlock.length === 0) return { ok: false as const, error: 'no-full-block' }
    d.sample = applyFullBlock(d.sample, d.fullBlock)
    return { ok: true as const, segments: resolveSampleBlock(d.sample).map(mapSegment) }
  })

  registerHandler<{ draftId: string; segIndex: number; verdict: 'ad' | 'content' }>(
    'setDraftVerdict',
    async (message) => {
      const { draftId, segIndex, verdict } = message.payload
      const d = getDraft(draftId)
      if (!d) return { ok: false as const, error: 'draft-expired' }
      if (!isValidVerdict(verdict)) return { ok: false as const, error: 'bad-verdict' }
      d.sample = applyVerdict(d.sample, segIndex, verdict)
      return { ok: true as const }
    },
  )

  registerHandler<{ draftId: string; verdicts?: Record<number, 'ad' | 'content'> }>(
    'commitSample',
    async (message) => {
      const { draftId, verdicts } = message.payload
      const d = getDraft(draftId)
      if (!d) return { ok: false as const, error: 'draft-expired' }

      let sample = d.sample
      if (verdicts) {
        for (const [k, v] of Object.entries(verdicts)) {
          const idx = Number(k)
          if (!Number.isInteger(idx) || !isValidVerdict(v)) continue
          sample = applyVerdict(sample, idx, v)
        }
      }

      // 落库前计算复核清单，供撤销误标指纹使用
      const block = resolveSampleBlock(sample)
      const rejected = block.filter((s) => resolveVerdict(s) === 'content')

      await recordSample(sample)
      const learn = await autoLearnFromSample(sample)

      // 明确判为非广告的分片：若此前被误学入指纹库，必须同步撤销，
      // 否则下次播放会把正常内容当广告跳掉
      let revoked = 0
      for (const s of rejected) {
        if (await revokeFingerprint(s.url)) revoked++
      }

      drafts.delete(draftId)
      logger.info(
        '[hls] sample committed · auto-learn block:',
        learn.total,
        '· new fingerprints:',
        learn.added,
        '· revoked:',
        revoked,
      )
      return { ok: true as const, learned: learn.added, total: learn.total, revoked }
    },
  )

  registerHandler<{ draftId: string }>('cancelSampleDraft', async (message) => {
    drafts.delete(message.payload.draftId)
    return { ok: true as const }
  })

  // === 阶段 3: 统计 ===
  registerHandler('getHlsStats', async () => {
    return await getStats()
  })

  registerHandler('clearHlsStats', async () => {
    await clearStats()
    return { success: true as const }
  })

  // === 导入导出 ===
  registerHandler('exportHlsBackup', async () => {
    return await buildExport()
  })

  registerHandler<{ data: BackupPayload; strategy: 'merge' | 'replace' }>('importHlsBackup', async (message) => {
    const { data, strategy } = message.payload
    const result = await applyImport(data, strategy)
    return result
  })

  // === 指纹库配置 ===
  registerHandler('getHlsFingerprintConfig', async () => {
    const cfg = (await persistentStorage.get<{
      enableFingerprint?: boolean
      fingerprintMode?: string
      autoLearnFingerprints?: boolean
      remoteFingerprintsUrl?: string
    }>('hlsFilterConfig')) ?? {}
    return {
      enableFingerprint: cfg.enableFingerprint ?? false,
      fingerprintMode: cfg.fingerprintMode ?? 'suspicious-only',
      autoLearnFingerprints: cfg.autoLearnFingerprints ?? true,
      remoteFingerprintsUrl: cfg.remoteFingerprintsUrl ?? '',
      learnedCount: getLearnedCount(),
    }
  })

  registerHandler<Record<string, unknown>>('setHlsFingerprintConfig', async (message) => {
    const cfg = message.payload
    const existing = (await persistentStorage.get<Record<string, unknown>>('hlsFilterConfig')) ?? {}
    await persistentStorage.set('hlsFilterConfig', { ...existing, ...cfg })
    logger.info('[hls] fingerprint config saved:', cfg.enableFingerprint, cfg.fingerprintMode)
    return { success: true as const }
  })

  registerHandler('clearHlsFingerprints', async () => {
    await clearLearned()
    logger.info('[hls] learned fingerprints cleared')
    return { success: true as const }
  })

  // === 全部配置 ===
  registerHandler('getHlsFullConfig', async () => {
    const cfg = (await persistentStorage.get<Record<string, unknown>>('hlsFilterConfig')) ?? {}
    const stored = await settingsStore.get<Partial<Settings>>()
    return {
      enableHlsAdFilter: stored?.enableHlsAdFilter ?? DEFAULT_SETTINGS.enableHlsAdFilter,
      enableAdSkip: (cfg.enableAdSkip as boolean) ?? true,
      showPageBadge: (cfg.showPageBadge as boolean) ?? true,
      keepDiscontinuityOnGap: (cfg.keepDiscontinuityOnGap as boolean) ?? true,
      logToConsole: (cfg.logToConsole as boolean) ?? false,
      scoreThreshold: (cfg.scoreThreshold as number) ?? 3,
      mode: (cfg.mode as import('@/engine/hls/types').AdDeliveryMode) ?? 'm3u8-file',
      urlPatterns: (cfg.urlPatterns as string[]) ?? [],
      remoteRulesUrl: (cfg.remoteRulesUrl as string) ?? '',
    }
  })

  registerHandler<{ enabled: boolean }>('setHlsAdFilterEnabled', async (message) => {
    const stored = await settingsStore.get<Partial<Settings>>()
    await settingsStore.set({ ...stored, enableHlsAdFilter: message.payload.enabled })
    logger.info('[hls] ad filter enabled:', message.payload.enabled)
    return { success: true as const }
  })

  registerHandler<Record<string, unknown>>('setHlsFullConfig', async (message) => {
    const cfg = message.payload
    const existing = (await persistentStorage.get<Record<string, unknown>>('hlsFilterConfig')) ?? {}
    await persistentStorage.set('hlsFilterConfig', { ...existing, ...cfg })
    logger.info('[hls] full config saved')
    return { success: true as const }
  })

  registerHandler<{ url: string }>('refreshHlsRemoteRules', async (message) => {
    const { url } = message.payload
    const result = await refreshRemoteRules(url)
    logger.info('[hls] remote rules refreshed:', result.rules, 'rules')
    return result
  })

  // === 规则库查询 ===
  registerHandler('listHlsRules', async () => {
    const rules = await listAllRules()
    return { rules }
  })

  // === m3u8 实测 ===
  registerHandler<{ url: string; host?: string }>('testM3u8', async (message) => {
    const { url, host } = message.payload
    logger.info('[hls] testM3u8 called, url:', url.slice(0, 80))

    // 1. fetch m3u8 内容（带重试）
    let text = ''
    try {
      const MAX_RETRIES = 3
      const RETRY_BASE_MS = 500
      let lastErr: Error | null = null
      let fetchOk = false
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const resp = await fetch(url, { cache: 'no-store' })
          if (resp.ok) {
            text = await resp.text()
            fetchOk = true
            break
          }
          lastErr = new Error(`HTTP ${resp.status}`)
        } catch (e) {
          lastErr = e as Error
        }
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_BASE_MS * Math.pow(2, attempt - 1)))
        }
      }
      if (!fetchOk) throw lastErr ?? new Error('fetch failed')
    } catch (e) {
      logger.error('[hls] testM3u8 fetch failed:', (e as Error).message)
      return { error: (e as Error).message }
    }

    // 2. 构建配置
    const pageHost = host || (() => {
      try { return new URL(url).host } catch { return '' }
    })()

    const fpCfg = (await persistentStorage.get<Record<string, unknown>>('hlsFilterConfig')) ?? {}
    const stored = await settingsStore.get<typeof DEFAULT_SETTINGS>()
    const settings = { ...DEFAULT_SETTINGS, ...stored }

    const cfg = await buildConfig(
      {
        ...DEFAULT_CONFIG,
        enabled: true,
        logToConsole: settings.enableLogging,
        enableFingerprint: (fpCfg.enableFingerprint as boolean) ?? false,
        fingerprintMode: ((fpCfg.fingerprintMode as string) ?? 'suspicious-only') as 'off' | 'suspicious-only' | 'all',
        autoLearnFingerprints: false, // 测试模式不自动学习
        remoteFingerprintsUrl: (fpCfg.remoteFingerprintsUrl as string) ?? '',
      },
      pageHost,
    )

    // 3. 调用 processPlaylist
    const result = await processPlaylist(text, url, url, cfg)

    // 4. 序列化返回（兼容前端 TestResult 接口）
    const ret: Record<string, unknown> = {
      mode: result.mode,
      matchedRule: cfg._appliedRule ? cfg._appliedRule.id : null,
    }

    if (result.report && typeof result.report === 'object') {
      const rpt = result.report as Record<string, unknown>
      ret.totalSegments = rpt.total ?? 0
      ret.adSegments = rpt.ads ?? 0
      ret.adDuration = rpt.adDuration ?? 0
      ret.contentDuration = rpt.contentDuration ?? 0
    } else {
      ret.totalSegments = 0
      ret.adSegments = 0
      ret.adDuration = 0
      ret.contentDuration = 0
    }

    // reasons 序列化
    if ('reasons' in result && result.reasons) {
      const reasons = result.reasons as Record<number, string[]>
      ret.reasons = Object.entries(reasons).map(([index, reasonList]) => ({
        index: Number(index),
        isAd: true,
        reason: reasonList.join('; '),
      }))
    } else {
      ret.reasons = []
    }

    // cleaned m3u8
    if ('cleaned' in result && typeof result.cleaned === 'string') {
      ret.cleanedM3u8 = result.cleaned
    } else {
      ret.cleanedM3u8 = ''
    }

    return ret
  })

  // popup 查询当前 tab 最近检测信息
  // playback：当前页面是否物理剔除了广告分片（true=播放器时间轴已不含广告，无需 seek）
  registerHandler<{ tabId: number }>('getLastDetect', async (message) => {
    const { tabId } = message.payload
    const ctx = await loadCleanedContext(tabId)
    if (!ctx) return null
    const playback = ctx.playback === 'cleaned' ? 'cleaned' : 'original'
    return { report: ctx.report, baseUrl: ctx.baseUrl, playback }
  })

  // === 阶段 3: m3u8 下载（ts→绝对地址已由 rebuildPlaylist 处理）===
  registerHandler<{ tabId: number; fileName?: string }>('downloadCleanedM3u8', async (message, sender) => {
    const { tabId, fileName: payloadFileName } = message.payload
    const ctx = await loadCleanedContext(tabId)
    if (!ctx || !ctx.cleaned) {
      return { ok: false as const, error: '无待下载的 cleaned m3u8（先触发视频检测）' }
    }

    try {
      const cfg = await getDownloadConfig()

      // 收集验证信息：主页面 URL + cookies + requestHeaders（含 User-Agent）
      let rootTabUrl = ''
      let rootTabTitle = ''
      try {
        const rootTab = await chrome.tabs.get(tabId)
        rootTabUrl = rootTab?.url || ''
        rootTabTitle = rootTab?.title || ''
      } catch { /* ignore */ }
      const pageUrl = rootTabUrl || sender.tab?.url || ''
      const iframeUrl = sender.tab?.url || ''
      let cookies = ''
      try {
        const cookieList = await chrome.cookies.getAll({ url: ctx.baseUrl })
        if (cookieList.length > 0) {
          cookies = cookieList.map((c) => `${c.name}=${c.value}`).join('; ')
        }
      } catch { /* ignore */ }
      let requestHeaders: Record<string, string> | undefined
      try {
        const items = getMediaItems(tabId)
        const m3u8Item = items.find((i) => i.ext === 'm3u8' || i.ext === 'm3u')
        if (m3u8Item?.requestHeaders && Object.keys(m3u8Item.requestHeaders).length > 0) {
          requestHeaders = m3u8Item.requestHeaders
        }
      } catch { /* ignore */ }
      const downloadExtra = { pageUrl, cookies, requestHeaders }

      const sanitize = (n: string): string =>
        n.replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/_{2,}/g, '_').trim().slice(0, 200)

      const candidates: string[] = []
      let debug = ''
      debug += `[resolveName] payloadFileName=${JSON.stringify(payloadFileName)}, pageUrl=${pageUrl}, tabId=${tabId}\n`
      debug += `  rootTabUrl=${JSON.stringify(rootTabUrl)}\n  iframeUrl=${JSON.stringify(iframeUrl)}\n  rootTabTitle=${JSON.stringify(rootTabTitle)}\n`

      // ① Content Script 传来的文件名
      if (payloadFileName && !isBadName(payloadFileName)) {
        candidates.push(payloadFileName)
        debug += `  ① payloadFileName OK: ${payloadFileName}\n`
      } else {
        debug += `  ① payloadFileName SKIP (bad/empty): ${JSON.stringify(payloadFileName)}\n`
      }

      // ② 主页面 title（优先 chrome.tabs.get，其次 ctx.pageTitle from sniffer 持久化）
      const titleSource = rootTabTitle || ctx.pageTitle || ''
      if (titleSource) {
        let t = titleSource.trim()
        t = t
          .replace(/[-_]\s*哔哩哔哩_bilibili$/i, '')
          .replace(/[-_]\s*bilibili$/i, '')
          .replace(/[-_]\s*哔哩哔哩$/i, '')
          .replace(/\s*[-–—]\s*YouTube$/i, '')
          .replace(/\s*[-–—]\s*爱奇艺$/i, '')
          .replace(/\s*[-_]\s*腾讯视频.*$/i, '')
          .replace(/\s*[-_]\s*优酷.*$/i, '')
          .replace(/\s*[-_]\s*西瓜视频.*$/i, '')
          .replace(/\s*[-_]\s*抖音.*$/i, '')
        t = sanitize(t)
        if (!isBadName(t)) {
          candidates.push(t)
          debug += `  ② titleSource OK: ${t}\n`
        } else {
          debug += `  ② titleSource BAD: ${t}\n`
        }
      } else {
        debug += `  ② titleSource empty (rootTabTitle=${JSON.stringify(rootTabTitle)}, ctx.pageTitle=${JSON.stringify(ctx.pageTitle)})\n`
      }

      // ③ fetch 主页面 HTML 提取 og:title / <title>
      try {
        let fetchUrl = ''
        if (requestHeaders?.Referer) fetchUrl = requestHeaders.Referer
        if (!fetchUrl && rootTabUrl) fetchUrl = rootTabUrl
        if (!fetchUrl && iframeUrl) fetchUrl = iframeUrl
        if (fetchUrl) {
          debug += `  ③ trying fetch OG from: ${fetchUrl}\n`
          const fetchHeaders: Record<string, string> = {}
          if (requestHeaders?.['User-Agent']) fetchHeaders['User-Agent'] = requestHeaders['User-Agent']
          if (requestHeaders?.['Cookie']) fetchHeaders['Cookie'] = requestHeaders['Cookie']
          if (requestHeaders?.['Origin']) fetchHeaders['Origin'] = requestHeaders['Origin']
          if (requestHeaders?.['Referer']) fetchHeaders['Referer'] = requestHeaders['Referer']
          const resp = await fetch(fetchUrl, fetchHeaders ? { headers: fetchHeaders, cache: 'no-store' } : { cache: 'no-store' })
          if (resp.ok) {
            const html = await resp.text()
            const ogMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)
            const ogTitle = ogMatch ? ogMatch[1]?.trim() : ''
            if (ogTitle) {
              const cleanOg = sanitize(ogTitle)
              if (!isBadName(cleanOg)) {
                candidates.push(cleanOg)
                debug += `  ③ OG meta OK: ${cleanOg}\n`
              } else {
                debug += `  ③ OG meta BAD: ${cleanOg}\n`
              }
            } else {
              const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
              const htmlTitle = titleMatch ? titleMatch[1]?.trim() : ''
              if (htmlTitle) {
                let t = htmlTitle
                  .replace(/[-_]\s*哔哩哔哩_bilibili$/i, '')
                  .replace(/\s*[-–—]\s*YouTube$/i, '')
                  .replace(/\s*[-–—]\s*爱奇艺$/i, '')
                  .replace(/\s*[-_]\s*腾讯视频.*$/i, '')
                t = sanitize(t)
                if (!isBadName(t)) {
                  candidates.push(t)
                  debug += `  ③ <title> tag OK: ${t}\n`
                } else {
                  debug += `  ③ <title> tag BAD: ${t}\n`
                }
              }
            }
          } else {
            debug += `  ③ fetch failed: ${resp.status}\n`
          }
        }
      } catch (e) {
        debug += `  ③ fetch OG error: ${(e as Error).message}\n`
      }

      // ④ URL path 多段提取（剔除技术段）— 复用 lib/naming.ts 的 extractBaseName
      let friendlyName = candidates[0] ?? ''
      if (!friendlyName && pageUrl) {
        friendlyName = extractBaseName(pageUrl)
      }
      if (!friendlyName) friendlyName = ctx.baseName
      debug += `  ⑤ baseName fallback: ${friendlyName}\n`
      friendlyName = sanitize(friendlyName)
      if (friendlyName.length > 50) friendlyName = friendlyName.slice(-50)
      debug += `  → FINAL friendlyName: ${friendlyName}\n`
      logger.info('[resolveName]', debug)

      const m3u8OutName = `${friendlyName}_cleaned.m3u8`
      const outputName = `${friendlyName}_noads.mp4`

      // === PushClient 优先：已连接的 WebSocket 客户端直接推送，无需 data URL 编码 ===
      // 对齐 sendToDownloadClient 的 pushClientInstance 优先逻辑
      const pushClient = getPushClient()
      if (pushClient) {
        try {
          const headers = buildVeloHeaders(downloadExtra)
          const pushMsg = {
            action: 'push_m3u8' as const,
            url: ctx.baseUrl,
            m3u8_text: ctx.cleaned,
            base_url: ctx.baseUrl,
            headers,
            options: {
              filename: outputName,
              output_dir: undefined as string | undefined,
              merge_format: 'mp4',
              extra_headers: undefined as Record<string, string> | undefined,
            },
            page_url: downloadExtra.pageUrl || undefined,
            page_title: (rootTabTitle || ctx.pageTitle) || undefined,
          }
          const pushed = await pushClient.push(pushMsg)
          if (pushed.queued) {
            logger.info('[hls] cleaned m3u8 queued (velo offline)')
            return { ok: true as const, filename: outputName, queued: true }
          }
          if (pushed.pending) {
            logger.info('[hls] cleaned m3u8 awaiting user confirm in velo')
            return { ok: true as const, filename: outputName, pending: true }
          }
          logger.info('[hls] pushed cleaned m3u8 via PushClient')
          return { ok: true as const, filename: outputName }
        } catch (e) {
          if (e instanceof PushUnconfirmedError) {
            logger.warn('[hls] push_m3u8 unconfirmed:', e.message)
            return { ok: false as const, unconfirmed: true, error: i18n('push_unconfirmed') }
          }
          // 桌面端明确拒绝：客户端已是 velo 时不再回退（回退等于向同一端重推）
          if (cfg.client === 'velo') {
            logger.warn('[hls] push_m3u8 rejected:', (e as Error).message)
            return { ok: false as const, error: (e as Error).message }
          }
          logger.warn('[hls] PushClient push_m3u8 failed, falling back to cfg.client:', (e as Error).message)
        }
      }

      // 编码为 data URL 下载（不用 unescape，SW 环境可能无 unescape）
      const bytes = new TextEncoder().encode(ctx.cleaned)
      let bin = ''
      for (const b of bytes) bin += String.fromCharCode(b)
      const b64 = btoa(bin)
      const m3u8DataUrl = `data:application/vnd.apple.mpegurl;base64,${b64}`

      if (cfg.client === 'aria2') {
        // aria2 模式：data URL → 落地为本地 file:// m3u8 → aria2.addUri(file://) 让 Motrix 下载+合并 .ts
        // 复用 download-client.ts 的 materializeDataUrl（处理 chrome.downloads + onChanged 监听）
        const materialized = await materializeDataUrl(m3u8DataUrl, m3u8OutName)
        if (!materialized.ok) {
          return { ok: false as const, error: materialized.error }
        }
        const r = await sendToAria2(materialized.fileUrl, `${friendlyName}_noads.ts`, cfg, downloadExtra, /* skipVeloRedirect */ true)
        return { ok: r.success, filename: r.success ? `${friendlyName}_noads.ts` : undefined, ...(r.message ? { error: r.message } : {}) }
      }

      // NDM 模式：发 data URL 给 NDM WebSocket
      if (cfg.client === 'ndm') {
        const r = await sendToNdm(m3u8DataUrl, outputName, cfg, downloadExtra)
        return { ok: r.success as boolean, filename: outputName, ...(r.message ? { error: r.message } : {}) }
      }

      // velo 模式：直接推送 cleaned m3u8 文本（push_m3u8），无需 data URL 编码
      if (cfg.client === 'velo') {
        const r = await sendToVeloM3u8(ctx.cleaned, ctx.baseUrl, outputName, cfg, downloadExtra)
        return {
          ok: r.success as boolean,
          filename: outputName,
          ...(r.queued ? { queued: true } : {}),
          ...(r.pending ? { pending: true } : {}),
          ...(r.unconfirmed ? { unconfirmed: true } : {}),
          ...(r.message ? { error: r.message } : {}),
        }
      }

      // native 模式：浏览器原生下载（仅在无 PushClient 且 cfg.client=native 时到达）
      const r = await sendToNative(m3u8DataUrl, m3u8OutName)
      return { ok: r.success as boolean, filename: m3u8OutName, ...(r.message ? { error: r.message } : {}) }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })

  registerHandler('hlsGetRunMode', async () => {
    const stored = await settingsStore.get<Partial<Settings>>()
    const settings: Settings = { ...DEFAULT_SETTINGS, ...stored }
    return {
      runMode: settings.hlsRunMode,
      learnedSites: settings.hlsLearnedSites,
      enabledSites: settings.hlsEnabledSites,
      disabledSites: settings.hlsDisabledSites,
      seedCount: HLS_SITE_SEEDS.length,
    }
  })

  registerHandler<{ runMode: 'smart' | 'manual' }>('hlsSetRunMode', async ({ payload }) => {
    await settingsStore.set<Partial<Settings>>({ hlsRunMode: payload.runMode })
    return { ok: true }
  })

  registerHandler<{ site: string; list: 'enabled' | 'disabled' | 'learned' }>('hlsAddSite', async ({ payload }) => {
    const stored = await settingsStore.get<Partial<Settings>>()
    const settings: Settings = { ...DEFAULT_SETTINGS, ...stored }
    const targetList =
      payload.list === 'enabled' ? settings.hlsEnabledSites
      : payload.list === 'disabled' ? settings.hlsDisabledSites
      : settings.hlsLearnedSites
    const updated = addSite(targetList, payload.site)
    const patch: Partial<Settings> = {}
    if (payload.list === 'enabled') patch.hlsEnabledSites = updated
    else if (payload.list === 'disabled') patch.hlsDisabledSites = updated
    else patch.hlsLearnedSites = updated
    await settingsStore.set(patch)
    return { ok: true, sites: updated }
  })

  registerHandler<{ site: string; list: 'enabled' | 'disabled' | 'learned' }>('hlsRemoveSite', async ({ payload }) => {
    const stored = await settingsStore.get<Partial<Settings>>()
    const settings: Settings = { ...DEFAULT_SETTINGS, ...stored }
    const targetList =
      payload.list === 'enabled' ? settings.hlsEnabledSites
      : payload.list === 'disabled' ? settings.hlsDisabledSites
      : settings.hlsLearnedSites
    const updated = removeSite(targetList, payload.site)
    const patch: Partial<Settings> = {}
    if (payload.list === 'enabled') patch.hlsEnabledSites = updated
    else if (payload.list === 'disabled') patch.hlsDisabledSites = updated
    else patch.hlsLearnedSites = updated
    await settingsStore.set(patch)
    return { ok: true, sites: updated }
  })

  registerHandler<{ runMode: 'smart' | 'manual' }>('hlsSupplementSeeds', async ({ payload }) => {
    const result = await supplementSeedSites(payload.runMode)
    return { ok: true, added: result.added }
  })

  registerHandler<{ pageUrl?: string }>('hlsGetSiteStatus', async (message, sender) => {
    const pageUrl = message.payload?.pageUrl || sender.tab?.url || ''
    const d = await resolveHlsDelegation(pageUrl)
    const stats = await getStats()
    const siteAds = d.domain ? (stats.byHost[d.domain]?.ads ?? 0) : 0
    return {
      runMode: d.runMode,
      domain: d.domain,
      isActive: d.active,
      isDisabled: d.siteBlocked,
      extensionEnabled: d.extensionEnabled,
      filterEnabled: d.filterEnabled,
      siteEnabled: d.siteEnabled,
      reason: d.reason,
      siteAds,
    }
  })

  registerHandler<{ pageUrl?: string }>('hlsTempEnableCurrentSite', async (message, sender) => {
    const stored = await settingsStore.get<Partial<Settings>>()
    const settings: Settings = { ...DEFAULT_SETTINGS, ...stored }
    const pageUrl = message.payload?.pageUrl || sender.tab?.url || ''
    const domain = extractDomain(pageUrl)
    if (!domain) return { ok: false, error: 'no-page-domain' }
    if (isInList(settings.hlsDisabledSites, domain)) {
      return { ok: false, error: 'site-blocked' }
    }

    const patch: Partial<Settings> = {}
    if (settings.hlsRunMode === 'smart') {
      patch.hlsLearnedSites = addSite(settings.hlsLearnedSites, domain)
    } else {
      patch.hlsEnabledSites = addSite(settings.hlsEnabledSites, domain)
    }
    await settingsStore.set(patch)
    return { ok: true, domain, runMode: settings.hlsRunMode }
  })
}

/** 持久化 cleaned m3u8 上下文（per-tab） */
export async function persistCleanedContext(tabId: number, ctx: CleanedContext): Promise<void> {
  try {
    const all = (await persistentStorage.get<Record<string, CleanedContext>>(CLEANED_KEY)) ?? {}
    all[String(tabId)] = ctx
    await persistentStorage.set(CLEANED_KEY, all)
  } catch (e) {
    logger.warn('[hls] persistCleanedContext failed:', (e as Error).message)
  }
}

/** 加载 cleaned m3u8 上下文 */
export async function loadCleanedContext(tabId: number): Promise<CleanedContext | null> {
  try {
    const all = (await persistentStorage.get<Record<string, CleanedContext>>(CLEANED_KEY)) ?? {}
    return all[String(tabId)] ?? null
  } catch {
    return null
  }
}