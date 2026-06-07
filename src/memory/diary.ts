/**
 * 日记系统 — Lomo 的心情记录
 *
 * 存储：state/memory/<roleId>/diary.md
 * 格式：## YYYY-MM-DD + 6 行以内自由内容
 * 上限：30 条，超过删旧留新
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

const HOME = process.env.HOME || '/home/user'
const STATE_DIR = join(HOME, 'Projects', 'Lomo', 'state', 'memory')

function getDiaryPath(role: string): string {
  return join(STATE_DIR, role.toLowerCase(), 'diary.md')
}

/**
 * 读取最近 N 条日记
 * 返回格式：["## 2026-06-03\n今天心情不错...", ...]
 */
export function getRecentDiaryEntries(role: string, n = 3): string[] {
  const path = getDiaryPath(role)
  if (!existsSync(path)) return []

  const content = readFileSync(path, 'utf8')
  const entries: string[] = []

  // 按 ## YYYY-MM-DD 分割
  const parts = content.split(/^(?=## \d{4}-\d{2}-\d{2})/m)
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed && trimmed.startsWith('## ')) {
      entries.push(trimmed)
    }
  }

  // 返回最近 n 条
  return entries.slice(-n)
}

/**
 * 追加一条日记
 */
export function appendDiaryEntry(role: string, entry: string): void {
  const path = getDiaryPath(role)
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const dateStr = now.toISOString().slice(0, 10)

  // 读取现有内容
  let existing = ''
  if (existsSync(path)) {
    existing = readFileSync(path, 'utf8').trim()
  }

  // 构建新条目
  const newEntry = `## ${dateStr}\n${entry}`

  // 追加
  const updated = existing ? `${existing}\n\n${newEntry}\n` : `${newEntry}\n`

  // 检查条目数，超过 30 则删除旧的
  const entries = updated.split(/^(?=## \d{4}-\d{2}-\d{2})/m).filter(e => e.trim().startsWith('## '))
  let finalContent = updated
  if (entries.length > 30) {
    finalContent = entries.slice(-30).join('\n').trim() + '\n'
  }

  writeFileSync(path, finalContent, { mode: 0o600 })
  process.stderr.write(`[diary] appended entry for ${role} (${entry.length} chars)\n`)
}

/**
 * 构建注入到 system prompt 的日记块
 */
export function buildDiaryBlock(entries: string[]): string {
  if (entries.length === 0) return ''
  return `📝 最近的心情记录：\n${entries.join('\n\n')}`
}
