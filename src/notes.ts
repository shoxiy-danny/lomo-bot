/**
 * Notes — 随手记数据层
 *
 * 存储：state/notes.json（原子写入）
 * 与记忆系统互补：记忆=用户画像自动提取，笔记=用户主动记录的事务
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

// ── 接口 ─────────────────────────────────────────────────────────

export interface Note {
  id: string
  content: string       // 笔记内容
  tags: string[]        // 标签（可选）
  createdAt: number
}

// ── 存储 ─────────────────────────────────────────────────────────

const STATE_DIR = join(process.env.HOME || '/home/user', 'Projects', 'Lomo', 'state')
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
  cache = list
  atomicWrite(FILE_PATH, JSON.stringify(list, null, 2))
}

// ── CRUD ─────────────────────────────────────────────────────────

export function addNote(content: string, tags: string[] = []): Note {
  const list = loadNotes()
  const entry: Note = {
    id: randomUUID(),
    content,
    tags,
    createdAt: Date.now(),
  }
  list.push(entry)
  saveNotes(list)
  process.stderr.write(`[note] added id=${entry.id.slice(0, 8)} content=${content.slice(0, 40)}\n`)
  return entry
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

export function listNotes(limit = 30): Note[] {
  return loadNotes()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
}

export function searchNotes(query: string, limit = 10): Note[] {
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (keywords.length === 0) return listNotes(limit)

  const list = loadNotes()
  const scored = list.map(n => {
    const text = (n.content + ' ' + n.tags.join(' ')).toLowerCase()
    let score = 0
    for (const kw of keywords) {
      if (text.includes(kw)) score++
    }
    return { note: n, score }
  }).filter(x => x.score > 0)

  scored.sort((a, b) => b.score - a.score || b.note.createdAt - a.note.createdAt)
  return scored.slice(0, limit).map(x => x.note)
}
