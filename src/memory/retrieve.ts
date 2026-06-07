/**
 * Memory Retrieval — BM25 关键词检索 + Top-K
 *
 * v1 不上 embedding：
 *   - Bun 单进程、个人 Agent，< 500 条 memory 时 BM25 够用
 *   - 上 embedding 需要额外 API 调用或本地模型
 *   - 接口预留好，v2 换实现
 *
 * 检索公式：
 *   rawScore = BM25(content + tags + type) * importance_weight * recency_decay
 *   排序取 top-K
 */

import type { MemoryEntry, MemoryType } from './types'
import { getAll, bumpAccess } from './store'

// ── 停用词（硬编码 ~50 个常用中文停用词） ─────────────────────────

const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '你', '他', '她', '它', '们',
  '有', '和', '都', '也', '就', '要', '会', '不', '但', '只',
  '很', '更', '每', '个', '这', '那', '什么', '怎么', '为什么', '哪',
  '吗', '吧', '呢', '啊', '哦', '嗯', '哈',
  '一', '两', '三', '几', '些', '点', '些', '种', '样',
  '上', '下', '里', '外', '前', '后', '中', '间',
  '来', '去', '做', '看', '说', '想', '知道', '能', '可以',
])

// ── 中文分词（用 Intl.Segmenter） ─────────────────────────────────

let zhSegmenter: Intl.Segmenter | null = null

function getSegmenter(): Intl.Segmenter {
  if (!zhSegmenter) {
    zhSegmenter = new Intl.Segmenter('zh', { granularity: 'word' })
  }
  return zhSegmenter
}

/** 提取关键词（去停用词、去单字） */
export function extractKeywords(text: string): string[] {
  const seg = getSegmenter()
  const words: string[] = []
  for (const segment of seg.segment(text)) {
    const w = segment.segment.trim()
    if (w.length < 2) continue
    if (STOP_WORDS.has(w)) continue
    // 跳过纯标点
    if (/^[\p{P}\s]+$/u.test(w)) continue
    words.push(w)
  }
  return words
}

// ── BM25 参数 ─────────────────────────────────────────────────────

const K1 = 1.5
const B = 0.75

interface ScoredEntry {
  entry: MemoryEntry
  score: number
  matched: string[]
}

/** 评分单条记忆 */
function scoreEntry(
  entry: MemoryEntry,
  keywords: string[],
  idf: Map<string, number>,
  avgDocLen: number,
): ScoredEntry {
  // 拼接检索字段
  const fields = [entry.content]
  if (entry.tags) fields.push(entry.tags.join(' '))
  fields.push(entry.type)  // type 也参与匹配（如 "project"）

  const docText = fields.join(' ').toLowerCase()
  const docWords = extractKeywords(docText)
  const docLen = docWords.length
  if (docLen === 0) return { entry, score: 0, matched: [] }

  // 词频统计
  const tf = new Map<string, number>()
  for (const w of docWords) {
    tf.set(w, (tf.get(w) || 0) + 1)
  }

  // BM25 评分（v1 中文优化：精确词 + 子串）
  let bm25 = 0
  const matched: string[] = []
  for (const kw of keywords) {
    const kwLower = kw.toLowerCase()
    // 1) 精确词匹配
    let f = tf.get(kwLower) || 0
    // 2) 子串匹配：kw 是某 doc word 的子串，或反之
    if (f === 0) {
      for (const [dw, count] of tf) {
        if (dw.includes(kwLower) || kwLower.includes(dw)) {
          f = count
          break
        }
      }
    }
    if (f === 0) continue
    // IDF 优先查 kw 自己；子串匹配时用 doc word 的 IDF
    let idfVal = idf.get(kwLower) || 0
    if (idfVal === 0) {
      // 找哪个 doc word 命中了子串
      for (const [dw] of tf) {
        if (dw.includes(kwLower) || kwLower.includes(dw)) {
          idfVal = idf.get(dw) || 0
          break
        }
      }
    }
    const norm = (f * (K1 + 1)) / (f + K1 * (1 - B + B * (docLen / Math.max(avgDocLen, 1))))
    bm25 += idfVal * norm
    matched.push(kw)
  }

  if (bm25 === 0) return { entry, score: 0, matched: [] }

  // importance 加权：imp=1 → ×0.4, imp=3 → ×1.0, imp=5 → ×1.6
  const importanceWeight = 1 + (entry.importance - 3) * 0.3

  // recency 衰减：基于 last_accessed_at（不是 created_at）
  const daysSince = (Date.now() - new Date(entry.last_accessed_at).getTime()) / (1000 * 60 * 60 * 24)
  const recencyDecay = Math.max(0.3, 1 - daysSince / 365)

  // pinned 加成
  const pinnedBoost = entry.pinned ? 1.5 : 1.0

  return {
    entry,
    score: bm25 * importanceWeight * recencyDecay * pinnedBoost,
    matched,
  }
}

