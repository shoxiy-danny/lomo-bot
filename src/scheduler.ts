/**
 * Scheduler — 30s 轮询引擎，触发一次性提醒和定时任务
 *
 * 架构：复用 memory/worker.ts 的 setInterval 模式
 * 依赖注入：server.ts 启动时传入 sendCard / chatFn / presets
 */

import type { ChatMessage, ChatOptions } from './llm/types'
import type { CharacterPreset } from './presets'
import { getDueReminders, markFired, nextCronTime, cleanupExpired, type Reminder } from './reminders'
import { TOOLS, executeNativeToolCalls, execBash } from './tools'

const POLL_MS = 30_000
let lastCleanup = 0
let lastDailyCleanupDate = ''  // YYYY-MM-DD，4:30 强制清理去重

// ── 依赖注入 ─────────────────────────────────────────────────────

interface SchedulerDeps {
  sendCard: (chatId: string, text: string) => Promise<void>
  chatFn: (messages: ChatMessage[], options: ChatOptions) => Promise<{ content: string }>
  presets: CharacterPreset[]
  findChatId: (role: string) => string | null  // 查找 bot 私聊 chatId
  forceCleanupAllSessions: () => Promise<number>  // 强制清理所有 session，返回清理数量
  runProactiveDecision: () => Promise<void>  // 主动决策触发（v1.0）
}

let deps: SchedulerDeps | null = null
let timer: ReturnType<typeof setInterval> | null = null

export function initScheduler(d: SchedulerDeps): void {
  deps = d
}

// ── 启停 ─────────────────────────────────────────────────────────

let ticking = false  // 防并发 tick 保护

export function startScheduler(): void {
  if (timer) return
  process.stderr.write(`[scheduler] started (poll=${POLL_MS}ms)\n`)
  tick()
  timer = setInterval(tick, POLL_MS)
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
    process.stderr.write('[scheduler] stopped\n')
  }
}

// ── 核心轮询 ─────────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (!deps) return
  if (ticking) return  // 上一轮还没跑完，跳过
  ticking = true
  try {
    await doTick()
  } finally {
    ticking = false
  }
}

async function doTick(): Promise<void> {
  // 每天清理一次过期提醒
  if (Date.now() - lastCleanup > 86400_000) {
    cleanupExpired()
    lastCleanup = Date.now()
  }
  // 每天 4:30（东八区）强制清理所有 session — 系统级兜底
  if (shouldRunDailyForceCleanup()) {
    try {
      const count = await deps.forceCleanupAllSessions()
      process.stderr.write(`[scheduler] 4:30 强制清理完成：${count} 个 session\n`)
    } catch (err: any) {
      process.stderr.write(`[scheduler] 4:30 强制清理失败: ${err.message}\n`)
    }
  }
  // 主动决策 tick — 内部判断是否到 20-50min 随机间隔
  try {
    await deps.runProactiveDecision()
  } catch (err: any) {
    process.stderr.write(`[scheduler] proactive 决策失败: ${err.message}\n`)
  }
  const due = getDueReminders()
  if (due.length === 0) return

  for (const r of due) {
    try {
      await fireReminder(r)
    } catch (err: any) {
      process.stderr.write(`[scheduler] error firing ${r.type} id=${r.id.slice(0, 8)}: ${err.message}\n`)
      // 失败不 markFired → 下个 tick 自动重试
    }
  }
}

/** 检查是否该跑 4:30 强制清理（每天一次） */
function shouldRunDailyForceCleanup(): boolean {
  // 东八区时间
  const ts = Date.now() + 8 * 60 * 60 * 1000
  const d = new Date(ts)
  const hour = d.getUTCHours()
  const minute = d.getUTCMinutes()
  // 4:30 触发（容忍 ±1 分钟窗口，避免 30s 轮询错过）
  if (hour === 4 && minute >= 30 && minute < 32) {
    const today = d.toISOString().slice(0, 10)
    if (lastDailyCleanupDate !== today) {
      lastDailyCleanupDate = today
      return true
    }
  }
  return false
}

