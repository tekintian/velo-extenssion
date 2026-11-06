/**
 * fingerprint.ts 单元测试
 *
 * 覆盖：
 *   ① learnFingerprint + lookupFingerprint round-trip
 *   ② clearLearned 清空
 *   ③ clearUrlCache 清空
 *   ④ initFingerprint 初始化
 *
 * 注意：computeFingerprint 需要 fetch 网络请求，不在本测试覆盖范围（需 mock 服务器）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockStorage = new Map<string, unknown>()
vi.mock('@/lib/storage', () => ({
  persistentStorage: {
    get: vi.fn(async (key: string) => mockStorage.get(key)),
    set: vi.fn(async (key: string, value: unknown) => { mockStorage.set(key, value) }),
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

import {
  initFingerprint,
  learnFingerprint,
  lookupFingerprint,
  lookupUserMarkedFingerprint,
  hasUserMarkedFingerprints,
  USER_MARKED_SOURCE,
  clearLearned,
  clearUrlCache,
  getLearnedCount,
} from '@/engine/hls/fingerprint'

describe('fingerprint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStorage.clear()
  })

  it('① learnFingerprint + lookupFingerprint round-trip', async () => {
    await initFingerprint()
    const hash = 'abc123def456-unique-1'
    const added = await learnFingerprint(hash, { adName: 'test-ad', source: 'manual' })
    expect(added).toBe(true)

    const result = lookupFingerprint(hash)
    expect(result.isAd).toBe(true)
    expect(result.adName).toBe('test-ad')
    expect(result.source).toBe('manual')
  })

  it('① 重复 learnFingerprint 不新增（幂等）', async () => {
    await initFingerprint()
    const hash = 'abc123-unique-2'
    await learnFingerprint(hash, { adName: 'ad1', source: 's1' })
    const added2 = await learnFingerprint(hash, { adName: 'ad2', source: 's2' })
    expect(added2).toBe(false) // 已存在，不新增

    // 保留首次入库的元数据
    const result = lookupFingerprint(hash)
    expect(result.adName).toBe('ad1')
    expect(result.source).toBe('s1')
  })

  it('② clearLearned 清空 learned 库', async () => {
    await initFingerprint()
    await learnFingerprint('hash-clear-1', { adName: 'ad1', source: 's' })
    await learnFingerprint('hash-clear-2', { adName: 'ad2', source: 's' })
    const countBefore = getLearnedCount()
    expect(countBefore).toBeGreaterThanOrEqual(2)

    await clearLearned()
    expect(getLearnedCount()).toBe(0)

    expect(lookupFingerprint('hash-clear-1').isAd).toBe(false)
  })

  it('③ lookupFingerprint 未知 hash 返回 isAd=false', async () => {
    await initFingerprint()
    const result = lookupFingerprint('unknown-hash-xyz-not-exist')
    expect(result.isAd).toBe(false)
  })

  it('④ clearUrlCache 不抛错', async () => {
    await initFingerprint()
    expect(() => clearUrlCache()).not.toThrow()
  })

  it('⑤ learnFingerprint 后 getLearnedCount 增加', async () => {
    await initFingerprint()
    await clearLearned() // 确保干净起点
    const countBefore = getLearnedCount()
    await learnFingerprint('count-test-hash', { adName: 'ad', source: 's' })
    expect(getLearnedCount()).toBe(countBefore + 1)
  })

  it('⑥ lookupUserMarkedFingerprint 只命中 user-marked 来源', async () => {
    await initFingerprint()
    await clearLearned()

    await learnFingerprint('um-hit', { adName: 'user-ad', source: USER_MARKED_SOURCE })
    await learnFingerprint('um-miss', { adName: 'auto-ad', source: 'auto-learned' })

    const hit = await lookupUserMarkedFingerprint('um-hit')
    expect(hit?.isAd).toBe(true)
    expect(hit?.source).toBe(USER_MARKED_SOURCE)

    // auto-learned 不算用户标注，避免未开总开关时被机器噪声误判
    expect(await lookupUserMarkedFingerprint('um-miss')).toBeNull()
    expect(await lookupUserMarkedFingerprint('not-exist')).toBeNull()
  })

  it('⑦ hasUserMarkedFingerprints 反映库中是否存在用户标注', async () => {
    await initFingerprint()
    await clearLearned()
    expect(await hasUserMarkedFingerprints()).toBe(false)

    await learnFingerprint('only-auto', { adName: 'a', source: 'auto-learned' })
    expect(await hasUserMarkedFingerprints()).toBe(false)

    await learnFingerprint('with-user', { adName: 'u', source: USER_MARKED_SOURCE })
    expect(await hasUserMarkedFingerprints()).toBe(true)
  })

  it('⑧ hasUserMarkedFingerprints 无需先 initFingerprint（自动加载 learned 库）', async () => {
    await clearLearned()
    await learnFingerprint('lazy-user', { adName: 'u', source: USER_MARKED_SOURCE })
    // 模拟新会话：不调用 init，直接查询也应命中
    expect(await hasUserMarkedFingerprints()).toBe(true)
    expect((await lookupUserMarkedFingerprint('lazy-user'))?.isAd).toBe(true)
  })
})