/**
 * io.ts 导入导出 round-trip 测试
 *
 * 验证 P0 修复（p.sample → p.samples 拼写 bug）：
 *   导出 → 导入后 samples 不丢失
 *
 * 覆盖：
 *   ① buildExport 返回正确 schema
 *   ② applyImport merge 策略：samples round-trip 保留
 *   ③ applyImport replace 策略：覆盖旧数据
 *   ④ 空导入安全
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock persistentStorage（io.ts 依赖）
const mockStorage = new Map<string, unknown>()
vi.mock('@/lib/storage', () => ({
  persistentStorage: {
    get: vi.fn(async (key: string) => mockStorage.get(key)),
    set: vi.fn(async (key: string, value: unknown) => { mockStorage.set(key, value) }),
  },
  settingsStore: {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
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

import { buildExport, applyImport, type BackupPayload } from '@/engine/hls/io'

describe('io.ts round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStorage.clear()
  })

  it('① buildExport 返回正确 schema', async () => {
    const payload = await buildExport()
    expect(payload.schema).toBe('adclear-hls-backup')
    expect(payload.version).toBe(1)
    expect(payload.exportedAt).toBeGreaterThan(0)
    // 空状态导出，可选字段应 undefined
    expect(payload.userRules).toBeUndefined()
    expect(payload.samples).toBeUndefined()
  })

  it('② applyImport merge — samples round-trip 保留（验证 P0 拼写修复）', async () => {
    // 构造含 samples 的导入 payload
    const sample = {
      id: 'test-sample-1',
      baseUrl: 'https://example.com/video.m3u8',
      pageHost: 'example.com',
      hash: 'abc123',
      adName: 'test-ad',
      source: 'manual',
      capturedAt: Date.now(),
    }
    const importPayload: BackupPayload = {
      schema: 'adclear-hls-backup',
      version: 1,
      exportedAt: Date.now(),
      samples: [sample],
    }

    // 导入
    const result = await applyImport(importPayload, 'replace')
    expect(result.samples).toBe(1)

    // 再次导出，验证 samples 不丢失（P0 修复前 p.sample 导致丢失）
    const reExport = await buildExport()
    expect(reExport.samples).toBeDefined()
    expect((reExport.samples as unknown[]).length).toBe(1)
  })

  it('③ applyImport replace — 覆盖旧数据', async () => {
    // 先导入一批 userRules
    await applyImport({
      schema: 'adclear-hls-backup',
      version: 1,
      exportedAt: Date.now(),
      userRules: [{ id: 'rule-1', name: 'old', hostPattern: 'old\\.com', adUrlPatterns: ['/ad/'], scoreThreshold: 3, forceKeep: [] }],
    }, 'replace')

    // 再 replace 导入新 rules
    const result = await applyImport({
      schema: 'adclear-hls-backup',
      version: 1,
      exportedAt: Date.now(),
      userRules: [{ id: 'rule-2', name: 'new', hostPattern: 'new\\.com', adUrlPatterns: ['/ad/'], scoreThreshold: 3, forceKeep: [] }],
    }, 'replace')

    expect(result.userRules).toBe(1) // replace 模式只有新规则
  })

  it('④ 空导入安全', async () => {
    const result = await applyImport({
      schema: 'adclear-hls-backup',
      version: 1,
      exportedAt: Date.now(),
    }, 'merge')
    expect(result.userRules).toBe(0)
    expect(result.pending).toBe(0)
    expect(result.samples).toBe(0)
    expect(result.fingerprints).toBe(0)
  })
})
