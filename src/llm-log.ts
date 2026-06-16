/**
 * LLM 调用日志 + 费用计算
 *
 * 每次 LLM 调用记录一条 JSONL，支持按时间/模型/会话查询。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

const HOME = process.env.HOME || '/tmp'
const LOG_DIR = join(HOME, 'Projects', 'Lomo', 'state')
const LOG_FILE = join(LOG_DIR, 'llm-logs.jsonl')
const MAX_LOG_LINES = 50000

export interface LlmLogEntry {
  id: string
  ts: string
  sessionId: string
  model: string
  type: 'character' | 'ooc' | 'tool'
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cost: number
  inputPreview?: string   // 用户输入前 100 字，方便识别
  systemPreview?: string  // 系统提示词前 500 字，方便检查
  rawContent?: string     // 含 think 块的原始 LLM 输出
}

// 模型单价（每百万 token 的美元价格）
const MODEL_PRICES: Record<string, { input: number; output: number; cacheRead?: number }> = {
  'deepseek-v4-flash':       { input: 0.15,  output: 0.60, cacheRead: 0.015 },
  'deepseek-v4-pro':         { input: 2.00,  output: 8.00, cacheRead: 0.20  },
  'MiniMax-M3':  { input: 0,     output: 0 },   // 按次计费，非 token 计费
  'mimo-v2.5':               { input: 0.50,  output: 2.00, cacheRead: 0.05  },
  'mimo-v2.5-pro':           { input: 1.50,  output: 6.00, cacheRead: 0.15  },
}

function getModelPrice(model: string): { input: number; output: number; cacheRead?: number } {
  return MODEL_PRICES[model] || { input: 1.00, output: 3.00, cacheRead: 0.10 }
}

export function calcCost(model: string, inputTokens: number, outputTokens: number, cacheReadTokens?: number): number {
  const price = getModelPrice(model)
  // 按次计费的模型（如 MiniMax），不算 token 费用
  if (price.input === 0) return 0

  // 确定缓存读取量：API 返回了就用实际值，否则按 96% 缓存率估算
  const effectiveCacheRead = cacheReadTokens ?? Math.round(inputTokens * 0.96)
  const nonCacheInput = Math.max(0, inputTokens - effectiveCacheRead)
  const cacheReadPrice = price.cacheRead ?? price.input * 0.1

  const inputCost = (nonCacheInput / 1_000_000) * price.input
  const cacheCost = (effectiveCacheRead / 1_000_000) * cacheReadPrice
  const outputCost = (outputTokens / 1_000_000) * price.output

  return Math.round((inputCost + cacheCost + outputCost) * 1_000_000) / 1_000_000
}

// 确保目录存在
function ensureLogDir(): void {
  mkdirSync(LOG_DIR, { recursive: true })
}

export function logLlmCall(entry: Omit<LlmLogEntry, 'id' | 'ts' | 'cost'>): LlmLogEntry {
  ensureLogDir()

  const cost = calcCost(entry.model, entry.inputTokens, entry.outputTokens, entry.cacheReadTokens)
  const logEntry: LlmLogEntry = {
    ...entry,
    id: randomUUID().slice(0, 8),
    ts: new Date().toISOString(),
    cost,
  }

  try {
    appendFileSync(LOG_FILE, JSON.stringify(logEntry) + '\n')
  } catch {}

  // 超过上限时截断：保留后 30000 条
  try {
    if (statLogFile() > MAX_LOG_LINES) {
      trimLogFile()
    }
  } catch {}

  return logEntry
}

function statLogFile(): number {
  try {
    const data = readFileSync(LOG_FILE, 'utf8')
    return data.split('\n').filter(l => l.trim()).length
  } catch { return 0 }
}

function trimLogFile(): void {
  try {
    const data = readFileSync(LOG_FILE, 'utf8')
    const lines = data.split('\n').filter(l => l.trim())
    const keep = lines.slice(-30000)
    writeFileSync(LOG_FILE, keep.join('\n') + '\n')
  } catch {}
}

export function queryLogs(options: {
  limit?: number
  offset?: number
  sessionId?: string
  model?: string
  type?: string
  since?: string   // ISO date
  until?: string
} = {}): { logs: LlmLogEntry[]; total: number } {
  try {
    if (!existsSync(LOG_FILE)) return { logs: [], total: 0 }
    const data = readFileSync(LOG_FILE, 'utf8')
    let entries: LlmLogEntry[] = data.split('\n')
      .filter(l => l.trim())
      .map(l => {
        try { return JSON.parse(l) as LlmLogEntry }
        catch { return null }
      })
      .filter((e): e is LlmLogEntry => e !== null)

    // 过滤
    if (options.sessionId) entries = entries.filter(e => e.sessionId === options.sessionId)
    if (options.model) entries = entries.filter(e => e.model === options.model)
    if (options.type) entries = entries.filter(e => e.type === options.type)
    if (options.since) entries = entries.filter(e => e.ts >= options.since!)
    if (options.until) entries = entries.filter(e => e.ts <= options.until!)

    // 按时间倒序
    entries.sort((a, b) => b.ts.localeCompare(a.ts))

    const total = entries.length
    const offset = options.offset || 0
    const limit = options.limit || 50
    const logs = entries.slice(offset, offset + limit)

    return { logs, total }
  } catch {
    return { logs: [], total: 0 }
  }
}

/** 查询指定会话的总费用 */
export function getSessionCost(sessionId: string): number {
  try {
    if (!existsSync(LOG_FILE)) return 0
    const data = readFileSync(LOG_FILE, 'utf8')
    let total = 0
    for (const line of data.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as LlmLogEntry
        if (entry.sessionId === sessionId) {
          total += entry.cost
        }
      } catch {}
    }
    return Math.round(total * 1000) / 1000
  } catch { return 0 }
}

export function getStats(): {
  totalCalls: number
  totalCost: number
  totalInputTokens: number
  totalOutputTokens: number
  modelBreakdown: Record<string, { calls: number; cost: number; inputTokens: number; outputTokens: number }>
  todayCost: number
  todayCalls: number
} {
  const { logs } = queryLogs({ limit: 0 })
  const today = new Date().toISOString().slice(0, 10)

  const stats = {
    totalCalls: logs.length,
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    todayCost: 0,
    todayCalls: 0,
    modelBreakdown: {} as Record<string, { calls: number; cost: number; inputTokens: number; outputTokens: number }>,
  }

  for (const entry of logs) {
    stats.totalCost += entry.cost
    stats.totalInputTokens += entry.inputTokens
    stats.totalOutputTokens += entry.outputTokens

    if (!stats.modelBreakdown[entry.model]) {
      stats.modelBreakdown[entry.model] = { calls: 0, cost: 0, inputTokens: 0, outputTokens: 0 }
    }
    stats.modelBreakdown[entry.model].calls++
    stats.modelBreakdown[entry.model].cost += entry.cost
    stats.modelBreakdown[entry.model].inputTokens += entry.inputTokens
    stats.modelBreakdown[entry.model].outputTokens += entry.outputTokens

    if (entry.ts.startsWith(today)) {
      stats.todayCost += entry.cost
      stats.todayCalls++
    }
  }

  stats.totalCost = Math.round(stats.totalCost * 1000) / 1000
  stats.todayCost = Math.round(stats.todayCost * 1000) / 1000

  for (const m of Object.keys(stats.modelBreakdown)) {
    stats.modelBreakdown[m].cost = Math.round(stats.modelBreakdown[m].cost * 1000) / 1000
  }

  return stats
}
