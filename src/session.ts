/**
 * Session 数据模型 + JSON 文件持久化
 *
 * 每个 session 对应一个场景/角色，存为独立 JSON 文件。
 * 存档（saves）是 message_index 快照，不复制消息。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

// ── 数据模型 ──────────────────────────────────────────────────────

export interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  ts: string
  voiceStyle?: string   // 从 LLM 回复中提取的括号情感
}

export interface Save {
  id: string
  label: string
  messageIndex: number
  ts: string
}

export interface PendingMijiaAction {
  id: string
  name: string
  prop: string
  value: string
  // 用户说的自然语言描述（如"开灯"、"调亮 30%"）
  intent?: string
  // 人类可读的动作描述
  description: string
  // 创建时间戳（ms）
  createdAt: number
  // 过期时间戳（ms，默认 5 分钟）
  expireAt: number
}

export interface Session {
  id: string
  name: string
  // 角色设定
  characterName: string
  characterPrompt: string
  scenePrompt: string
  // 用户信息
  userName: string
  // 语音配置
  voice: string          // MiMo TTS 音色 (mimo_default/冰糖/茉莉/...)
  voiceStyle: string     // 默认情感风格
  // 模型配置
  model: string
  // 对话历史
  messages: Message[]
  // 存档
  saves: Save[]
  // 元数据
  createdAt: string
  updatedAt: string
  // 最后活跃时间（用于会话结束检测，ISO 字符串）
  lastActivityAt?: string
  // 最近一次 LLM 调用返回的真实上下文 token 数（来自 usage.prompt_tokens）
  contextTokens?: number
  // Core Profile 冻结字符串（session 内不变，保证缓存命中）
  profileText?: string
  // 日记冻结字符串（session 内不变，保证缓存命中）
  diaryText?: string
  // 记忆块冻结字符串（session 内不变，保证缓存命中）
  memoryText?: string
  // 待用户确认的米家操作（confirm 机制用）
  pendingMijiaActions?: PendingMijiaAction[]
}

// ── 存储路径 ──────────────────────────────────────────────────────

const STATE_DIR = join(
  process.env.HOME || '/tmp',
  'Projects', 'Lomo', 'state', 'sessions',
)

function ensureDir(): void {
  mkdirSync(STATE_DIR, { recursive: true })
}

// ── CRUD ──────────────────────────────────────────────────────────

export function createSession(
  characterName: string,
  characterPrompt: string,
  scenePrompt: string,
  voice = 'mimo_default',
  voiceStyle = 'gentle',
  model = 'MiniMax-M3',
  userName = 'User',
): Session {
  const now = new Date().toISOString()
  const session: Session = {
    id: randomUUID(),
    name: characterName,
    characterName,
    characterPrompt,
    scenePrompt,
    userName,
    voice,
    voiceStyle,
    model,
    messages: [],
    saves: [],
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  }
  return session
}

export function saveSession(session: Session): void {
  ensureDir()
  session.updatedAt = new Date().toISOString()
  const path = join(STATE_DIR, `${session.id}.json`)
  writeFileSync(path, JSON.stringify(session, null, 2) + '\n', { mode: 0o600 })
}

export function loadSession(id: string): Session | null {
  const path = join(STATE_DIR, `${id}.json`)
  if (!existsSync(path)) return null
  return migrateSession(JSON.parse(readFileSync(path, 'utf8')))
}

function migrateSession(s: any): Session {
  if (!s.userName) s.userName = 'User'
  if (!s.lastActivityAt) s.lastActivityAt = s.updatedAt || new Date().toISOString()
  return s as Session
}

export function listSessions(): Session[] {
  ensureDir()
  return readdirSync(STATE_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        return migrateSession(JSON.parse(readFileSync(join(STATE_DIR, f), 'utf8')))
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
}

export function deleteSession(id: string): boolean {
  const path = join(STATE_DIR, `${id}.json`)
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}

// ── 存档操作 ──────────────────────────────────────────────────────

export function createSave(session: Session, label: string): Save {
  const save: Save = {
    id: randomUUID(),
    label,
    messageIndex: session.messages.length,
    ts: new Date().toISOString(),
  }
  session.saves.push(save)
  saveSession(session)
  return save
}

export function loadSave(session: Session, saveId: string): boolean {
  const save = session.saves.find(s => s.id === saveId || s.label === saveId)
  if (!save) return false
  session.messages = session.messages.slice(0, save.messageIndex)
  saveSession(session)
  return true
}

export function deleteSave(session: Session, saveId: string): boolean {
  const idx = session.saves.findIndex(s => s.id === saveId || s.label === saveId)
  if (idx < 0) return false
  session.saves.splice(idx, 1)
  saveSession(session)
  return true
}