async function fireReminder(r: Reminder): Promise<void> {
  if (!deps) return

  // 确定投递 chatId
  let chatId = r.chatId
  if (r.delivery === 'bot_private') {
    const found = deps.findChatId(r.role)
    if (!found) {
      process.stderr.write(`[scheduler] skip ${r.type} id=${r.id.slice(0, 8)}: no active chat for role=${r.role}\n`)
      return  // 不 markFired，等有活跃对话时重试
    }
    chatId = found
  }

  // 安全检查：web 会话跳过
  if (chatId.startsWith('web:')) {
    process.stderr.write(`[scheduler] skip web session id=${r.id.slice(0, 8)}\n`)
    markFired(r.id)
    return
  }

  if (r.type === 'once') {
    await deps.sendCard(chatId, r.text || '')
    markFired(r.id)
    process.stderr.write(`[scheduler] once fired id=${r.id.slice(0, 8)}\n`)
    return
  }

  // type === 'cron'
  if (!r.cron) throw new Error('cron reminder missing cron expression')

  // 0. 脚本预检（可选）：代码层跑 bash，输出 SILENCE → 跳过 LLM 直接返回
  if (r.preCheck) {
    const { result } = execBash(r.preCheck)
    process.stderr.write(`[scheduler] cron id=${r.id.slice(0, 8)}: preCheck → ${result.slice(0, 80)}\n`)
    if (result.trim().toUpperCase().startsWith('SILENCE')) {
      markFired(r.id)
      process.stderr.write(`[scheduler] cron id=${r.id.slice(0, 8)}: preCheck silenced\n`)
      return
    }
    // 非 SILENCE → 把脚本输出注入 prompt，LLM 可以引用
    r = { ...r, prompt: `${r.prompt}\n\n【脚本预检输出】\n${result.trim()}` }
  }

  // 构建 system prompt：时间 + 角色身份 + 任务指令
  const preset = deps.presets.find(p => p.id === r.role)
  const roleName = preset?.name || r.role
  const persona = preset?.persona || ''

  const ts = Date.now() + 8 * 60 * 60 * 1000
  const d = new Date(ts)
  const dayStr = ['日', '一', '二', '三', '四', '五', '六'][d.getUTCDay()]
  const iso = d.toISOString()
  const timeStr = `${iso.slice(0, 10)} ${iso.slice(11, 16)} 周${dayStr}`

  const systemPrompt = `你正在以「${roleName}」的身份执行定时任务。

${persona ? `【角色身份】\n${persona}\n\n` : ''}【当前时间】${timeStr}（东八区 UTC+8）

【任务指令】
${r.prompt}

请直接执行任务（如需搜索信息请使用 web_search 工具），把最终结果整理好发出来。不要只回复"好的"或"收到"，要给出完整的任务执行结果。`

  const options: ChatOptions = {
    model: r.model || 'deepseek-v4-flash',
    maxTokens: 4096,
    temperature: 0.7,
    tools: TOOLS,
  }

  // 工具调用循环（上限 10 轮，正常 2-4 轮自然结束）
  const MAX_TOOL_ROUNDS = 10
  let messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '请执行任务。' },
  ]
  let finalContent = ''
  const lastErrorSigs: string[] = []  // 连续相同错误检测（防死循环）

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const resp = await deps.chatFn(messages, options)

    // 没有工具调用 → 拿到最终内容
    if (!resp.toolCalls || resp.toolCalls.length === 0) {
      finalContent = resp.content?.trim() || ''
      break
    }

    // 已到最大轮数 → 不再执行工具，直接用当前 content
    if (round === MAX_TOOL_ROUNDS) {
      finalContent = resp.content?.trim() || ''
      process.stderr.write(`[scheduler] cron id=${r.id.slice(0, 8)}: max tool rounds reached\n`)
      break
    }

    // 执行工具调用
    process.stderr.write(`[scheduler] cron id=${r.id.slice(0, 8)}: executing tools [${resp.toolCalls.map(t => t.function.name).join(', ')}]\n`)
    const toolResults = await executeNativeToolCalls(resp.toolCalls, r.role, chatId)

    // 检测连续相同错误（连续 2 轮同一工具返回同一错误 → 跳出，防 M3 死循环）
    let repeatedError = false
    for (const tr of toolResults) {
      if (tr.result.startsWith('执行失败:') || tr.result.startsWith('命令被拒绝执行:')) {
        const sig = tr.query + '|' + tr.result.slice(0, 120)
        if (lastErrorSigs.includes(sig)) { repeatedError = true; break }
        lastErrorSigs.push(sig)
        if (lastErrorSigs.length > 8) lastErrorSigs.shift()
      }
    }

    if (repeatedError) {
      process.stderr.write(`[scheduler] cron id=${r.id.slice(0, 8)}: repeated tool error, breaking loop\n`)
      break
    }

    const toolContext = toolResults.map(tr => {
      if (tr.type === 'search') return `【搜索结果："${tr.query}"】\n${tr.result}`
      if (tr.type === 'image') return `【生成图片："${tr.query}"】\n${tr.result}`
      if (tr.type === 'memory') return `【记忆工具结果："${tr.query}"】\n${tr.result}`
      if (tr.type === 'reminder') return `【提醒/任务操作】\n${tr.result}`
      if (tr.type === 'note') return `【笔记操作】\n${tr.result}`
      return ''
    }).join('\n\n')

    // 把工具结果追加到消息历史，继续调 LLM
    messages = [
      ...messages,
      { role: 'assistant', content: resp.content || '' },
      { role: 'user', content: `[系统：以下是工具执行结果，请根据结果完成任务并输出完整内容]\n\n${toolContext}` },
    ]
  }

  // 兜底：工具循环后 content 为空 → 追调一次不带工具的 chat 拿文字总结
  if (!finalContent) {
    const fallbackMsg: ChatMessage = { role: 'user', content: '工具调用已达最大轮数或遇到重复错误。请直接以文字回答，不要使用任何工具。根据已有信息和工具执行结果，完整回复用户的问题。' }
    const fallbackOptions: ChatOptions = { model: r.model || 'deepseek-v4-flash', maxTokens: 4096, temperature: 0.7, tools: [] }
    const fallbackResp = await deps.chatFn([...messages, fallbackMsg], fallbackOptions)
    finalContent = fallbackResp.content?.trim() || ''
    process.stderr.write(`[scheduler] cron id=${r.id.slice(0, 8)}: fallback chat (no tools) → ${finalContent.length} chars\n`)
  }

  if (!finalContent) throw new Error('cron task returned empty response')

  // 静默检测：仅检查 LLM 是否遵守 SILENCE 约定
  // cron 不同于 proactive，不需要 too_long/too_short/code_block 兜底
  // LLM 输出 SILENCE → 拦截；否则（含长报告）→ 正常发送
  if (finalContent.trim().toUpperCase().startsWith('SILENCE')) {
    const next = nextCronTime(r.cron, Date.now())
    markFired(r.id, next)
    process.stderr.write(`[scheduler] cron id=${r.id.slice(0, 8)}: silenced\n`)
    return
  }

  await deps.sendCard(chatId, finalContent)
  const next = nextCronTime(r.cron, Date.now())
  markFired(r.id, next)
  const nextBeijing = new Date(next).toLocaleString('sv', { timeZone: 'Asia/Shanghai' })
  process.stderr.write(`[scheduler] cron fired id=${r.id.slice(0, 8)} next=${nextBeijing}\n`)
}
