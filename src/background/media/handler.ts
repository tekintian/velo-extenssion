/**
 * 媒体嗅探 + 下载 handler
 *
 * 处理消息:
 *   - getMediaItems(tabId)        返回该 tab 嗅探到的媒体列表
 *   - clearMediaItems(tabId)      清空
 *   - sendToDownload(url, name?)  发送给下载客户端
 *   - getDownloadConfig           读取配置
 *   - setDownloadConfig           保存配置
 */

import { registerHandler } from '@/background/messaging/router'
import { logger } from '@/lib/logger'
import { clearMediaItems, getMediaItems, startSniffer, stopSniffer, isSnifferRunning, addMediaItemExternal, pairDashItems } from './sniffer'
import { getDownloadConfig, sendToDownloadClient, setDownloadConfig, sendToVeloDash, getPushClient, buildVeloHeaders } from './download-client'
import type { DownloadClientConfig } from './types'
import {
  sniffFacebookEmbed,
  parseYouTubeScriptFormats,
  parseVimeoScriptProgressive,
} from './site-sniffers'
import { setDeleteKeyDown } from './delete-key-state'

/** 启动媒体嗅探（webRequest 监听），由 background.ts initBackground 调用 */
export function startMediaSniffer(): void {
  startSniffer()
}

/** 停止媒体嗅探（移除 webRequest 监听），委派关闭时调用 */
export function stopMediaSniffer(): void {
  stopSniffer()
}

/** 查询嗅探器是否运行中 */
export function isMediaSnifferRunning(): boolean {
  return isSnifferRunning()
}

