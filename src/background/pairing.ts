import { logger } from '@/lib/logger'
import { persistentStorage } from '@/lib/storage'
import { STORAGE_KEYS, PROTOCOL_VERSION, SUB_PROTOCOL, DEFAULT_PORT } from '@/types'
import type { PairingInfo } from '@/types'

export interface ProbeResult {
  available: boolean
  port: number
  tokenRequired: boolean
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
   * 探测 Velo 桌面端是否在运行。
   *
   * 策略：
   *   1. 先尝试 WS 握手（空 token）— 若 ok=true 说明客户端无需 token
   *   2. 若 WS 连接失败，再尝试 HTTP /health 探活
   *   3. 按端口列表依次探测（默认端口 + 已保存端口）
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
      const httpResult = await this.probeHttp(port)
      if (httpResult) {
        return { available: true, port, tokenRequired: true }
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

  private async probeHttp(port: number): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 3000)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          method: 'GET',
          signal: controller.signal,
        })
        return res.ok
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return false
    }
  }
}