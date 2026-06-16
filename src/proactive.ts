/**
 * Proactive Messaging — Lomo 主动消息状态管理
 *
 * v1.0 设计：统一单次 LLM 调用，全量 session 上下文
 *
 * 原则：
 *   - SILENCE 是正当选择，不发也是常态
 *   - 硬兜底只防系统性风险（10/h、30/d）
 *   - 兜底永远不影响主人主动找 Lomo
 *   - topic 摘要做去重（不上 embedding）
 *
 * 存储：state/proactive.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const HOME = process.env.HOME || '/tmp'
const STATE_DIR = join(HOME, 'Projects', 'Lomo', 'state')
const PROACTIVE_FILE = join(STATE_DIR, 'proactive.json')

// ── 硬兜底阈值（可调整） ─────────────────────────────────────────

export const HARD_LIMITS = {
  /** 单小时条数（防刷屏） */
  MAX_PER_HOUR: 10,
  /** 单日条数（防失控） */
  MAX_PER_DAY: 30,
  /** 触发后暂停小时数 */
  PAUSE_HOURS: 6,
}

// ── 类型 ──────────────────────────────────────────────────────────

export type ProactiveState = 'IDLE' | 'SENT_AWAIT' | 'SENT_FOLLOWUP'

export type HistoryAction = 'send' | 'silence' | 'paused' | 'user_reply' | 'invalid'

export interface ProactiveHistoryItem {
  at: string
  action: HistoryAction
  reason?: string
}

export interface ProactiveRecord {
  state: ProactiveState
  daily_count: number
  daily_silence_count: number
  daily_reset_date: string  // YYYY-MM-DD
  last_check_at: string
  last_proactive_at: string
  last_proactive_content: string
  last_proactive_topic: string
  recent_topics: string[]
  paused_until: string
  recent_history: ProactiveHistoryItem[]
}

// ── 默认值 ────────────────────────────────────────────────────────

function defaultProactive(): ProactiveRecord {
  return {
    state: 'IDLE',
    daily_count: 0,
    daily_silence_count: 0,
    daily_reset_date: new Date().toISOString().slice(0, 10),
    last_check_at: '',
    last_proactive_at: '',
    last_proactive_content: '',
    last_proactive_topic: '',
    recent_topics: [],
    paused_until: '',
    recent_history: [],
  }
}

// ── 加载/保存 ─────────────────────────────────────────────────────

export function loadProactive(): ProactiveRecord {
  try {
    if (!existsSync(PROACTIVE_FILE)) return defaultProactive()
    const raw = readFileSync(PROACTIVE_FILE, 'utf8')
    const data = JSON.parse(raw) as ProactiveRecord
    // 跨日重置
    const today = new Date().toISOString().slice(0, 10)
    if (data.daily_reset_date !== today) {
      data.daily_count = 0
      data.daily_silence_count = 0
      data.daily_reset_date = today
    }
    return data
  } catch {
    return defaultProactive()
  }
}

export function saveProactive(record: ProactiveRecord): void {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(PROACTIVE_FILE, JSON.stringify(record, null, 2) + '\n')
}

// ── 硬兜底检查 ─────────────────────────────────────────────────────

export interface LimitCheckResult {
  allowed: boolean
  reason?: string
}

export function checkHardLimit(record: ProactiveRecord): LimitCheckResult {
  // 1. 暂停期未过
  if (record.paused_until && new Date(record.paused_until) > new Date()) {
    return { allowed: false, reason: `paused_until_${record.paused_until}` }
  }

  // 2. 单日上限
  if (record.daily_count >= HARD_LIMITS.MAX_PER_DAY) {
    return { allowed: false, reason: `daily_limit_${record.daily_count}` }
  }

  // 3. 单小时上限（统计 recent_history 里 1h 内的 send 次数）
  const oneHourAgo = Date.now() - 3600_000
  const recentSends = record.recent_history.filter(
    h => h.action === 'send' && new Date(h.at).getTime() > oneHourAgo
  ).length
  if (recentSends >= HARD_LIMITS.MAX_PER_HOUR) {
    return { allowed: false, reason: `hourly_limit_${recentSends}` }
  }

  return { allowed: true }
}

