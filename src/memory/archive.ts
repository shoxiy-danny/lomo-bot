/**
 * L0 原始对话归档
 *
 * 设计原则：
 *   - 归档是证据，不是记忆。保留原始对话以便回查。
 *   - 只在 session 清理前写入，不在常规对话路径上。
 *   - searchArchive 只在用户显式回查时调（archive_search 工具），不注入 system prompt。
 *
 * 存储：state/memory/{role}/raw/{session_id}.json
 * 保留：90 天，超过自动裁剪
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs'
import { join } from 'path'
import type { Message, Session } from '../session'
import { extractKeywords } from './retrieve'

const HOME = process.env.HOME || '/home/user'
const STATE_DIR = join(HOME, 'Projects', 'Lomo', 'state', 'memory')

// ── 归档格式 ─────────────────────────────────────────────────────────

export interface ArchiveRecord {
  session_id: string
  character: string
  started_at: string
  ended_at: string
  messages: Array<{ role: 'user' | 'assistant'; content: string; ts: string }>
}

// ── 路径工具 ─────────────────────────────────────────────────────────

function rawDir(role: string): string {
  return join(STATE_DIR, role.toLowerCase(), 'raw')
}

function archivePath(role: string, sessionId: string): string {
  return join(rawDir(role), `${sessionId}.json`)
}

function ensureRawDir(role: string): void {
  const dir = rawDir(role)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ── 归档写入 ─────────────────────────────────────────────────────────

/** session 清理前将原始消息归档 */
export function archiveSession(session: Session): void {
  if (session.messages.length === 0) return

  const record: ArchiveRecord = {
    session_id: session.id,
    character: session.characterName,
    started_at: session.createdAt,
    ended_at: new Date().toISOString(),
    messages: session.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content, ts: m.ts })),
  }

  ensureRawDir(session.characterName)
  const path = archivePath(session.characterName, session.id)
  // 原子写
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
  writeFileSync(path, readFileSync(tmp, 'utf8'), { mode: 0o600 })
  unlinkSync(tmp)

  process.stderr.write(`[archive] saved ${record.messages.length} msgs → ${path}\n`)
}

// ── 归档读取 ─────────────────────────────────────────────────────────

function loadArchiveFile(path: string): ArchiveRecord | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ArchiveRecord
  } catch {
    return null
  }
}

/** 列出某角色的所有归档文件路径（按 ended_at 倒序） */
function listArchiveFiles(role: string): string[] {
  const dir = rawDir(role)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => join(dir, f))
    .sort((a, b) => {
      // 读 ended_at 排序（容错：读不到默认放前面）
      const ra = loadArchiveFile(a)
      const rb = loadArchiveFile(b)
      return (rb?.ended_at || '').localeCompare(ra?.ended_at || '')
    })
}

// ── 搜索 ─────────────────────────────────────────────────────────────

export interface ArchiveSearchResult {
  session_id: string
  date: string
  fragment: string    // 匹配的对话片段（≤200 字）
  context: string     // 前后各一条消息（≤400 字）
}

/**
 * 搜索最近 days 天内的 L0 归档
 * 返回匹配的消息片段，按日期倒序
 */
export function searchArchive(role: string, query: string, days = 90): ArchiveSearchResult[] {
  const files = listArchiveFiles(role)
  if (files.length === 0) return []

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const keywords = extractKeywords(query)
  if (keywords.length === 0) return []

  const results: ArchiveSearchResult[] = []

  for (const file of files) {
    const record = loadArchiveFile(file)
    if (!record) continue
    if (new Date(record.ended_at).getTime() < cutoff) continue

    for (let i = 0; i < record.messages.length; i++) {
      const msg = record.messages[i]
      const content = msg.content.toLowerCase()
      const matched = keywords.filter(kw => content.includes(kw.toLowerCase()))
      if (matched.length === 0) continue

      // 取前后各一条做上下文
      const prev = i > 0 ? record.messages[i - 1] : null
      const next = i < record.messages.length - 1 ? record.messages[i + 1] : null
      const contextParts: string[] = []
      if (prev) contextParts.push(`[${prev.role}] ${prev.content.slice(0, 150)}`)
      contextParts.push(`→ [${msg.role}] ${msg.content.slice(0, 200)}`)
      if (next) contextParts.push(`[${next.role}] ${next.content.slice(0, 150)}`)

      results.push({
        session_id: record.session_id.slice(0, 8),
        date: record.ended_at.slice(0, 10),
        fragment: msg.content.slice(0, 200),
        context: contextParts.join('\n'),
      })
    }
  }

  // 按匹配关键词数 + 日期排序
  results.sort((a, b) => {
    const aMatch = keywords.filter(k => a.fragment.toLowerCase().includes(k.toLowerCase())).length
    const bMatch = keywords.filter(k => b.fragment.toLowerCase().includes(k.toLowerCase())).length
    if (bMatch !== aMatch) return bMatch - aMatch
    return b.date.localeCompare(a.date)
  })

  return results.slice(0, 10)
}

// ── 裁剪 ─────────────────────────────────────────────────────────────

/** 删除超过 maxAgeDays 天的归档文件 */
export function pruneArchive(role: string, maxAgeDays = 90): number {
  const files = listArchiveFiles(role)
  if (files.length === 0) return 0

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  let deleted = 0

  for (const file of files) {
    const record = loadArchiveFile(file)
    if (!record) continue
    if (new Date(record.ended_at).getTime() < cutoff) {
      unlinkSync(file)
      deleted++
    }
  }

  if (deleted > 0) {
    process.stderr.write(`[archive] pruned ${deleted} files older than ${maxAgeDays}d\n`)
  }
  return deleted
}

/** 返回归档统计（供 /status） */
export function archiveStats(role: string): { count: number; oldestDate: string; newestDate: string } {
  const files = listArchiveFiles(role)
  if (files.length === 0) return { count: 0, oldestDate: '', newestDate: '' }

  let oldest = '', newest = ''
  for (const f of files) {
    const r = loadArchiveFile(f)
    if (!r) continue
    if (!oldest || r.ended_at < oldest) oldest = r.ended_at
    if (!newest || r.ended_at > newest) newest = r.ended_at
  }
  return { count: files.length, oldestDate: oldest.slice(0, 10), newestDate: newest.slice(0, 10) }
}
