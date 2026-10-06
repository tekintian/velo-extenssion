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
 *     - mode='enumerate'       返回内容分片列表，content script 可逐个下载
 *     - mode='m3u8-file'        返回 cleaned m3u8 文本，content script 可下载
 *     - mode='data-url'        返回 data: URL，content script 可直接播放
 */

import { registerHandler } from '@/background/messaging/router'
import { logger } from '@/lib/logger'
import { persistentStorage, settingsStore } from '@/lib/storage'
import type { BackupPayload } from '@/engine/hls/io'
import { DEFAULT_SETTINGS } from '@/types'
import { buildConfig, DEFAULT_CONFIG, processPlaylist } from '@/engine/hls/hls-filter'
import { consider, listPending, approve, dismiss } from '@/engine/hls/suggest'
import { recordStats, getStats, clearStats } from '@/engine/hls/stats'
import { captureSample, recordSample, autoLearnFromSample, listSamples, removeSample, clearSamples, setSampleNote } from '@/engine/hls/samples'
import { buildExport, applyImport } from '@/engine/hls/io'
import { getLearnedCount, clearLearned } from '@/engine/hls/fingerprint'
import { refreshRemoteRules } from '@/engine/hls/hls-rules'
import { getDownloadConfig, sendToAria2, sendToNative, sendToNdm, sendToSdownM3u8 } from '@/background/media/download-client'
import { getMediaItems } from '@/background/media/sniffer'

/** per-tab 最近清洗后的 m3u8 上下文（供下载按钮用） */
export interface CleanedContext {
  readonly cleaned: string
  readonly baseName: string
  readonly report: { ads: number; total: number; adDuration: number; contentDuration: number; appliedRule?: { id: string; name: string } | null }
  readonly segments: ReadonlyArray<{ index: number; url: string; duration: number; discontinuity: boolean; seqNum: number | null; title: string; byterange: string | null; cueState: 'out' | null; scte35: string | null; dateRangeAd: string | null }>
  readonly reasons: Record<number, string[]>
  readonly pageHost: string
  readonly baseUrl: string
  readonly detectedAt: number
}

