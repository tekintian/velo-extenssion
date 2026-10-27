import { defineContentScript } from 'wxt/utils/define-content-script'
import { asWin } from '@/lib/cast'

/**
 * MSE (MediaSource Extensions) hook — 严格移植 NDM ct.js 的 MSE 拦截逻辑
 *
 * ## 概述
 * NDM bg.js 在 onHeadersReceived 阶段嗅探 m3u8/ts/mp4 等明文 URL，
 * 但对于 MSE 流（YouTube / Twitch / B 站 等都用 MSE），
 * 视频数据通过 SourceBuffer.appendBuffer 流式写入 MediaSource，
 * webRequest 看不到任何视频分片 URL。
 *
 * 本 hook 在 MAIN world 拦截 URL.createObjectURL + MediaSource.addSourceBuffer +
 * SourceBuffer.appendBuffer，把 MSE 媒体信息（mime / 分片大小 / SHA-256 指纹）
 * 通过 window.postMessage 转发给 isolated world 的 hls-bridge.content.ts。
 *
 * ## task #12: appendBuffer hook 计算 SHA-256 指纹
 *
 * 旧实现只上报 byteLength，桌面端无法对 MSE 流做去重 / 内容指纹比对。
 * 新实现：每条 appendBuffer 数据的前 64KB 计算 SHA-256 哈希，
 * 通过 postMessage 发送 `{type:'velo-mse-segment', hash, size}`，
 * 桌面端可基于哈希做分片去重、广告指纹匹配、内容审计。
 *
 * ### 为什么是前 64KB？
 * 完整分片（通常 2-10MB）的 SHA-256 计算开销大（每次 appendBuffer 都算会阻塞主线程）。
 * 取前 64KB 既能唯一标识分片（前几个 packet 含 ftyp/moov box 或 TS sync byte +
 * PAT/PMT），又控制计算开销在 < 1ms。
 *
 * ### WebCrypto subtle.digest
 * MAIN world 中可用 crypto.subtle.digest（异步）。
 * appendBuffer 是同步调用，但内部异步计算哈希不阻塞视频播放。
 */
export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  allFrames: true,
  runAt: 'document_start',
  world: 'MAIN',

  main() {
    const HLS_NS = asWin().__HLS_HOOK_NAMESPACE__ ??= {} as Record<string, unknown>
    asWin().__HLS_HOOK_NAMESPACE__ = HLS_NS

    if ((HLS_NS as Record<string, unknown>).mseHooked) {
      return
    }
    ;(HLS_NS as Record<string, unknown>).mseHooked = 'velo'

    const origCreateObjectURL = URL.createObjectURL
    URL.createObjectURL = function (blob: Blob | MediaSource) {
      if (blob instanceof MediaSource) {
        hookMediaSource(blob)
      }
      return origCreateObjectURL.call(URL, blob)
    }

    /**
     * task #12: 计算数据前 64KB 的 SHA-256 哈希
     *
     * @param data appendBuffer 传入的 BufferSource
     * @returns 16 进制哈希字符串（64 字符）；失败返回空字符串
     */
    async function computeSha256Prefix(data: BufferSource): Promise<string> {
      try {
        const bytes = new Uint8Array(
          data instanceof ArrayBuffer
            ? data
            : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        )
        // 取前 64KB（不足 64KB 则取全部）
        const slice = bytes.slice(0, 64 * 1024)
        const hashBuf = await crypto.subtle.digest('SHA-256', slice)
        const hashArr = Array.from(new Uint8Array(hashBuf))
        return hashArr.map((b) => b.toString(16).padStart(2, '0')).join('')
      } catch {
        return ''
      }
    }

    function isMediaMime(mimeType: string): boolean {
      const lower = mimeType.toLowerCase()
      return (
        lower.includes('mpegurl') ||
        lower.startsWith('video/') ||
        lower.startsWith('audio/') ||
        lower.includes('mp4') ||
        lower.includes('webm') ||
        lower.includes('matroska')
      )
    }

    function hookMediaSource(ms: MediaSource): void {
      const origAddSourceBuffer = ms.addSourceBuffer.bind(ms)
      ms.addSourceBuffer = function (mimeType: string) {
        const sb = origAddSourceBuffer(mimeType)

        if (isMediaMime(mimeType)) {
          window.postMessage({
            source: 'velo-mse',
            type: 'mse-source-added',
            payload: { mimeType, url: location.href },
          }, '*')

          const origAppend = sb.appendBuffer.bind(sb)
          // task #12: appendBuffer hook — 计算 SHA-256 + 上报 size
          // 不能用 async function 替换 sb.appendBuffer（会让返回值变成 Promise），
          // 同步调用 origAppend 后 fire-and-forget 计算哈希
          sb.appendBuffer = function (data: BufferSource) {
            const byteLength = data.byteLength
            // 立即同步上报（让桌面端尽快知道有分片写入）
            window.postMessage({
              source: 'velo-mse',
              type: 'mse-segment-appended',
              payload: { mimeType, byteLength, url: location.href },
            }, '*')
            // 异步计算 SHA-256 哈希（task #12）
            void computeSha256Prefix(data).then((hash) => {
              if (!hash) return
              window.postMessage({
                source: 'velo-mse',
                type: 'velo-mse-segment',
                payload: {
                  mimeType,
                  hash,
                  size: byteLength,
                  url: location.href,
                  protocol: mimeType.toLowerCase().startsWith('video/mp4') || mimeType.toLowerCase().startsWith('audio/mp4') || mimeType.toLowerCase().includes('webm') ? 'dash' : 'hls',
                },
              }, '*')
            })
            return origAppend(data)
          }
        }

        return sb
      }
    }
  },
})