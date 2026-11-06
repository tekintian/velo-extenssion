/**
 * locale-rules.ts 单元测试
 *
 * 覆盖 Chrome i18n 占位符的 6 条校验规则：
 * 占位符命名、声明与引用一致性、未使用声明、content 格式、key 集合对齐、message 有效性
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it, expect } from 'vitest'
import { collectTokens, checkEntry, checkLocaleData, checkKeyParity } from '@/lib/locale-rules'
import type { LocaleKeySet } from '@/lib/locale-rules'

describe('collectTokens', () => {
  it('提取消息体中的所有占位符名', () => {
    expect(collectTokens('已过滤 $COUNT$ 条，耗时 $DURATION$s')).toEqual(['COUNT', 'DURATION'])
  })

  it('无占位符时返回空数组', () => {
    expect(collectTokens('纯文本消息')).toEqual([])
  })

  it('数字占位符同样被识别（用于后续判定非法）', () => {
    expect(collectTokens('failed: $1$')).toEqual(['1'])
  })
})

describe('checkEntry', () => {
  it('合法条目无问题', () => {
    const entry = {
      message: 'Download failed: $ERROR$',
      placeholders: { ERROR: { content: '$1' } },
    }
    expect(checkEntry('popup_download_fail', entry)).toEqual([])
  })

  it('多个占位符且顺序与 content 不一致也合法', () => {
    const entry = {
      message: '已发送到 $CLIENT$ 下载：$FILE$',
      placeholders: { CLIENT: { content: '$1' }, FILE: { content: '$2' } },
    }
    expect(checkEntry('download_pushed_success', entry)).toEqual([])
  })

  it('规则1：数字占位符名非法', () => {
    const entry = {
      message: 'Download failed: $1$',
      placeholders: { ERROR: { content: '$1' } },
    }
    const details = checkEntry('popup_download_fail', entry).map((i) => i.detail)
    expect(details).toContainEqual(expect.stringContaining('非法占位符名 $1$'))
  })

  it('规则1：小写占位符名非法', () => {
    const entry = {
      message: 'saved (t=$time$s)',
      placeholders: { TIME: { content: '$1' } },
    }
    const issues = checkEntry('popup_sample_saved', entry)
    expect(issues).toHaveLength(2)
    expect(issues[0]?.detail).toContain('非法占位符名 $time$')
  })

  it('规则2：占位符未在 placeholders 中声明', () => {
    const entry = { message: 'Loaded $SIZE$ bytes' }
    const issues = checkEntry('sample_preview_size', entry)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.detail).toContain('占位符 $SIZE$ 未在 placeholders 中声明')
  })

  it('规则3：placeholders 声明了未使用的键', () => {
    const entry = {
      message: 'Download failed',
      placeholders: { ERROR: { content: '$1' } },
    }
    const details = checkEntry('popup_download_fail', entry).map((i) => i.detail)
    expect(details).toContainEqual(expect.stringContaining('未使用的 "ERROR"'))
  })

  it('规则3：placeholders 键小写非法', () => {
    const entry = {
      message: '✓ Sample saved, $TOTAL$ fingerprints stored ($ADDED$ new, $REVOKED$ revoked)',
      placeholders: {
        added: { content: '$1' },
        total: { content: '$2' },
        revoked: { content: '$3' },
      },
    }
    const details = checkEntry('sample_saved_toast', entry).map((i) => i.detail)
    expect(details.some((d) => d.includes('placeholders 键 "added" 非法'))).toBe(true)
    expect(details.some((d) => d.includes('占位符 $ADDED$ 未在 placeholders 中声明'))).toBe(true)
  })

  it('规则4：content 必须是 $数字 形式', () => {
    const entry = {
      message: 'port $PORT$',
      placeholders: { PORT: { content: 'PORT' } },
    }
    const issues = checkEntry('popup_paired', entry)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.detail).toContain('content 必须是 "$数字" 形式')
  })

  it('规则4：content 为 0 起始序号时非法', () => {
    const entry = {
      message: 'port $PORT$',
      placeholders: { PORT: { content: '$0' } },
    }
    expect(checkEntry('popup_paired', entry)).toHaveLength(1)
  })

  it('规则4：placeholder 必须是对象', () => {
    const entry = {
      message: 'port $PORT$',
      placeholders: { PORT: '$1' },
    }
    const details = checkEntry('popup_paired', entry).map((i) => i.detail)
    expect(details).toContainEqual(expect.stringContaining('必须是对象'))
  })

  it('规则6：message 缺失', () => {
    expect(checkEntry('broken', {})).toHaveLength(1)
  })

  it('规则6：message 为空字符串', () => {
    const issues = checkEntry('empty', { message: '   ' })
    expect(issues[0]?.detail).toContain('message 必须是非空字符串')
  })

  it('entry 非对象时报错', () => {
    const issues = checkEntry('bad', 'text')
    expect(issues[0]?.detail).toContain('entry 必须是对象')
  })

  it('placeholders 为数组时报错', () => {
    const issues = checkEntry('bad', { message: 'x', placeholders: [] })
    expect(issues[0]?.detail).toContain('placeholders 必须是对象')
  })
})

describe('checkLocaleData', () => {
  it('逐条汇总问题并带上 key', () => {
    const data = {
      ok_entry: { message: 'ok' },
      bad_entry: { message: 'failed $1$' },
    }
    const issues = checkLocaleData('en_US.json', data)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.file).toBe('en_US.json')
    expect(issues[0]?.key).toBe('bad_entry')
  })
})

describe('checkKeyParity', () => {
  const make = (file: string, keys: string[]): LocaleKeySet => ({ file, keys: new Set(keys) })

  it('key 集合一致时无问题', () => {
    expect(checkKeyParity([make('en_US.json', ['a', 'b']), make('zh_CN.json', ['b', 'a'])])).toEqual([])
  })

  it('缺少 key 会被报告', () => {
    const issues = checkKeyParity([make('en_US.json', ['a', 'b']), make('zh_CN.json', ['a'])])
    expect(issues).toHaveLength(1)
    expect(issues[0]?.file).toBe('zh_CN.json')
    expect(issues[0]?.key).toBe('b')
    expect(issues[0]?.detail).toContain('缺少')
  })

  it('多余 key 会被报告', () => {
    const issues = checkKeyParity([make('en_US.json', ['a']), make('zh_CN.json', ['a', 'c'])])
    expect(issues[0]?.file).toBe('zh_CN.json')
    expect(issues[0]?.key).toBe('c')
    expect(issues[0]?.detail).toContain('不存在此 key')
  })

  it('少于两个语言文件时不校验', () => {
    expect(checkKeyParity([make('only.json', ['a'])])).toEqual([])
    expect(checkKeyParity([])).toEqual([])
  })
})

describe('check-locales 脚本端到端', () => {
  const root = path.resolve(__dirname, '../../..')

  it('真实语言文件通过校验并正常退出', () => {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', path.join(root, 'scripts/check-locales.ts')],
      { encoding: 'utf8' },
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('本地化文件校验通过')
  })

  it('src/locales 下至少存在两个语言文件', () => {
    const files = fs.readdirSync(path.join(root, 'src/locales')).filter((f) => f.endsWith('.json'))
    expect(files.length).toBeGreaterThanOrEqual(2)
  })
})