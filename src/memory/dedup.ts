/**
 * 写入前去重 + 冲突检测
 *
 * v1 简化版：基于关键词重叠度（与 retrieve.ts 共享 Intl.Segmenter）
 *  - 高重叠（>0.7）→ SKIP（与已有记忆重复）
 *  - 中重叠（0.3~0.7）且同 type → UPDATE（更新重要性 + 合并 access_count）
 *  - 低重叠（<0.3）或不同 type → NEW（直接新增）
 *  - 同主题矛盾 → CONFLICT（用 supersedes 标记）
 *
 * v2 可升级：把候选 + 新条目喂给 LLM，让 LLM 决定 skip/update/create/conflict
 */

import type { MemoryEntry, MemoryType } from './types'
import { getAll } from './store'
import { extractKeywords } from './retrieve'

export type DedupDecision =
  | { action: 'skip'; reason: string; existingId: string }
  | { action: 'update'; reason: string; existingId: string; patch: Partial<MemoryEntry> }
  | { action: 'conflict'; reason: string; existingId: string; patch: Partial<MemoryEntry> }
  | { action: 'new'; reason: string }

interface DedupInput {
  type: MemoryType
  content: string
  tags?: string[]
}

const SKIP_THRESHOLD = 0.7
const UPDATE_THRESHOLD = 0.5  // 提到 0.5 避免误并入不相关同 type 条目

/** 计算两个文本的关键词 Jaccard 相似度 */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const sa = new Set(a)
  const sb = new Set(b)
  let inter = 0
  for (const w of sa) if (sb.has(w)) inter++
  const union = sa.size + sb.size - inter
  return union === 0 ? 0 : inter / union
}

/** 提条目的检索字段关键词 */
function entryKeywords(e: MemoryEntry): string[] {
  const parts = [e.content]
  if (e.tags) parts.push(e.tags.join(' '))
  return extractKeywords(parts.join(' '))
}

/**
 * 决定新条目是 skip / update / conflict / new
 * 同 type 才有意义（不同 type 一定 NEW）
 */
export function checkDedup(
  role: string,
  input: DedupInput,
): DedupDecision {
  const all = getAll(role)
  if (all.length === 0) return { action: 'new', reason: '尚无记忆' }

  const newKw = extractKeywords([input.content, ...(input.tags || [])].join(' '))
  if (newKw.length === 0) return { action: 'new', reason: '无关键词' }

  let bestScore = 0
  let bestEntry: MemoryEntry | null = null
  for (const e of all) {
    const ek = entryKeywords(e)
    const score = jaccard(newKw, ek)
    if (score > bestScore) {
      bestScore = score
      bestEntry = e
    }
  }

  if (!bestEntry || bestScore < UPDATE_THRESHOLD) {
    return { action: 'new', reason: `最高相似度 ${bestScore.toFixed(2)}，低于阈值` }
  }

  // 同 type 才有 skip/update 价值
  if (bestEntry.type === input.type) {
    if (bestScore >= SKIP_THRESHOLD) {
      return {
        action: 'skip',
        reason: `与 [${bestEntry.type}] ${bestEntry.id.slice(0, 8)} 高度重复 (${bestScore.toFixed(2)})`,
        existingId: bestEntry.id,
      }
    }
    // 中等相似度：更新重要性 + 提升 confidence
    return {
      action: 'update',
      reason: `与已有 ${bestEntry.type} 相关 (${bestScore.toFixed(2)})，合并 importance`,
      existingId: bestEntry.id,
      patch: {
        importance: Math.min(5, bestEntry.importance + 1) as 1 | 2 | 3 | 4 | 5,
        confidence: Math.min(1, (bestEntry.confidence + 0.1)),
        last_accessed_at: new Date().toISOString(),
      },
    }
  }

  // 不同 type 但关键词重叠：判定为冲突（新记忆覆盖旧主题）
  if (bestScore >= SKIP_THRESHOLD) {
    return {
      action: 'conflict',
      reason: `与 [${bestEntry.type}] 主题冲突 (${bestScore.toFixed(2)})，标记 supersedes`,
      existingId: bestEntry.id,
      patch: {}, // 不修改旧的，只在新增时引用
    }
  }

  return { action: 'new', reason: `跨 type 主题，相似度 ${bestScore.toFixed(2)} 不足` }
}
