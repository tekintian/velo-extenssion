import { logger } from '@/lib/logger'
import { persistentStorage } from '@/lib/storage'
import { STORAGE_KEYS, PROTOCOL_VERSION, SUB_PROTOCOL, DEFAULT_PORT } from '@/types'
import type { PairingInfo } from '@/types'

export interface ProbeResult {
  available: boolean
  port: number
  tokenRequired: boolean
}

/**
 * 扩展自身身份：握手时上报给桌面端，供「确认配对」时直接转正，
 * 免去用户在设置页手工填写扩展 ID / 设备名。
 */
export function getExtensionIdentity(): { extension_id: string; device_name: string } {
  let extensionId = ''
  try {
    extensionId = chrome.runtime.id
  } catch {
    // service worker 早期阶段 chrome.runtime 可能不可用 — 留空由桌面端兜底
  }
  let deviceName = 'velo-extension'
  try {
    deviceName = chrome.runtime.getManifest().name || deviceName
  } catch {
    // 忽略
  }
  return { extension_id: extensionId, device_name: deviceName }
}

export class PairingManager {
  async getPairing(): Promise<PairingInfo | null> {
    try {
      return await persistentStorage.get<PairingInfo>(STORAGE_KEYS.pairing) ?? null
    } catch {
      return null
    }
  }

  async savePairing(token: string, port: number): Promise<void> {
    const info: PairingInfo = {
      token,
      port,
      paired_at: Date.now(),
    }
    await persistentStorage.set(STORAGE_KEYS.pairing, info)
    logger.info('Pairing saved, port:', port)
  }

  async clearPairing(): Promise<void> {
    await persistentStorage.remove(STORAGE_KEYS.pairing)
    logger.info('Pairing cleared')
  }

  async validatePairing(token: string, port: number): Promise<boolean> {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [SUB_PROTOCOL])
      return await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          ws.close()
          resolve(false)
        }, 5000)

        ws.onopen = () => {
          const handshake = {
            version: PROTOCOL_VERSION,
            action: 'handshake',
            token,
            ...getExtensionIdentity(),
            options: { merge_format: '' },
          }
          ws.send(JSON.stringify(handshake))
        }

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data as string) as { ok?: boolean; error?: string }
            clearTimeout(timeout)
            ws.close()
            resolve(data.ok === true)
          } catch {
            clearTimeout(timeout)
            ws.close()
            resolve(false)
          }
        }

        ws.onerror = () => {
          clearTimeout(timeout)
          resolve(false)
        }
      })
    } catch (e) {
      logger.warn('validatePairing failed:', (e as Error).message)
      return false
    }
  }

  /**
   * 探测 Velo 桌面端是否在运行（纯 WebSocket 握手探测）。
   *
   * 说明：velo 推送服务只接受 WebSocket（HTTP 路径不返回响应），因此探活必须
   * 直接建 WS。桌面端未启动时浏览器网络层会打印一条 ERR_CONNECTION_REFUSED
   * 原生日志，JS 无法捕获——通过调用方节流（自动探测失败后一段时间内不再重试）
   * 把这类「已知异常」降到最低，而不是在扩展里主动报错。
   *
   * @returns ProbeResult — available=true 表示客户端可连接，tokenRequired 表示是否需要 token
   */
  async probeClient(ports?: number[]): Promise<ProbeResult> {
    const probePorts = ports ?? [DEFAULT_PORT]
    for (const port of probePorts) {
      const wsResult = await this.probeWs(port)
      if (wsResult.available) {
        return { available: true, port, tokenRequired: wsResult.tokenRequired }
      }
    }
    return { available: false, port: 0, tokenRequired: true }
  }

  private probeWs(port: number): Promise<{ available: boolean; tokenRequired: boolean }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { ws.close() } catch { /* ignore */ }
        resolve({ available: false, tokenRequired: true })
      }, 3000)

      let ws: WebSocket
      try {
        ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [SUB_PROTOCOL])
      } catch {
        clearTimeout(timer)
        resolve({ available: false, tokenRequired: true })
        return
      }

      ws.onopen = () => {
        const handshake = {
          version: PROTOCOL_VERSION,
          action: 'handshake',
          token: '',
          options: { merge_format: '' },
        }
        ws.send(JSON.stringify(handshake))
      }

      ws.onmessage = (event) => {
        clearTimeout(timer)
        try {
          const data = JSON.parse(event.data as string) as { ok?: boolean; error?: string }
          ws.close()
          if (data.ok === true) {
            resolve({ available: true, tokenRequired: false })
          } else {
            resolve({ available: true, tokenRequired: true })
          }
        } catch {
          ws.close()
          resolve({ available: true, tokenRequired: true })
        }
      }

      ws.onerror = () => {
        clearTimeout(timer)
        resolve({ available: false, tokenRequired: true })
      }
    })
  }
}