export function registerMediaHandlers(): void {
  // content script 没有 chrome.tabs.query 权限，通过 background 获取当前 tabId
  registerHandler('getCurrentTabId', async (_message, sender) => {
    return { tabId: sender.tab?.id ?? 0 }
  })

  // === Delete 键状态接收（NDM ct.js 行 1-2 → velo delete-key.content.ts） ===
  // content script 监听 keydown/keyup 的 Delete 键，通过消息告知 background
  // background 在 onBeforeSendHeaders 阶段读取 getDeleteKeyDown() 快照到 pending.isKeyDown
  // onHeadersReceived 阶段读取 pending.isKeyDown 决定是否跳过拦截（让浏览器原生下载）
  registerHandler<{ pressed: boolean }>('deleteKeyStateChanged', async (message) => {
    const { pressed } = message.payload
    setDeleteKeyDown(pressed)
    return { success: true as const }
  })

  registerHandler<{ tabId: number }>('getMediaItems', async (message) => {
    const { tabId } = message.payload
    pairDashItems(tabId)
    return getMediaItems(tabId)
  })

  registerHandler<{ tabId: number }>('clearMediaItems', async (message) => {
    const { tabId } = message.payload
    clearMediaItems(tabId)
    return { success: true as const }
  })

  // 站点特殊抓取（Facebook/Vimeo）content script 主动加媒体项
  registerHandler<{ url: string; label: string; ext: string }>('addMediaItem', async (message, sender) => {
    const { url, label, ext } = message.payload
    const tabId = sender.tab?.id ?? 0
    if (tabId === 0) return { success: true as const }
    addMediaItemExternal(tabId, url, label, ext)
    logger.info('[media] external media item added:', ext, url.slice(0, 80), 'tabId:', tabId)
    return { success: true as const }
  })

  // === NDM ct.js 100% 移植的站点嗅探 handler ===

  // Facebook 视频嵌入抓取（NDM ct.js ga 函数）
  // 由 content script MutationObserver 检测到 /videos/{id}/ 链接时触发
  registerHandler<{ videoId: string }>('sniffFacebookEmbed', async (message, sender) => {
    const { videoId } = message.payload
    const tabId = sender.tab?.id ?? 0
    if (tabId === 0 || !videoId) return { success: false as const }
    await sniffFacebookEmbed(tabId, videoId)
    return { success: true as const }
  })

  // YouTube <script> 标签扫描（NDM ct.js za 函数 YouTube 分支）
  // 由 content script 在 DOMContentLoaded 扫描所有 <script> innerText 时触发
  registerHandler<{ scriptText: string }>('parseYouTubeScriptFormats', async (message, sender) => {
    const { scriptText } = message.payload
    const tabId = sender.tab?.id ?? 0
    if (tabId === 0 || !scriptText) return { success: false as const }
    const parsed = parseYouTubeScriptFormats(tabId, scriptText)
    return { success: true as const, parsed }
  })

  // Vimeo <script> 标签扫描（NDM ct.js za 函数 Vimeo 分支）
  // 由 content script 在 DOMContentLoaded 扫描所有 <script> innerText 时触发
  registerHandler<{ scriptText: string }>('parseVimeoScriptProgressive', async (message, sender) => {
    const { scriptText } = message.payload
    const tabId = sender.tab?.id ?? 0
    if (tabId === 0 || !scriptText) return { success: false as const }
    const parsed = parseVimeoScriptProgressive(tabId, scriptText)
    return { success: true as const, parsed }
  })

  registerHandler<{ url: string; fileName?: string; pageUrl?: string; contentType?: string; contentDisposition?: string; method?: string; requestBody?: string; requestHeaders?: Record<string, string>; ext?: string }>('sendToDownload', async (message, sender) => {
    const { url, fileName, pageUrl, contentType, contentDisposition, method, requestBody, requestHeaders, ext } = message.payload
    logger.info('[media] sendToDownload: url=', url?.slice(0, 80), 'fileName=', fileName, 'method=', method, 'ext=', ext)
    if (!url) {
      return { success: false, message: 'URL 为空' }
    }
    // 获取页面 URL（从 sender 或 payload）
    const finalPageUrl = pageUrl || sender.tab?.url || ''
    // 获取 cookies
    let cookies = ''
    try {
      const cookieList = await chrome.cookies.getAll({ url })
      if (cookieList.length > 0) {
        cookies = cookieList.map((c) => `${c.name}=${c.value}`).join('; ')
      }
    } catch {
      // ignore
    }
    // NDM V.aa case 6: e["6"] = c["6"] || "media";
    //   !c.fEx || "vtt"!=c.fEx.toLowerCase() && "srt"!=c.fEx.toLowerCase() || (e["6"] = "normal");
    // VTT/SRT 字幕 priority 为 "normal"，其余为 "media"
    const isSubtitle = ext && /^(?:vtt|srt)$/i.test(ext)
    const priority = isSubtitle ? 'normal' : 'media'
    return await sendToDownloadClient(url, fileName, {
      pageUrl: finalPageUrl,
      contentType,
      contentDisposition,
      method: method || 'GET',
      cookies,
      requestBody,
      requestHeaders,
      title: sender.tab?.title || undefined,
      priority,
    })
  })

  registerHandler<{ videoUrl: string; audioUrl: string; fileName?: string; pageUrl?: string }>('sendToDashDownload', async (message, sender) => {
    const { videoUrl, audioUrl, fileName, pageUrl } = message.payload
    logger.info('[media] sendToDashDownload: video=', videoUrl?.slice(0, 80), 'audio=', audioUrl?.slice(0, 80))
    if (!videoUrl || !audioUrl) {
      return { success: false, message: 'DASH 音视频 URL 不完整' }
    }

    const cfg = await getDownloadConfig()
    const finalPageUrl = pageUrl || sender.tab?.url || ''

    // 获取 cookies（video 和 audio 共享同源 cookies）
    let cookies = ''
    try {
      const cookieList = await chrome.cookies.getAll({ url: videoUrl })
      if (cookieList.length > 0) {
        cookies = cookieList.map((c) => `${c.name}=${c.value}`).join('; ')
      }
    } catch {
      // ignore
    }

    // 从当前 tab 的嗅探媒体项中提取 requestHeaders（含 User-Agent 等认证头）
    const dashTabId = sender.tab?.id ?? 0
    let dashRequestHeaders: Record<string, string> | undefined
    try {
      const items = getMediaItems(dashTabId)
      const dashItem = items.find((i) => i.ext === 'm4s' || i.ext === 'mp4')
      if (dashItem?.requestHeaders && Object.keys(dashItem.requestHeaders).length > 0) {
        dashRequestHeaders = dashItem.requestHeaders
      }
    } catch { /* ignore */ }

    const extra = { pageUrl: finalPageUrl, cookies, requestHeaders: dashRequestHeaders }

    const pushClient = getPushClient()
    if (pushClient) {
      try {
        const headers = buildVeloHeaders(extra)
        const msg = {
          action: 'push_dash' as const,
          video_url: videoUrl,
          audio_url: audioUrl,
          url: undefined as string | undefined,
          m3u8_text: undefined as string | undefined,
          base_url: undefined as string | undefined,
          headers,
          options: {
            filename: fileName,
            output_dir: undefined as string | undefined,
            merge_format: 'ts',
            extra_headers: undefined as Record<string, string> | undefined,
          },
        }
        await pushClient.push(msg)
        logger.info('[media] pushed DASH via PushClient: video=', videoUrl.slice(0, 80), 'audio=', audioUrl.slice(0, 80))
        return { success: true }
      } catch (e) {
        logger.warn('[media] PushClient DASH push failed, falling back:', (e as Error).message)
      }
    }

    if (cfg.client === 'velo') {
      return await sendToVeloDash(videoUrl, audioUrl, fileName, cfg, extra)
    }

    // aria2/ndm/native：分别推送 video + audio，提示用户需手动合并
    const videoResult = await sendToDownloadClient(videoUrl, `${fileName ?? 'video'}.video.m4s`, {
      ...extra,
      contentType: 'video/mp4',
      method: 'GET',
    })
    const audioResult = await sendToDownloadClient(audioUrl, `${fileName ?? 'audio'}.audio.m4s`, {
      ...extra,
      contentType: 'audio/mp4',
      method: 'GET',
    })

    if (!videoResult.success || !audioResult.success) {
      return {
        success: false,
        message: `视频: ${videoResult.message ?? 'ok'}, 音频: ${audioResult.message ?? 'ok'}（非 velo 客户端不支持自动合并，请用 FFmpeg 手动合并）`,
      }
    }
    return {
      success: true,
      message: '音视频已分别推送下载，请用 FFmpeg 手动合并: ffmpeg -i video.m4s -i audio.m4s -c copy output.mp4',
    }
  })

  registerHandler('getDownloadConfig', async () => {
    return await getDownloadConfig()
  })

  registerHandler<Partial<DownloadClientConfig>>('setDownloadConfig', async (message) => {
    const cfg = message.payload
    await setDownloadConfig({
      client: cfg.client ?? 'native',
      rpcHost: cfg.rpcHost ?? 'localhost',
      rpcPort: cfg.rpcPort ?? 16816,
      rpcSecret: cfg.rpcSecret ?? '',
      veloHost: cfg.veloHost ?? '127.0.0.1',
      veloPort: cfg.veloPort ?? 16888,
      veloToken: cfg.veloToken ?? '',
    })
    logger.info('[media] download config saved:', cfg.client)
    return { success: true as const }
  })
}