/**
 * 异步记忆提取 Worker
 *
 * 触发来源：
 *   1. OOC "记一下"/"别忘了" → 立即 enqueue 单条
 *   2. 每 10 轮对话消息累积 → 批量 enqueue 一组
 *   3. 会话结束 → 整段会话 enqueue
 *
 * 处理流程：
 *   1. 5s 轮询队列
 *   2. 取出任务 → 调 LLM 提取事实（用结构化 prompt）
 *   3. 对每条事实 → 调 checkDedup() → skip / update / new / conflict
 *   4. 写入 store
 *
 * 设计原则：fire-and-forget，绝不阻塞对话响应
 */

import type { Message } from '../session'
import { chat } from '../llm/router'
import { add, updateById, count } from './store'
import { checkDedup } from './dedup'
import { forceCleanIfOverCap } from './cleanup'
import { createMemoryEntry, type MemoryType } from './types'

// ── 任务队列 ─────────────────────────────────────────────────────

export interface ExtractJob {
  id: string
  role: string                 // 角色 id = session.characterName
  model: string                // 用哪个模型做提取（通常用便宜的 dsf）
  reason: 'ooc' | 'batch10' | 'session_end'
  messages: Message[]          // 要分析的消息
  createdAt: number
}

const queue: ExtractJob[] = []
let pollingTimer: ReturnType<typeof setInterval> | null = null
let processing = false

/** 入队 */
export function enqueueExtract(job: Omit<ExtractJob, 'id' | 'createdAt'>): void {
  queue.push({
    ...job,
    id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
  })
  // 用 stderr 绕过 Bun stdout 缓冲
  process.stderr.write(`[memory/worker] enqueue role=${job.role} reason=${job.reason} queue=${queue.length}\n`)
  startPolling()
}

/** 队列长度（供 /status / 调试用） */
export function queueSize(): number {
  return queue.length
}

/** 启动 5s 轮询（幂等） */
function startPolling(): void {
  if (pollingTimer) return
  pollingTimer = setInterval(() => {
    if (processing) return
    if (queue.length === 0) {
      stopPolling()
      return
    }
    void processNext()
  }, 5_000)
}

function stopPolling(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer)
    pollingTimer = null
  }
}

// ── 处理单条任务 ──────────────────────────────────────────────────

const EXTRACT_SYSTEM = `你是一个结构化信息提取器。
从用户的对话历史中提取关于"主人"的关键事实，按 JSON 数组返回。

每条事实结构：
{
  "type": "identity" | "preference" | "relationship" | "goal" | "project" | "event",
  "content": "1-3 句中文描述",
  "importance": 1-5 (默认 3，主人特别强调的可 4-5),
  "confidence": 0-1 (默认 0.8),
  "tags": "逗号分隔的标签，可选"
}

提取准则：
- 只提取持久性事实（偏好/习惯/项目/关系/目标/重要事件），不提取一次性聊天
- 主语默认为"主人"或具体名字（不要用"用户"）
- importance: 5=核心身份/长期项目；4=强偏好/重要联系人；3=普通事实；2=临时信息；1=闲聊
- importance=1-2 的闲聊/临时信息不要提取，直接忽略
- 如果对话只是日常寒暄、开玩笑、闲聊，返回空数组 []
- 没有可提取的就返回空数组 []
- 严格 JSON 输出，不要任何解释文字，不要 markdown 代码块`

