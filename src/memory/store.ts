/**
 * Memory Store — memory.json 读写 + 内存缓存 + 原子写
 *
 * 设计要点：
 *   - 内存缓存：避免每次读盘
 *   - 原子写：先写 .tmp 再 rename，防止写一半挂掉损坏文件
 *   - 目录懒创建：第一次写时才 mkdir
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import type { MemoryEntry } from './types'
import { roleId } from './types'

const STATE_ROOT = join(
  process.env.HOME || '/home/user',
  'Projects', 'Lomo', 'state', 'memory',
)

function memoryDir(role: string): string {
  return join(STATE_ROOT, roleId(role))
}

function memoryFile(role: string): string {
  return join(memoryDir(role), 'memory.json')
}

// ── 内存缓存（role → entries） ─────────────────────────────────────

const cache = new Map<string, MemoryEntry[]>()
const loadedRoles = new Set<string>()

function loadFromDisk(role: string): MemoryEntry[] {
  const file = memoryFile(role)
  if (!existsSync(file)) return []
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(data)) return []
    return data
  } catch (err) {
    console.error(`[memory/store] ${role}/memory.json 损坏: ${err}`)
    return []
  }
}

function ensureLoaded(role: string): void {
  if (loadedRoles.has(role)) return
  const entries = loadFromDisk(role)
  cache.set(role, entries)
  loadedRoles.add(role)
}

function ensureDir(role: string): void {
  const dir = memoryDir(role)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function atomicWrite(filePath: string, content: string): void {
  const tmpPath = filePath + '.tmp'
  writeFileSync(tmpPath, content, { mode: 0o600 })
  renameSync(tmpPath, filePath)
}

// ── 公共 API ──────────────────────────────────────────────────────

/** 读取所有 memory（带缓存） */
export function getAll(role: string): MemoryEntry[] {
  ensureLoaded(role)
  return cache.get(role) || []
}

/** 直接读盘（绕过缓存，用于管理后台等场景） */
export function getAllFresh(role: string): MemoryEntry[] {
  const entries = loadFromDisk(role)
  cache.set(role, entries)
  loadedRoles.add(role)
  return entries
}

/** 全量覆盖写入（原子写） */
export function setAll(role: string, entries: MemoryEntry[]): void {
  ensureDir(role)
  cache.set(role, entries)
  loadedRoles.add(role)
  atomicWrite(memoryFile(role), JSON.stringify(entries, null, 2) + '\n')
}

/** 新增一条 */
export function add(role: string, entry: MemoryEntry): void {
  const all = getAll(role)
  all.push(entry)
  setAll(role, all)
}

/** 按 id 查找 */
export function findById(role: string, id: string): MemoryEntry | undefined {
  return getAll(role).find(e => e.id === id)
}

/** 按 id 更新（部分字段） */
export function updateById(
  role: string,
  id: string,
  patch: Partial<MemoryEntry>,
): MemoryEntry | null {
  const all = getAll(role)
  const idx = all.findIndex(e => e.id === id)
  if (idx < 0) return null
  all[idx] = { ...all[idx], ...patch, last_accessed_at: new Date().toISOString() }
  setAll(role, all)
  return all[idx]
}

/** 按 id 删除 */
export function deleteById(role: string, id: string): boolean {
  const all = getAll(role)
  const idx = all.findIndex(e => e.id === id)
  if (idx < 0) return false
  all.splice(idx, 1)
  setAll(role, all)
  return true
}

/** 更新 access 元数据（用于检索时打点） */
export function bumpAccess(role: string, ids: string[]): void {
  if (ids.length === 0) return
  const all = getAll(role)
  const idSet = new Set(ids)
  const now = new Date().toISOString()
  let changed = false
  for (const e of all) {
    if (idSet.has(e.id)) {
      e.access_count += 1
      e.last_accessed_at = now
      changed = true
    }
  }
  if (changed) setAll(role, all)
}

/** 当前条数 */
export function count(role: string): number {
  return getAll(role).length
}