// ── 状态转换 ──────────────────────────────────────────────────────

/** 记录一次主动发送成功 */
export function recordSend(record: ProactiveRecord, content: string, topic: string): ProactiveRecord {
  const now = new Date().toISOString()
  return {
    ...record,
    state: 'IDLE',
    daily_count: record.daily_count + 1,
    last_proactive_at: now,
    last_proactive_content: content,
    last_proactive_topic: topic,
    recent_topics: [topic, ...record.recent_topics].slice(0, 5),
    last_check_at: now,
    recent_history: [
      { at: now, action: 'send' },
      ...record.recent_history.slice(0, 19),
    ],
  }
}

/** 记录 LLM 决定沉默 */
export function recordSilence(record: ProactiveRecord, reason: string): ProactiveRecord {
  const now = new Date().toISOString()
  return {
    ...record,
    state: 'IDLE',
    daily_silence_count: record.daily_silence_count + 1,
    last_check_at: now,
    recent_history: [
      { at: now, action: 'silence', reason },
      ...record.recent_history.slice(0, 19),
    ],
  }
}

/** 记录无效输出（格式异常等） */
export function recordInvalid(record: ProactiveRecord, reason: string): ProactiveRecord {
  const now = new Date().toISOString()
  return {
    ...record,
    last_check_at: now,
    recent_history: [
      { at: now, action: 'invalid', reason },
      ...record.recent_history.slice(0, 19),
    ],
  }
}

/** 记录用户回复 */
export function recordUserReply(record: ProactiveRecord): ProactiveRecord {
  return {
    ...record,
    state: 'IDLE',
    last_check_at: new Date().toISOString(),
    recent_history: [
      { at: new Date().toISOString(), action: 'user_reply' },
      ...record.recent_history.slice(0, 19),
    ],
  }
}

/** 触顶暂停 */
export function triggerPause(record: ProactiveRecord, reason: string): ProactiveRecord {
  const pausedUntil = new Date(Date.now() + HARD_LIMITS.PAUSE_HOURS * 3600_000).toISOString()
  return {
    ...record,
    state: 'IDLE',
    paused_until: pausedUntil,
    recent_history: [
      { at: new Date().toISOString(), action: 'paused', reason: `${reason} | until ${pausedUntil}` },
      ...record.recent_history.slice(0, 19),
    ],
  }
}

// ── 决策辅助 ──────────────────────────────────────────────────────

/** 是否该触发主动决策 tick */
export function shouldTriggerProactiveCheck(
  record: ProactiveRecord,
  minIntervalMin: number = 20,
  jitterMin: number = 30,
): boolean {
  // 暂停期
  if (record.paused_until && new Date(record.paused_until) > new Date()) {
    return false
  }
  // 距上次检查时间
  if (!record.last_check_at) return true
  const elapsed = Date.now() - new Date(record.last_check_at).getTime()
  const required = (minIntervalMin + Math.random() * jitterMin) * 60_000
  return elapsed >= required
}

/** 给 LLM 触发消息的统计上下文 */
export function buildDecisionContext(record: ProactiveRecord): string {
  const lines: string[] = []
  if (record.daily_count > 0) {
    lines.push(`今天你已经主动发了 ${record.daily_count} 条`)
  }
  if (record.daily_silence_count > 0) {
    lines.push(`今天你已经沉默了 ${record.daily_silence_count} 次`)
  }
  if (record.last_proactive_at) {
    const min = Math.round((Date.now() - new Date(record.last_proactive_at).getTime()) / 60000)
    lines.push(`距上次主动过去了 ${min} 分钟`)
  }
  if (record.last_proactive_content) {
    lines.push(`上次主动的内容："${record.last_proactive_content.slice(0, 80)}"`)
  }
  if (record.recent_topics.length > 0) {
    lines.push(`最近主动的话题：${record.recent_topics.join('、')}`)
  }
  if (record.paused_until) {
    lines.push(`当前暂停至：${record.paused_until}（不应触发）`)
  }
  return lines.join('\n')
}
