#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkKeyParity, checkLocaleData, type LocaleFileIssue, type LocaleKeySet } from '../src/lib/locale-rules.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localesDir = path.join(root, 'src', 'locales')

const files = fs
  .readdirSync(localesDir)
  .filter((f) => f.endsWith('.json'))
  .sort()

if (files.length === 0) {
  console.error(`未找到任何语言文件：${localesDir}`)
  process.exit(1)
}

const problems: Array<LocaleFileIssue | string> = []
const keySets: LocaleKeySet[] = []

for (const file of files) {
  const full = path.join(localesDir, file)
  let data: Record<string, unknown>
  try {
    data = JSON.parse(fs.readFileSync(full, 'utf8')) as Record<string, unknown>
  } catch (err) {
    problems.push(`${path.relative(root, full)} :: JSON 解析失败 :: ${(err as Error).message}`)
    continue
  }

  keySets.push({ file, keys: new Set(Object.keys(data)) })
  problems.push(...checkLocaleData(file, data))
}

problems.push(...checkKeyParity(keySets))

if (problems.length > 0) {
  console.error(`本地化文件校验失败，共 ${problems.length} 个问题：\n`)
  for (const p of problems) {
    console.error(typeof p === 'string' ? `  ${p}` : `  ${p.file} :: ${p.key} :: ${p.detail}`)
  }
  console.error('')
  process.exit(1)
}

const reference = keySets[0]
console.log(`本地化文件校验通过（${keySets.length} 个语言文件，${reference ? reference.keys.size : 0} 个 key）`)