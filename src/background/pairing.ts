import { logger } from '@/lib/logger'
import { persistentStorage } from '@/lib/storage'
import { STORAGE_KEYS, PROTOCOL_VERSION, SUB_PROTOCOL } from '@/types'
import type { PairingInfo } from '@/types'

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
}