const CLEANED_KEY = 'hlsLastCleaned'

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
      const result = await processPlaylist(text, baseUrl, pageUrl, cfg, hlsAuthHeaders)

      // 5. 广播报告给当前 tab 的 badge content script（阶段 3a）
      if (result.report && _sender.tab?.id) {
        try {
          await chrome.tabs.sendMessage(_sender.tab.id, {
            type: 'hlsFilterReport',
            report: result.report,
          })
        } catch {
          // badge 未注入 — 忽略
        }
      }

      // 6. 阶段 3b: 规则自动建议（从命中 reasons 提取 url-pattern 候选）
      if ('reasons' in result && result.reasons && Object.keys(result.reasons).length > 0) {
        try {
          const considerPageHost = (() => {
            try {
              return pageUrl ? new URL(pageUrl).host : ''
            } catch {
              return ''
            }
          })()
          await consider(result.reasons, considerPageHost, cfg._appliedRule?.id)
        } catch (e) {
          logger.warn('[hls] suggest failed:', (e as Error).message)
        }
      }

      // 7. 阶段 3: 统计记录 + 持久化 cleaned m3u8（供下载按钮用）
      if (result.report && 'cleaned' in result && typeof result.cleaned === 'string') {
        // 统计
        try {
          await recordStats(result.report as { ads: number; adDuration: number; contentDuration: number; appliedRule?: { id: string } | null }, pageHost)
        } catch (e) {
          logger.warn('[hls] recordStats failed:', (e as Error).message)
        }

        // 持久化 cleaned m3u8 + 广播 hlsFilterResult 给 player-panel
        if (_sender.tab?.id) {
          const baseName = extractBaseName(baseUrl)
          const ctx: CleanedContext = {
            cleaned: result.cleaned,
            baseName,
            report: result.report as CleanedContext['report'],
            segments: ('segments' in result ? result.segments : []) as CleanedContext['segments'],
            reasons: ('reasons' in result ? result.reasons : {}) as Record<number, string[]>,
            pageHost,
            baseUrl,
            detectedAt: Date.now(),
          }
          await persistCleanedContext(_sender.tab.id, ctx)

          // 广播 hlsFilterResult 给 player-panel（显示 "TS File (ad-filtered)" 下载行）
          const adRanges = 'adRanges' in result ? result.adRanges : []
          try {
            await chrome.tabs.sendMessage(_sender.tab.id, {
              type: 'hlsFilterResult',
              adRanges,
              baseName,
              report: result.report,
            })
            logger.info('[hls] hlsFilterResult broadcasted to player-panel, baseName:', baseName)
          } catch {
            // player-panel 未注入 — 忽略
          }
        }
      }

      // 8. 返回（序列化 Set/Map → array/object 便于跨消息传递）
      const ret: Record<string, unknown> = { mode: result.mode }
      if ('url' in result) ret.url = result.url
      if ('cleaned' in result) ret.cleaned = result.cleaned
      ret.report = result.report
      if ('segments' in result) ret.segments = result.segments
      if ('adRanges' in result) ret.adRanges = result.adRanges
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

  registerHandler<{ id: string }>('removeSample', async (message) => {
    const { id } = message.payload
    await removeSample(id)
    return { success: true as const }
  })

  registerHandler('clearSamples', async () => {
    await clearSamples()
    return { success: true as const }
  })

  registerHandler<{ id: string; note: string }>('setSampleNote', async (message) => {
    const { id, note } = message.payload
    await setSampleNote(id, note)
    return { success: true as const }
  })

  registerHandler<{ tabId: number; currentTime: number }>('captureSample', async (message) => {
    const { tabId, currentTime } = message.payload
    const ctx = await loadCleanedContext(tabId)
    if (!ctx || !ctx.segments || ctx.segments.length === 0) {
      throw new Error('该标签页无最近 m3u8 上下文（先在页面触发一次视频检测/下载，或刷新页面后重试）')
    }
    try {
      const sample = captureSample(ctx.segments, currentTime, ctx.pageHost, ctx.baseUrl, ctx.report, ctx.reasons)
      if (!sample) throw new Error('捕获失败（currentTime 超出分片范围）')
      await recordSample(sample)
      const learned = await autoLearnFromSample(sample)
      logger.info('[hls] sample captured + auto-learned', learned, 'fingerprints')
      return { success: true as const }
    } catch (e) {
      throw new Error((e as Error).message)
    }
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
    return {
      enableAdSkip: (cfg.enableAdSkip as boolean) ?? true,
      showPageBadge: (cfg.showPageBadge as boolean) ?? true,
      keepDiscontinuityOnGap: (cfg.keepDiscontinuityOnGap as boolean) ?? true,
      logToConsole: (cfg.logToConsole as boolean) ?? false,
      scoreThreshold: (cfg.scoreThreshold as number) ?? 3,
      mode: (cfg.mode as string) ?? 'm3u8-file',
      urlPatterns: (cfg.urlPatterns as string[]) ?? [],
      remoteRulesUrl: (cfg.remoteRulesUrl as string) ?? '',
    }
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

  // popup 查询当前 tab 最近检测信息
  registerHandler<{ tabId: number }>('getLastDetect', async (message) => {
    const { tabId } = message.payload
    const ctx = await loadCleanedContext(tabId)
    if (!ctx) return null
    return { report: ctx.report, baseUrl: ctx.baseUrl }
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
      const m3u8FileName = `${ctx.baseName}_cleaned.m3u8`

      // 收集验证信息：pageUrl + cookies + requestHeaders（含 User-Agent）
      const pageUrl = sender.tab?.url || ''
      let cookies = ''
      try {
        const cookieList = await chrome.cookies.getAll({ url: ctx.baseUrl })
        if (cookieList.length > 0) {
          cookies = cookieList.map((c) => `${c.name}=${c.value}`).join('; ')
        }
      } catch { /* ignore */ }
      // 从当前 tab 的嗅探媒体项中提取 requestHeaders（含 User-Agent 等认证头）
      let requestHeaders: Record<string, string> | undefined
      try {
        const items = getMediaItems(tabId)
        const m3u8Item = items.find((i) => i.ext === 'm3u8' || i.ext === 'm3u')
        if (m3u8Item?.requestHeaders && Object.keys(m3u8Item.requestHeaders).length > 0) {
          requestHeaders = m3u8Item.requestHeaders
        }
      } catch { /* ignore */ }
      const downloadExtra = { pageUrl, cookies, requestHeaders }

      const friendlyName = payloadFileName || ctx.baseName

      // 编码为 data URL 下载（不用 unescape，SW 环境可能无 unescape）
      const bytes = new TextEncoder().encode(ctx.cleaned)
      let bin = ''
      for (const b of bytes) bin += String.fromCharCode(b)
      const b64 = btoa(bin)
      const m3u8DataUrl = `data:application/vnd.apple.mpegurl;base64,${b64}`

      if (cfg.client === 'aria2') {
        // aria2 模式：先存为本地文件，再用 aria2.addUri(file://) 让 Motrix 下载+合并 .ts
        return new Promise((resolve) => {
          chrome.downloads.download(
            { url: m3u8DataUrl, filename: m3u8FileName, saveAs: false },
            (did) => {
              if (chrome.runtime.lastError || !did) {
                resolve({ ok: false as const, error: '保存 m3u8 文件失败' })
                return
              }
              const listener = (delta: chrome.downloads.DownloadDelta) => {
                if (delta.id !== did) return
                if (delta.state && delta.state.current === 'complete') {
                  chrome.downloads.search({ id: did }, async (items) => {
                    chrome.downloads.onChanged.removeListener(listener)
                    const fp = items[0]?.filename?.replace(/\\/g, '/')
                    if (!fp) {
                      resolve({ ok: false as const, error: '无法获取下载文件路径' })
                      return
                    }
                    const fileUrl = `file://${fp.startsWith('/') ? '' : '/'}${fp}`
                    await sendToAria2(fileUrl, `${friendlyName}_noads.ts`, cfg, downloadExtra)
                    resolve({ ok: true as const, filename: `${friendlyName}_noads.ts` })
                  })
                }
              }
              chrome.downloads.onChanged.addListener(listener)
            },
          )
        }) as Promise<{ ok: boolean; filename?: string; error?: string }>
      }

      // NDM 模式：发 data URL 给 NDM WebSocket
      if (cfg.client === 'ndm') {
        const outputName = `${friendlyName}_noads.mp4`
        const r = await sendToNdm(m3u8DataUrl, outputName, downloadExtra)
        return { ok: r.success as boolean, filename: outputName, ...(r.message ? { error: r.message } : {}) }
      }

      // sdown 模式：直接推送 cleaned m3u8 文本（push_m3u8），无需 data URL 编码
      if (cfg.client === 'sdown') {
        const outputName = `${friendlyName}_noads.mp4`
        const r = await sendToSdownM3u8(ctx.cleaned, ctx.baseUrl, outputName, cfg, downloadExtra)
        return { ok: r.success as boolean, filename: outputName, ...(r.message ? { error: r.message } : {}) }
      }

      // native 模式：浏览器原生下载
      const r = await sendToNative(m3u8DataUrl, m3u8FileName)
      return { ok: r.success as boolean, filename: m3u8FileName, ...(r.message ? { error: r.message } : {}) }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  })
}

/** 从 m3u8 URL 提取 baseName（用于命名下载文件） */
export function extractBaseName(m3u8Url: string): string {
  try {
    const path = new URL(m3u8Url).pathname
    const lastSlash = path.lastIndexOf('/')
    const file = lastSlash >= 0 ? path.slice(lastSlash + 1) : path
    const dot = file.lastIndexOf('.')
    const name = dot > 0 ? file.slice(0, dot) : file
    return name || 'video'
  } catch {
    return 'video'
  }
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
async function loadCleanedContext(tabId: number): Promise<CleanedContext | null> {
  try {
    const all = (await persistentStorage.get<Record<string, CleanedContext>>(CLEANED_KEY)) ?? {}
    return all[String(tabId)] ?? null
  } catch {
    return null
  }
}
