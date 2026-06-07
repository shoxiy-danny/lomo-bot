/**
 * Session Summary — 会话摘要存储
 *
 * 独立于 memory.json，只存最近 5 条会话的摘要（≤150 字）。
 * 检索时拼到记忆注入块，让 LLM 知道"上次聊到哪了"。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import type { SessionSummary } from './types'
import { roleId } from './types'

const STATE_ROOT = join(
  process.env.HOME || '/home/user',
  'Projects', 'Lomo', 'state', 'memory',
)

function summaryFile(role: string): string {
  return join(STATE_ROOT, roleId(role), 'session_summaries.json')
}

const MAX_SUMMARIES = 5

function ensureDir(role: string): void {
  const dir = join(STATE_ROOT, roleId(role))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function load(role: string): SessionSummary[] {
  const file = summaryFile(role)
  if (!existsSync(file)) return []
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

function save(role: string, summaries: SessionSummary[]): void {
  ensureDir(role)
  const file = summaryFile(role)
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(summaries, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

/** 获取最近 N 条摘要（默认 5） */
export function getRecentSummaries(role: string, n = MAX_SUMMARIES): SessionSummary[] {
  return load(role).slice(-n)
}

/** 追加一条摘要，保持最近 MAX_SUMMARIES 条 */
export function appendSummary(role: string, summary: SessionSummary): void {
  const all = load(role)
  all.push(summary)
  // 只保留最近 MAX_SUMMARIES 条
  const trimmed = all.slice(-MAX_SUMMARIES)
  save(role, trimmed)
}

/** 摘要列表文本（拼到记忆块） */
export function buildSummaryBlock(summaries: SessionSummary[]): string {
  if (summaries.length === 0) return ''
  const lines = summaries.map(s => `- [${s.created_at.slice(0, 10)}] ${s.summary}`)
  return `📅 **最近会话摘要**\n${lines.join('\n')}`
}