async function processNext(): Promise<void> {
  processing = true
  const job = queue.shift()!
  try {
    process.stderr.write(`[memory/worker] process job=${job.id} role=${job.role} reason=${job.reason} msgs=${job.messages.length}\n`)

    const conversationText = job.messages
      .map(m => `[${m.role}] ${m.content}`)
      .join('\n')

    const resp = await chat([
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: `请从以下对话中提取关于主人的关键事实：\n\n${conversationText}` },
    ], {
      model: job.model,
      maxTokens: 1024,
      temperature: 0.2,  // 提取任务要稳定
    })

    if (!resp.content) {
      console.log(`[memory/worker] job=${job.id} LLM 返回空`)
      return
    }

    // 解析 LLM 输出（容错：可能含 markdown ```json ``` 包裹）
    const jsonText = resp.content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
    let facts: any[] = []
    try {
      const parsed = JSON.parse(jsonText)
      facts = Array.isArray(parsed) ? parsed : []
    } catch (err: any) {
      console.warn(`[memory/worker] job=${job.id} 解析失败: ${err.message}\n原始输出: ${jsonText.slice(0, 200)}`)
      return
    }

    if (facts.length === 0) {
      console.log(`[memory/worker] job=${job.id} 无新事实`)
      return
    }

    // 去重 + 写入
    let added = 0, updated = 0, skipped = 0
    for (const f of facts) {
      if (!f.type || !f.content) continue
      if ((f.importance ?? 3) < 3) continue  // 只保留 importance >= 3
      const tagsArr = f.tags ? String(f.tags).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined
      const decision = checkDedup(job.role, {
        type: f.type as MemoryType,
        content: String(f.content),
        tags: tagsArr,
      })
      if (decision.action === 'skip') { skipped++; continue }
      if (decision.action === 'update' && decision.patch) {
        updateById(job.role, decision.existingId, decision.patch)
        updated++
        continue
      }
      // NEW 或 CONFLICT
      const entry = createMemoryEntry({
        type: f.type as MemoryType,
        content: String(f.content),
        importance: (f.importance ?? 3) as 1 | 2 | 3 | 4 | 5,
        confidence: typeof f.confidence === 'number' ? f.confidence : 0.8,
        tags: tagsArr,
        ...(decision.action === 'conflict' ? { supersedes: decision.existingId } : {}),
      })
      // 写入前 force-clean（如超 cap）
      forceCleanIfOverCap(job.role)
      add(job.role, entry)
      added++
    }

    process.stderr.write(`[memory/worker] job=${job.id} done: added=${added} updated=${updated} skipped=${skipped}\n`)
  } catch (err: any) {
    console.error(`[memory/worker] job=${job.id} error: ${err.message}`)
  } finally {
    processing = false
  }
}

// ── 便捷 API ─────────────────────────────────────────────────────

/** 立即 enqueue 一段会话（会话结束时调用） */
export function enqueueSessionEnd(role: string, model: string, messages: Message[]): void {
  if (messages.length === 0) return
  enqueueExtract({ role, model, reason: 'session_end', messages })
}

/** 每 10 轮批量 enqueue 一次（供 server.ts 在消息累积时调用） */
export function enqueueBatch10(role: string, model: string, messages: Message[]): void {
  if (messages.length === 0) return
  // 只取最后 10 轮（20 条消息）
  const tail = messages.slice(-20)
  enqueueExtract({ role, model, reason: 'batch10', messages: tail })
}

/** OOC 立即 enqueue（单条对话） */
export function enqueueOOC(role: string, model: string, text: string): void {
  // hint 太短时 LLM 可能缺上下文——多给一句话说明这是主人显式要记的
  const content = text.length < 20
    ? `主人说"记一下"：${text}`
    : text
  enqueueExtract({
    role,
    model,
    reason: 'ooc',
    messages: [{ role: 'user', content, ts: new Date().toISOString() }],
  })
}

/** 强制 flush 队列（用于 bye / 进程退出前） */
export async function flushQueue(): Promise<void> {
  stopPolling()
  while (queue.length > 0) {
    await processNext()
  }
}

// ── 记忆意图检测（用于 OOC 立即触发） ────────────────────────────

/**
 * 从消息文本中检测"记一下"意图。
 * 匹配："记一下 xxx" / "别忘了 xxx" / "记住 xxx" / "记好 xxx"
 * 返回：要记住的内容（去掉前缀后的剩余文本）
 */
const MEMORY_HINT_PATTERNS = [
  /记[一]下[：:，,。.\s]*(.+)/,
  /别忘了[：:，,。.\s]*(.+)/,
  /记住[：:，,。.\s]*(.+)/,
  /记好[：:，,。.\s]*(.+)/,
  /记下来[：:，,。.\s]*(.+)/,
]

export function detectMemoryHint(text: string): string | null {
  const trimmed = text.trim()
  for (const p of MEMORY_HINT_PATTERNS) {
    const m = trimmed.match(p)
    if (m && m[1] && m[1].trim().length > 0) {
      return m[1].trim()
    }
  }
  return null
}
