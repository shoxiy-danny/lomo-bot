/**
 * Memory Cleanup — 清理评分 + 500 cap 审阅
 *
 * 清理评分（plan § 四）：
 *   score = (365 - days_since_last_access) / 365 * 0.35
 *         + (1 - importance/5) * 0.40
 *         + (1 - confidence) * 0.10
 *         + (pinned ? -1 : 0)
 *   score > 0.5 → 候选删除
 *
 * 500 cap 触发：
 *   达 500 条时 fire-and-forget 调 LLM 审阅（不阻塞新写入）
 *   审阅完成后如果仍满 → 下次写入前 force-clean 1 条最低分记忆
 */

import type { MemoryEntry } from './types'
import { getAll, count, add, updateById, deleteById } from './store'
import { chat } from '../llm/router'

const HARD_CAP = 500

/** 单条记忆的清理评分 */
export function cleanupScore(entry: MemoryEntry): number {
  const daysSince = (Date.now() - new Date(entry.last_accessed_at).getTime()) / (1000 * 60 * 60 * 24)
  const recency = Math.max(0, (365 - daysSince) / 365)
  const impFactor = 1 - entry.importance / 5
  const confFactor = 1 - entry.confidence
  const pinPenalty = entry.pinned ? -1 : 0
  return recency * 0.35 + impFactor * 0.40 + confFactor * 0.10 + pinPenalty
}

/** 当前是否接近 cap（>450 即视为接近） */
export function isNearCap(role: string): boolean {
  return count(role) >= HARD_CAP * 0.9
}

/** 超过 cap 了 */
export function isOverCap(role: string): boolean {
  return count(role) >= HARD_CAP
}

/** 找一条最该删的（最低分）— 不含 pinned */
export function findWorstEntry(role: string): MemoryEntry | null {
  const all = getAll(role)
  if (all.length === 0) return null
  const candidates = all.filter(e => !e.pinned)
  if (candidates.length === 0) return null
  candidates.sort((a, b) => cleanupScore(a) - cleanupScore(b))
  return candidates[0]
}

/**
 * LLM 审阅（fire-and-forget）— 在 500 cap 触发时跑
 * 让 LLM 选 10 条最该删的，按 id 列表返回
 * 不阻塞调用方
 */
export async function llmReviewTop(role: string, model: string): Promise<string[]> {
  const all = getAll(role)
  if (all.length < HARD_CAP) return []

  // 取分数最低的 20 条候选
  const candidates = all
    .map(e => ({ entry: e, score: cleanupScore(e) }))
    .filter(x => !x.entry.pinned)
    .sort((a, b) => a.score - b.score)
    .slice(0, 20)
    .map(x => x.entry)

  if (candidates.length === 0) return []

  const listText = candidates.map((e, i) =>
    `${i + 1}. [${e.id.slice(0, 8)}] [${e.type}] imp=${e.importance} conf=${e.confidence.toFixed(2)} ${e.content.slice(0, 80)}`
  ).join('\n')

  const resp = await chat([
    {
      role: 'system',
      content: '你是一个记忆整理助手。主人有 500 条记忆上限，现在满了。请从以下候选中挑出最该删的 10 条（按 id 前缀识别）。只返回 JSON 数组，元素是 id 字符串。不要解释。',
    },
    {
      role: 'user',
      content: `候选（按清理评分升序）：\n${listText}\n\n返回要删的 id 列表（JSON 数组，最多 10 个）：`,
    },
  ], { model, maxTokens: 256, temperature: 0.1 })

  if (!resp.content) return []
  const jsonText = resp.content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  try {
    const parsed = JSON.parse(jsonText)
    if (Array.isArray(parsed)) {
      return parsed.filter((x: any) => typeof x === 'string').slice(0, 10)
    }
  } catch {}
  return []
}

/**
 * Force clean — 写入前若超过 cap，删 1 条最低分（保底）
 * 只在 write 路径上调用，避免无限增长
 */
export function forceCleanIfOverCap(role: string): void {
  if (!isOverCap(role)) return
  const worst = findWorstEntry(role)
  if (worst) {
    deleteById(role, worst.id)
    process.stderr.write(`[memory/cleanup] force-clean role=${role} id=${worst.id} score=${cleanupScore(worst).toFixed(3)}\n`)
  }
}