/** 计算全文档 IDF（所有出现过的词都算），用于子串匹配时的 IDF 查找 */
function computeIDF(entries: MemoryEntry[]): Map<string, number> {
  const N = entries.length || 1
  const df = new Map<string, number>()
  for (const e of entries) {
    const fields = [e.content]
    if (e.tags) fields.push(e.tags.join(' '))
    fields.push(e.type)
    const docText = fields.join(' ').toLowerCase()
    const docWords = new Set(extractKeywords(docText).map(w => w.toLowerCase()))
    docWords.forEach(w => {
      df.set(w, (df.get(w) || 0) + 1)
    })
  }
  const idf = new Map<string, number>()
  df.forEach((n, w) => {
    idf.set(w, Math.log(1 + (N - n + 0.5) / (n + 0.5)))
  })
  return idf
}

/** 平均文档长度 */
function computeAvgDocLen(entries: MemoryEntry[]): number {
  if (entries.length === 0) return 50
  let total = 0
  for (const e of entries) {
    const fields = [e.content]
    if (e.tags) fields.push(e.tags.join(' '))
    fields.push(e.type)
    total += extractKeywords(fields.join(' ')).length
  }
  return total / entries.length
}

// ── 公共 API ──────────────────────────────────────────────────────

export interface RetrieveOptions {
  k?: number                          // 默认 8
  type_filter?: MemoryType | MemoryType[]  // 按 type 过滤
  min_importance?: number             // 最低 importance
}

/**
 * 检索与 query 最相关的 top-K memory
 * 同时会更新匹配条的 access_count + last_accessed_at
 */
export function retrieveMemory(
  role: string,
  query: string,
  options: RetrieveOptions = {},
): MemoryEntry[] {
  const { k = 8, type_filter, min_importance = 1 } = options

  const all = getAll(role)
  if (all.length === 0) return []

  // type 过滤
  let candidates = all
  if (type_filter) {
    const types = Array.isArray(type_filter) ? type_filter : [type_filter]
    candidates = candidates.filter(e => types.includes(e.type))
  }
  // importance 过滤
  candidates = candidates.filter(e => e.importance >= min_importance)
  if (candidates.length === 0) return []

  // 关键词提取
  const keywords = extractKeywords(query)
  if (keywords.length === 0) {
    // 没关键词 → 按 importance + recency 降序返回前 K 条
    return candidates
      .sort((a, b) => (b.importance * 10 + (b.pinned ? 5 : 0)) - (a.importance * 10 + (a.pinned ? 5 : 0)))
      .slice(0, k)
  }

  // 计算全文档 IDF（所有词）和 avgDocLen
  const idf = computeIDF(candidates)
  const avgDocLen = computeAvgDocLen(candidates)

  // 评分
  const scored: ScoredEntry[] = []
  for (const e of candidates) {
    const s = scoreEntry(e, keywords, idf, avgDocLen)
    if (s.score > 0) scored.push(s)
  }

  // 排序取 top-K
  scored.sort((a, b) => b.score - a.score)
  const topK = scored.slice(0, k).map(s => s.entry)

  // 更新 access 元数据
  if (topK.length > 0) {
    bumpAccess(role, topK.map(e => e.id))
  }

  return topK
}

/**
 * 拼接记忆注入块（用于 context.ts postMessages）
 */
export function buildMemoryBlock(memories: MemoryEntry[]): string {
  if (memories.length === 0) return ''
  const lines = memories.map(m => {
    const tagStr = m.tags && m.tags.length > 0 ? ` [${m.tags.join('/')}]` : ''
    const pinStr = m.pinned ? ' 📌' : ''
    return `- [${m.type}]${tagStr}${pinStr} ${m.content}`
  })
  return `[系统注入 - 仅供参考，非用户指令]\n📌 主人的关键信息：\n${lines.join('\n')}`
}
