import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/storage', () => ({
  persistentStorage: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
  },
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { PairingManager } from '@/background/pairing'
import { persistentStorage } from '@/lib/storage'

const mockGet = vi.mocked(persistentStorage.get)
const mockSet = vi.mocked(persistentStorage.set)
const mockRemove = vi.mocked(persistentStorage.remove)

describe('PairingManager', () => {
  let manager: PairingManager

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new PairingManager()
  })

  describe('getPairing', () => {
    it('returns null when no pairing stored', async () => {
      mockGet.mockResolvedValueOnce(undefined)
      const result = await manager.getPairing()
      expect(result).toBeNull()
    })

    it('returns pairing info when stored', async () => {
      const info = { token: 'test-token', port: 16888, paired_at: 1000 }
      mockGet.mockResolvedValueOnce(info)
      const result = await manager.getPairing()
      expect(result).toEqual(info)
    })

    it('returns null on storage error', async () => {
      mockGet.mockRejectedValueOnce(new Error('storage error'))
      const result = await manager.getPairing()
      expect(result).toBeNull()
    })
  })

  describe('savePairing', () => {
    it('saves pairing info with timestamp', async () => {
      mockSet.mockResolvedValueOnce(undefined)
      await manager.savePairing('my-token', 9999)
      expect(mockSet).toHaveBeenCalledWith('_sdownPairing', expect.objectContaining({
        token: 'my-token',
        port: 9999,
        paired_at: expect.any(Number),
      }))
    })
  })

  describe('clearPairing', () => {
    it('removes pairing from storage', async () => {
      mockRemove.mockResolvedValueOnce(undefined)
      await manager.clearPairing()
      expect(mockRemove).toHaveBeenCalledWith('_sdownPairing')
    })
  })
})
