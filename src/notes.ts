/**
 * Notes — 随手记数据层 v2
 *
 * 存储：state/notes.json（单文件，原子写入）
 * 设计：单文件 + category 字段，兼顾全局搜索和分类管理
 * 对文科生模型友好：keyword 双通道（id 或关键词匹配）
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'

// ── 接口 ─────────────────────────────────────────────────────────

export interface Note {
  id: string
  content: string
  category: string        // "工作日志" | "片单" | "收藏" | "默认" | 自定义
  tags: string[]
  createdAt: number
  updatedAt: number
}

// ── 存储 ─────────────────────────────────────────────────────────

const STATE_DIR = join(process.env.HOME || '/tmp', 'Projects', 'Lomo', 'state')
const FILE_PATH = join(STATE_DIR, 'notes.json')

let cache: Note[] | null = null

function atomicWrite(filePath: string, content: string): void {
  const dir = join(filePath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmpPath = filePath + '.tmp'
  writeFileSync(tmpPath, content, { mode: 0o600 })
  renameSync(tmpPath, filePath)
}

export function loadNotes(): Note[] {
  if (cache) return cache
  try {
    if (!existsSync(FILE_PATH)) { cache = []; return cache }
    cache = JSON.parse(readFileSync(FILE_PATH, 'utf8')) as Note[]
  } catch {
    cache = []
  }
  return cache!
}

export function saveNotes(list: Note[]): void {
  cache = [...list]  // 浅拷贝，避免外部引用问题
  atomicWrite(FILE_PATH, JSON.stringify(list, null, 2))
}

// ── CRUD ─────────────────────────────────────────────────────────

export function addNote(content: string, category = '默认', tags: string[] = []): Note {
  const list = loadNotes()
  const now = Date.now()
  const entry: Note = {
    id: randomBytes(4).toString('hex'),  // 8 位短 ID
    content,
    category,
    tags,
    createdAt: now,
    updatedAt: now,
  }
  list.push(entry)
  saveNotes(list)
  process.stderr.write(`[note] added id=${entry.id.slice(0, 8)} cat=${category} content=${content.slice(0, 40)}\n`)
  return entry
}

export function updateNote(id: string, patch: {
  content?: string
  category?: string
  tags?: string[]
  append?: string
}): Note | null {
  const list = loadNotes()
  const note = list.find(n => n.id === id)
  if (!note) return null

  if (patch.content !== undefined) {
    note.content = patch.content
  } else if (patch.append !== undefined) {
    note.content += patch.append
  }
  if (patch.category !== undefined) note.category = patch.category
  if (patch.tags !== undefined) note.tags = patch.tags
  note.updatedAt = Date.now()

  saveNotes(list)
  process.stderr.write(`[note] updated id=${id.slice(0, 8)}\n`)
  return note
}

export function deleteNote(id: string): boolean {
  const list = loadNotes()
  const idx = list.findIndex(n => n.id === id)
  if (idx === -1) return false
  list.splice(idx, 1)
  saveNotes(list)
  process.stderr.write(`[note] deleted id=${id.slice(0, 8)}\n`)
  return true
}

export function listNotes(opts: {
  category?: string
  keyword?: string
  limit?: number
  offset?: number
} = {}): { notes: Note[], total: number } {
  const { category, keyword, limit = 30, offset = 0 } = opts
  let list = loadNotes()

  // 按分类过滤
  if (category) {
    list = list.filter(n => n.category === category)
  }

  // 按关键词过滤
  if (keyword) {
    const kw = keyword.toLowerCase()
    list = list.filter(n =>
      n.content.toLowerCase().includes(kw) ||
      n.tags.some(t => t.toLowerCase().includes(kw))
    )
  }

  // 按创建时间降序
  list.sort((a, b) => b.createdAt - a.createdAt)

  const total = list.length
  return { notes: list.slice(offset, offset + limit), total }
}

// ── keyword 匹配（供 update/delete 用）──────────────────────────

export interface MatchResult {
  type: 'exact' | 'ambiguous' | 'not_found'
  note?: Note
  candidates?: Note[]
}

/**
 * 按 id 或 keyword 查找笔记
 * id 精确匹配；keyword 模糊匹配，唯一命中直接返回，多条返回候选
 */
export function findNote(opts: { id?: string, keyword?: string }): MatchResult {
  const list = loadNotes()

  // 优先 id 精确匹配
  if (opts.id) {
    const note = list.find(n => n.id === opts.id)
    return note ? { type: 'exact', note } : { type: 'not_found' }
  }

  // keyword 模糊匹配
  if (opts.keyword) {
    const kw = opts.keyword.toLowerCase()
    const matches = list.filter(n =>
      n.content.toLowerCase().includes(kw) ||
      n.tags.some(t => t.toLowerCase().includes(kw))
    ).sort((a, b) => b.createdAt - a.createdAt)

    if (matches.length === 0) return { type: 'not_found' }
    if (matches.length === 1) return { type: 'exact', note: matches[0] }
    return { type: 'ambiguous', candidates: matches.slice(0, 5) }
  }

  return { type: 'not_found' }
}

// ── 数据迁移 ─────────────────────────────────────────────────────

export function migrateOldNotes(): void {
  const oldPath = join(STATE_DIR, 'notes.json')

  // 检查是否需要迁移：旧格式没有 category 字段
  try {
    if (!existsSync(oldPath)) return
    const raw = JSON.parse(readFileSync(oldPath, 'utf8'))
    if (!Array.isArray(raw) || raw.length === 0) return
    // 已经是新格式（有 category）
    if (raw[0]?.category !== undefined) return

    // 迁移：给每条笔记加 category 和 updatedAt
    const migrated: Note[] = raw.map((n: any) => ({
      id: n.id,
      content: n.content,
      category: '默认',
      tags: n.tags || [],
      createdAt: n.createdAt,
      updatedAt: n.createdAt,
    }))
    saveNotes(migrated)
    process.stderr.write(`[note] 迁移完成：${migrated.length} 条旧笔记 → category="默认"\n`)
  } catch (err) {
    process.stderr.write(`[note] 迁移失败: ${err}\n`)
  }
}
