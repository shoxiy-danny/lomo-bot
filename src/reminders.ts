/**
 * Reminders — 一次性提醒 + 定时任务的数据层 + cron 解析
 *
 * 存储：state/reminders.json（原子写入）
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

// ── 接口 ─────────────────────────────────────────────────────────

export interface Reminder {
  id: string
  chatId: string        // 飞书 chatId（oc_xxx）
  role: string          // 角色名
  delivery: 'fixed' | 'bot_private'  // fixed=发到固定chatId, bot_private=动态查找bot私聊
  type: 'once' | 'cron'
  text?: string         // once: 提醒文字
  label?: string        // 标签（列表展示用）
  prompt?: string       // cron: LLM 执行指令
  cron?: string         // cron 表达式
  model?: string        // cron 任务执行模型
  preCheck?: string     // 脚本预检：bash 命令；输出以 SILENCE 开头→跳过 LLM，否则输出注入 prompt
  fireAt: number        // 下次触发时间戳 ms
  enabled: boolean
  createdAt: number
  lastFiredAt?: number
}

// ── 存储 ─────────────────────────────────────────────────────────

const STATE_DIR = join(process.env.HOME || '/home/user', 'Projects', 'Lomo', 'state')
const FILE_PATH = join(STATE_DIR, 'reminders.json')

function atomicWrite(filePath: string, content: string): void {
  const dir = join(filePath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmpPath = filePath + '.tmp'
  writeFileSync(tmpPath, content, { mode: 0o600 })
  renameSync(tmpPath, filePath)
}

export function loadReminders(): Reminder[] {
  try {
    if (!existsSync(FILE_PATH)) return []
    return JSON.parse(readFileSync(FILE_PATH, 'utf8')) as Reminder[]
  } catch {
    return []
  }
}

export function saveReminders(list: Reminder[]): void {
  atomicWrite(FILE_PATH, JSON.stringify(list, null, 2))
}

// ── CRUD ─────────────────────────────────────────────────────────

export function addReminder(r: Omit<Reminder, 'id' | 'createdAt'>): Reminder {
  const list = loadReminders()
  const entry: Reminder = {
    ...r,
    id: randomUUID(),
    createdAt: Date.now(),
  }
  list.push(entry)
  saveReminders(list)
  const fireAtBeijing = new Date(entry.fireAt).toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
  process.stderr.write(`[reminder] added ${entry.type} id=${entry.id.slice(0, 8)} fireAt=${fireAtBeijing}\n`)
  return entry
}

export function deleteReminder(id: string): boolean {
  const list = loadReminders()
  const idx = list.findIndex(r => r.id === id)
  if (idx === -1) return false
  list.splice(idx, 1)
  saveReminders(list)
  process.stderr.write(`[reminder] deleted id=${id.slice(0, 8)}\n`)
  return true
}

export function listReminders(chatId?: string): Reminder[] {
  const list = loadReminders()
  if (!chatId) return list
  return list.filter(r => r.chatId === chatId)
}

export function getDueReminders(): Reminder[] {
  const now = Date.now()
  const todayBeijing = new Date(now + 8 * 3600_000).toISOString().slice(0, 10)
  return loadReminders().filter(r => {
    if (!r.enabled || r.fireAt > now) return false
    // cron 防重复：今天已 fire 过的跳过
    if (r.type === 'cron' && r.lastFiredAt) {
      const lastDay = new Date(r.lastFiredAt + 8 * 3600_000).toISOString().slice(0, 10)
      if (lastDay === todayBeijing) return false
    }
    return true
  })
}

export function updateReminder(id: string, patch: Partial<Pick<Reminder, 'text' | 'label' | 'prompt' | 'cron' | 'model' | 'fireAt' | 'enabled' | 'preCheck'>>): Reminder | null {
  const list = loadReminders()
  const r = list.find(x => x.id === id)
  if (!r) return null
  Object.assign(r, patch)
  // 如果改了 cron，重新计算 fireAt
  if (patch.cron && r.type === 'cron') {
    r.fireAt = nextCronTime(r.cron, Date.now())
  }
  saveReminders(list)
  process.stderr.write(`[reminder] updated id=${id.slice(0, 8)} keys=${Object.keys(patch).join(',')}\n`)
  return r
}

/** 清理已禁用超过 24 小时的 once 提醒 */
export function cleanupExpired(): number {
  const list = loadReminders()
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  const before = list.length
  const kept = list.filter(r => !(r.type === 'once' && !r.enabled && r.lastFiredAt && r.lastFiredAt < cutoff))
  if (kept.length < before) {
    saveReminders(kept)
    process.stderr.write(`[reminder] cleanup: ${before} -> ${kept.length} (removed ${before - kept.length} expired)\n`)
  }
  return before - kept.length
}

export function markFired(id: string, nextFireAt?: number): void {
  // 原子操作：直接读文件 → 改 → 写，不经过可能过期的内存缓存
  const raw = readFileSync(FILE_PATH, 'utf8')
  const list = JSON.parse(raw) as Reminder[]
  const r = list.find(x => x.id === id)
  if (!r) return
  r.lastFiredAt = Date.now()
  if (nextFireAt) {
    r.fireAt = nextFireAt
  } else {
    r.enabled = false  // once 提醒：禁用
  }
  atomicWrite(FILE_PATH, JSON.stringify(list, null, 2))
}

// ── cron 解析 ────────────────────────────────────────────────────

function matchField(field: string, value: number): boolean {
  if (field === '*') return true

  // 逗号分隔：1,3,5
  for (const part of field.split(',')) {
    if (matchSingle(part.trim(), value)) return true
  }
  return false
}

function matchSingle(part: string, value: number): boolean {
  // */N
  const stepMatch = part.match(/^\*\/(\d+)$/)
  if (stepMatch) return value % parseInt(stepMatch[1]) === 0

  // 范围：1-5
  const rangeMatch = part.match(/^(\d+)-(\d+)$/)
  if (rangeMatch) {
    const lo = parseInt(rangeMatch[1])
    const hi = parseInt(rangeMatch[2])
    return value >= lo && value <= hi
  }

  // 范围 + step：1-5/2
  const rangeStepMatch = part.match(/^(\d+)-(\d+)\/(\d+)$/)
  if (rangeStepMatch) {
    const lo = parseInt(rangeStepMatch[1])
    const hi = parseInt(rangeStepMatch[2])
    const step = parseInt(rangeStepMatch[3])
    return value >= lo && value <= hi && (value - lo) % step === 0
  }

  // 固定数字
  return parseInt(part) === value
}

export function matchesCron(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false

  const [min, hour, dom, month, dow] = fields
  // getUTCHours/getUTCMinutes 不对，需要 UTC+8
  const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000)

  return matchField(min, utc8.getUTCMinutes())
    && matchField(hour, utc8.getUTCHours())
    && matchField(dom, utc8.getUTCDate())
    && matchField(month, utc8.getUTCMonth() + 1)
    && matchField(dow, utc8.getUTCDay())
}

export function nextCronTime(expr: string, after: number): number {
  // 从 after 后 1 分钟开始，每分钟步进
  let t = after + 60_000
  const deadline = after + 365 * 86400_000
  while (t < deadline) {
    if (matchesCron(expr, new Date(t))) return t
    t += 60_000
  }
  throw new Error('cron: no match within 365 days')
}
