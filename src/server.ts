#!/usr/bin/env bun
/**
 * Chat Agent Server — 独立飞书对话式助手 Agent
 *
 * 三层消息路由：破甲词(系统管理) → 场外指令(导演) → 普通对话
 * 固定上下文前缀 + prompt caching
 * 语音管道：Doubao ASR + MiMo TTS
 */

import * as lark from '@larksuiteoapi/node-sdk'
import { join, basename, extname } from 'path'
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync, createReadStream, readdirSync,
} from 'fs'

import type { Session, Message } from './session'
import {
  createSession, saveSession, loadSession, listSessions,
  createSave, loadSave, deleteSave, deleteSession,
} from './session'
import { buildContext, extractVoiceStyle, truncateBrackets } from './context'
import { getAll as getAllMemories, count as countMemories, getAllFresh, deleteById as deleteMemoryById } from './memory/store'
import { loadProfile, isInitialized as isProfileInitialized } from './memory/profile'
import {
  enqueueSessionEnd, enqueueBatch10, enqueueOOC,
  detectMemoryHint, queueSize,
} from './memory/worker'
import { isOverCap, llmReviewTop, forceCleanIfOverCap } from './memory/cleanup'
import {
  routeMessage, parseSystemCommand, resolveModelAlias,
  resolveVoiceStyle, VOICE_PRESETS,
} from './breakword'
import { chat } from './llm/router'
import type { ChatMessage, ToolCall } from './llm/types'
import { TOOLS, parseToolCalls, parseToolCallXml, stripToolCallXml, executeNativeToolCalls, executeLegacyToolCalls } from './tools'
import { saveLocation } from './location'
import {
  loadProactive, saveProactive, checkHardLimit,
  recordSend, recordSilence, recordInvalid, triggerPause,
  shouldTriggerProactiveCheck,
} from './proactive'
import { buildTriggerMessage, isSilence, extractTopic } from './proactive-prompt'
import { logLlmCall, queryLogs, getStats, getSessionCost } from './llm-log'
import { PRESETS } from './presets'
import { listReminders, deleteReminder } from './reminders'
import { initScheduler, startScheduler, stopScheduler } from './scheduler'
import { listNotes, searchNotes, deleteNote } from './notes'
import { appendDiaryEntry } from './memory/diary'
import { archiveSession } from './memory/archive'

// ── 环境变量 ──────────────────────────────────────────────────────

const HOME = process.env.HOME || '/home/user'
const STATE_DIR = join(HOME, 'Projects', 'Lomo', 'state')

// 加载 .env
const ENV_FILE = join(STATE_DIR, '.env')
try {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const APP_ID = process.env.FEISHU_APP_ID
const APP_SECRET = process.env.FEISHU_APP_SECRET
const DOUBAO_API_KEY = process.env.DOUBAO_API_KEY || ''
const MIMO_API_KEY = process.env.MIMO_API_KEY || ''
const MIMO_API_HOST = process.env.MIMO_API_HOST || 'https://token-plan-cn.xiaomimimo.com'
const PORT = parseInt(process.env.CHAT_AGENT_PORT || '18895')

if (!APP_ID || !APP_SECRET) {
  console.error('需要配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET')
  console.error(`  请在 ${ENV_FILE} 中配置`)
  process.exit(1)
}

// ── 飞书客户端 ────────────────────────────────────────────────────

const feishuClient = new lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  appType: lark.AppType.SelfBuild,
})

let botOpenId = ''

// 待选择状态（用户点击菜单后等待数字选择）
interface PendingSelection {
  type: 'role' | 'model' | 'load'
  options: { label: string; value: string }[]
  ts: number
}
const pendingSelections = new Map<string, PendingSelection>()

// TTS 开关状态（已持久化，重启保留）
const ttsEnabled = new Map<string, boolean>()
const TTS_FILE = join(STATE_DIR, 'tts.json')
function loadTtsState(): void {
  try {
    const raw = readFileSync(TTS_FILE, 'utf8')
    const data = JSON.parse(raw) as Record<string, boolean>
    for (const [k, v] of Object.entries(data)) ttsEnabled.set(k, v)
  } catch {}
}
function saveTtsState(): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const obj: Record<string, boolean> = {}
    for (const [k, v] of ttsEnabled) obj[k] = v
    writeFileSync(TTS_FILE, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  } catch {}
}
loadTtsState()
// 进程启动时间戳（ms），用于过滤重连后的历史消息重放
const START_TIME = Date.now()

const recentMessageIds = new Set<string>()
const MAX_RECENT_IDS = 100
function isDuplicate(messageId: string): boolean {
  if (recentMessageIds.has(messageId)) return true
  recentMessageIds.add(messageId)
  if (recentMessageIds.size > MAX_RECENT_IDS) {
    const first = recentMessageIds.values().next().value
    if (first) recentMessageIds.delete(first)
  }
  return false
}

// ── 用户会话管理（持久化）─────────────────────────────────────────

const ACTIVE_MAP_FILE = join(STATE_DIR, 'active.json')

// chatId → active session id
const activeSessions = new Map<string, string>()
// chatId → system mode flag
const systemModes = new Map<string, boolean>()
let lastUserMsgAt = 0  // 最近一次用户消息时间戳（主动决策冷却用）

// 从磁盘加载活跃会话映射
function loadActiveSessions(): void {
  try {
    const raw = readFileSync(ACTIVE_MAP_FILE, 'utf8')
    const data = JSON.parse(raw) as Record<string, string>
    for (const [chatId, sessionId] of Object.entries(data)) {
      activeSessions.set(chatId, sessionId)
    }
  } catch {}
}
loadActiveSessions()

function saveActiveSessions(): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const obj: Record<string, string> = {}
    for (const [k, v] of activeSessions) obj[k] = v
    writeFileSync(ACTIVE_MAP_FILE, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  } catch {}
}

function getActiveSession(chatId: string): Session | null {
  const sessionId = activeSessions.get(chatId)
  if (!sessionId) return null
  return loadSession(sessionId)
}

function setActiveSession(chatId: string, session: Session): void {
  activeSessions.set(chatId, session.id)
  saveSession(session)
  saveActiveSessions()
}

// ── 上下文构建 helper（v1：含 postMessages） ─────────────────────

/**
 * 把 buildContext 结果拼成 LLM 调用的 messages 数组
 * 记忆块已移入 system prompt，不再需要 postMessages
 */
function buildMessagesForLLM(session: Session): { system: string; messages: any[] } {
  const ctx = buildContext(session)
  return { system: ctx.system, messages: ctx.messages }
}

// ── 会话结束检测（1 小时空闲） ────────────────────────────────────

const SESSION_TIMEOUT_MS = 60 * 60 * 1000  // 1 小时

function isSessionTimedOut(session: Session): boolean {
  const lastActivity = session.lastActivityAt || session.updatedAt
  if (!lastActivity) return false
  return Date.now() - new Date(lastActivity).getTime() > SESSION_TIMEOUT_MS
}

// ── 模型选择：init 阶段 / 工具密集场景强制用 DSF ─────

const INIT_MODEL = 'deepseek-v4-pro'
const TOOL_MODEL = 'deepseek-v4-flash'  // DSF：工具调用兜底模型（M3 幻觉严重时切这个）

// 需要强制 DSF 的关键词（米家查询/控制 + 搜索 + 时间等工具密集型场景）
// M3 在这些场景下严重幻觉，必须切 DSF 确保工具调用
const FORCE_DSF_RE = /开灯|关灯|开空调|关空调|开大灯|关大灯|打开.*灯|关闭.*灯|打开.*空调|关闭.*空调|调亮度|调色温|空调\d+度|灯.*开|灯.*关|设备.*开|设备.*关|几度|多少度|温度|湿度|开了没|关了吗|状态|亮度|色温|模式|电量|功率|传感器|插座|开关|窗帘|晾衣架|风扇|台灯|夜灯|音响|米家|mijia|看看.*设备|查.*设备|列.*设备|有什么设备|几个设备|家里.*设备|现在几点|今天几号|搜一下|帮我查|帮我找|搜.*新闻|天气预报|天气怎么样/

/** 选 LLM 模型：profile 未初始化或涉及工具密集操作时强制用 DSF */
function pickModelForCall(session: Session, userText?: string): string {
  if (!isProfileInitialized(session.characterName)) {
    return INIT_MODEL
  }
  // 工具密集型查询 → 强制 DSF（M3 幻觉严重，不调工具）
  if (userText && FORCE_DSF_RE.test(userText)) {
    process.stderr.write(`[model] force DSF: ${userText.slice(0, 50)}\n`)
    return TOOL_MODEL
  }
  return session.model
}

function runSessionEndCleanup(session: Session): void {
  process.stderr.write(`[memory/cleanup] session ${session.id} (${session.characterName}) ended, running cleanup\n`)
  // 冻结 session.profileText（清空，下次 session 重新读盘）
  session.profileText = undefined
  if (session.messages.length === 0) return

  // 0) L0 原始对话归档（持久化证据，90 天保留）
  archiveSession(session)

  // 1) 异步 enqueue 整段会话做提取
  const extractModel = process.env.MEMORY_EXTRACT_MODEL || 'deepseek-v4-flash'
  enqueueSessionEnd(session.characterName, extractModel, session.messages)

  // 2) 生成日记（≥6 条消息时才写）
  void generateDiaryEntry(session, extractModel)

  // 3) 500 cap 检查：fire-and-forget LLM 审阅
  if (isOverCap(session.characterName)) {
    void llmReviewTop(session.characterName, extractModel).then(toDelete => {
      let deleted = 0
      for (const id of toDelete) {
        if (deleteMemoryById(session.characterName, id)) deleted++
      }
      process.stderr.write(`[memory/cap-review] role=${session.characterName} LLM deleted ${deleted}/${toDelete.length}\n`)
    })
  }
}

/** 调 LLM 生成日记，存到 diary.md */
async function generateDiaryEntry(session: Session, model: string): Promise<void> {
  try {
    // 只在对话 >= 6 条时才写日记（避免空会话写废话）
    if (session.messages.length < 6) return

    const conversationText = session.messages
      .map(m => `[${m.role}] ${m.content.slice(0, 200)}`)
      .join('\n')

    const resp = await chat([
      {
        role: 'system',
        content: `你是一个日记生成器。根据以下对话，写一段 ≤6 行的日记。
只写个人感受、情绪、和主人的互动感受。
可以一句话提到做了什么，但禁止记录技术细节、工程内容、配置改动。
语气自然、口语化，像在跟自己说话。
不要加日期标题，直接写内容。`,
      },
      { role: 'user', content: conversationText },
    ], { model, maxTokens: 256, temperature: 0.7 })

    const content = resp.content?.trim()
    if (content && content.length > 10) {
      appendDiaryEntry(session.characterName, content)
    }
  } catch (err: any) {
    process.stderr.write(`[diary] error: ${err.message}\n`)
  }
}

// ── /memory 命令处理 ──────────────────────────────────────────────

async function handleMemoryCommand(chatId: string, session: Session, args: string[]): Promise<void> {
  const sub = (args[0] || 'list').toLowerCase()
  const role = session.characterName

  switch (sub) {
    case 'list': {
      const all = getAllFresh(role)
      if (all.length === 0) {
        await feishuCardReply(chatId, `当前角色 **${role}** 还没有任何记忆。`)
        return
      }
      const lines = all
        .sort((a, b) => b.importance - a.importance || b.created_at.localeCompare(a.created_at))
        .slice(0, 30)
        .map(m => {
          const pin = m.pinned ? '📌' : ''
          return `- [${m.type}] imp=${m.importance} ${pin} ${m.content}`
        })
      await feishuCardReply(
        chatId,
        `**${role} 的记忆**（共 ${all.length} 条，展示前 ${Math.min(30, all.length)} 条）\n${lines.join('\n')}`,
      )
      return
    }
    case 'profile': {
      if (!isProfileInitialized(role)) {
        await feishuCardReply(chatId, `**${role}** 还没有初始化 Profile。`)
        return
      }
      const profile = loadProfile(role)
      const lines = []
      if (profile.name) lines.push(`姓名: ${profile.name}`)
      if (profile.preferred_name) lines.push(`称呼: ${profile.preferred_name}`)
      if (profile.core_habits.length) {
        lines.push('核心习惯:')
        for (const h of profile.core_habits) lines.push(`  - ${h.habit}`)
      }
      if (profile.core_projects.length) {
        lines.push('核心项目:')
        for (const p of profile.core_projects) lines.push(`  - ${p.name}${p.path ? ` [${p.path}]` : ''}`)
      }
      if (Object.keys(profile.core_contacts).length) {
        lines.push('联系人:')
        for (const [k, v] of Object.entries(profile.core_contacts)) {
          lines.push(`  - ${k}: ${v}`)
        }
      }
      await feishuCardReply(
        chatId,
        lines.length === 0 ? `**${role}** 的 Profile 是空的。` : `**${role} 的 Profile**\n${lines.join('\n')}`,
      )
      return
    }
    default:
      await feishuCardReply(
        chatId,
        `**记忆命令**\n/memory list — 列出当前角色的记忆\n/memory profile — 列出 Profile`,
      )
  }
}

// ── 消息处理主循环 ────────────────────────────────────────────────

async function handleMessage(chatId: string, text: string, senderId: string, messageId: string): Promise<void> {
  lastUserMsgAt = Date.now()  // 更新最近用户消息时间（主动决策冷却用）
  let session = getActiveSession(chatId)

  // 1 小时空闲检测：旧会话提取记忆 → 自动开新会话
  if (session && isSessionTimedOut(session)) {
    const charName = session.characterName
    const oldModel = session.model
    runSessionEndCleanup(session)
    const preset = PRESETS.find(p => p.id === charName.toLowerCase()) || PRESETS.find(p => p.name === charName)
    if (preset) {
      const newSession = createSession(preset.name, preset.persona, preset.scene, preset.voice, preset.voiceStyle)
      newSession.model = oldModel
      setActiveSession(chatId, newSession)
      saveSession(newSession)
      session = newSession
      process.stderr.write(`[memory/timeout] auto-new session for ${charName}\n`)
    }
  }
  if (session) {
    session.lastActivityAt = new Date().toISOString()
  }

  // 检查是否有待选择（数字输入）— 即使没有 session 也要处理
  const pending = pendingSelections.get(chatId)
  if (pending) {
    const num = parseInt(text.trim())
    if (num === 0) {
      pendingSelections.delete(chatId)
      await feishuReply(chatId, '已取消。')
      return
    }
    if (!isNaN(num) && num >= 1 && num <= pending.options.length) {
      const selected = pending.options[num - 1]
      pendingSelections.delete(chatId)
      if (pending.type === 'role') {
        await startPreset(chatId, selected.value, senderId, session)
      } else if (session) {
        await handleSelection(chatId, session, pending.type, selected.value)
      }
      return
    }
    // 非数字输入，清除待选择状态，继续正常流程
    pendingSelections.delete(chatId)
  }

  // 没有活跃 session 时，尝试匹配预置模板或创建新 session
  if (!session) {
    await handleNoSession(chatId, text, senderId)
    return
  }

  // 预检：/ 开头的命令直接走系统命令处理
  if (text.trim().startsWith('/')) {
    await handleSystemCommand(chatId, session, text.trim().slice(1), senderId)
    return
  }

  // Stage 2：记忆意图检测（"记一下"/"别忘了"等）— 不阻塞对话
  const hint = detectMemoryHint(text)
  if (hint) {
    const extractModel = process.env.MEMORY_EXTRACT_MODEL || 'deepseek-v4-flash'
    enqueueOOC(session.characterName, extractModel, hint)
    process.stderr.write(`[memory/hint] chat=${chatId} enqueued: ${hint.slice(0, 50)}\n`)
  }

  // 三层路由
  const result = routeMessage(text, systemModes.get(chatId) || false)

  switch (result.mode) {
    case 'system':
      await handleSystemCommand(chatId, session, result.command, senderId)
      break
    case 'ooc':
      await handleOOC(chatId, session, result.instruction, result.userText, senderId)
      break
    case 'character':
      await handleCharacter(chatId, session, result.text, senderId)
      break
  }

  // Stage 2：每 10 轮消息批量 enqueue（路由后 session.messages 已包含新消息，计数正确）
  const BATCH_INTERVAL = 10
  const messageCount = session.messages.length
  if (messageCount > 0 && messageCount % BATCH_INTERVAL === 0) {
    const extractModel = process.env.MEMORY_EXTRACT_MODEL || 'deepseek-v4-flash'
    enqueueBatch10(session.characterName, extractModel, session.messages)
    process.stderr.write(`[memory/batch10] chat=${chatId} msgs=${messageCount} enqueued\n`)
  }
}

// ── 无活跃 Session 时的处理 ───────────────────────────────────────

async function handleNoSession(chatId: string, text: string, senderId: string): Promise<void> {
  const trimmed = text.trim()

  // / 开头的命令：需要先创建 session，再处理
  if (trimmed.startsWith('/')) {
    await autoStartIfSinglePreset(chatId, senderId)
    // 再次获取 session
    const session = getActiveSession(chatId)
    if (session) {
      await handleSystemCommand(chatId, session, trimmed.slice(1), senderId)
    }
    return
  }

  // 不是命令，直接自动开始
  await autoStartIfSinglePreset(chatId, senderId)
}

// 角色数量判断：1个直接开始，多个让用户选
async function autoStartIfSinglePreset(chatId: string, senderId: string): Promise<void> {
  const { PRESETS } = await import('./presets')
  if (PRESETS.length === 0) {
    await feishuCardReply(chatId, '暂无可用角色。')
  } else if (PRESETS.length === 1) {
    await startPreset(chatId, PRESETS[0].id, senderId)
  } else {
    await showRoleSelection(chatId)
  }
}

async function showRoleSelection(chatId: string): Promise<void> {
  if (PRESETS.length === 1) {
    await feishuCardReply(chatId, `角色: **${PRESETS[0].name}**\n发送 **${PRESETS[0].name}** 开始对话。`)
    return
  }
  const options = PRESETS.map(p => ({ label: `${p.name} — ${p.scene.split('\n')[0]}`, value: p.id }))
  pendingSelections.set(chatId, { type: 'role', options, ts: Date.now() })
  const lines = options.map((o, i) => `**${i + 1}.** ${o.label}`)
  lines.push('**0.** 取消')
  await feishuCardReply(chatId, `选择角色（输入数字）：\n${lines.join('\n')}`)
}

async function startPreset(chatId: string, presetId: string, senderId: string, oldSession?: Session): Promise<void> {
  const preset = PRESETS.find(p => p.id === presetId)
  if (!preset) {
    await feishuReply(chatId, '角色不存在')
    return
  }

  // 离开当前角色：只有超时才触发记忆提取，没超时就留着下次回来接着用
  if (oldSession && oldSession.messages.length > 0) {
    if (isSessionTimedOut(oldSession)) {
      runSessionEndCleanup(oldSession)
    } else {
      process.stderr.write(`[memory/role] leave ${oldSession.characterName} (${oldSession.id.slice(0, 8)}), not timed out, skip cleanup\n`)
    }
  }

  // 查找目标角色的最近 session：1h 内 → 复用，超时 → 清理后建新的
  const recentSessions = listSessions()
    .filter(s => s.id !== oldSession?.id)
    .filter(s => s.characterName === preset.name)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
  const recentTarget = recentSessions[0]

  let session: Session
  if (recentTarget && !isSessionTimedOut(recentTarget)) {
    // 未超时 → 复用
    session = recentTarget
    process.stderr.write(`[memory/role] reuse recent session ${session.id.slice(0, 8)} for ${preset.name}\n`)
  } else {
    // 超时或不存在：先清理（如果有），再建新的
    if (recentTarget) {
      runSessionEndCleanup(recentTarget)
    }
    session = createSession(
      preset.name,
      preset.persona,
      preset.scene,
      preset.voice,
      preset.voiceStyle,
    )
  }
  setActiveSession(chatId, session)

  await feishuCardReply(chatId, `已选择角色：**${preset.name}**
${preset.scene.split('\n')[0]}

现在可以开始和 ${preset.name} 聊天了。
发送 /help 查看所有命令。`)
}

// ── 系统命令处理 ──────────────────────────────────────────────────

async function handleSystemCommand(chatId: string, session: Session, command: string, senderId: string): Promise<void> {
  const cmd = parseSystemCommand(command)

  switch (cmd.action) {
    case 'help':
      await feishuCardReply(chatId, `**Lomo 命令列表**

**会话**
/status — 查看状态
/new — 新建会话
/name <称呼> — 设置你的称呼

**存档**
/save — 快速存档
/load — 读档
/list — 查看存档列表
/delete <名> — 删除存档

**设置**
/model — 切换模型
/tts — 语音开关
/resume — 回到正常对话

**记忆**
/memory list — 列出当前角色的记忆
/memory profile — 列出 Profile

**笔记**
/note — 列出最近笔记
/note <关键词> — 搜索笔记
/note del <id> — 删除笔记

**提醒/任务**
/remind <时间> <文字> — 创建提醒
/reminder — 列出所有提醒和任务
/task — 列出定时任务
/remind off <id> — 删除提醒
/task off <id> — 删除任务`)
      break
    case 'memory':
      await handleMemoryCommand(chatId, session, cmd.args)
      break

    case 'note': {
      const sub = cmd.args[0]
      if (sub === 'del' && cmd.args[1]) {
        const ok = deleteNote(cmd.args[1])
        await feishuReply(chatId, ok ? '已删除笔记。' : '找不到该笔记。')
        break
      }
      if (sub) {
        // /note <关键词> → 搜索
        const notes = searchNotes(cmd.args.join(' '))
        if (notes.length === 0) {
          await feishuReply(chatId, `没有找到与"${cmd.args.join(' ')}"相关的笔记。`)
        } else {
          const lines = notes.map(n => {
            const time = new Date(n.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
            const tags = n.tags.length > 0 ? ` [${n.tags.join(',')}]` : ''
            return `- ${n.content}${tags} (${time}) \`${n.id.slice(0, 8)}\``
          })
          await feishuCardReply(chatId, `**笔记搜索** (${notes.length})\n${lines.join('\n')}`)
        }
      } else {
        // /note → 列出最近笔记
        const notes = listNotes()
        if (notes.length === 0) {
          await feishuReply(chatId, '暂无笔记。对 Lomo 说"记一下..."即可保存。')
        } else {
          const lines = notes.map(n => {
            const time = new Date(n.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
            const tags = n.tags.length > 0 ? ` [${n.tags.join(',')}]` : ''
            return `- ${n.content}${tags} (${time}) \`${n.id.slice(0, 8)}\``
          })
          await feishuCardReply(chatId, `**最近笔记** (${notes.length})\n${lines.join('\n')}`)
        }
      }
      break
    }

    case 'model': {
      const alias = cmd.args[0]
      if (alias) {
        const resolved = resolveModelAlias(alias)
        session.model = resolved
        saveSession(session)
        await feishuReply(chatId, `模型已切换: **${resolved}**`)
      } else {
        const models = [
          { label: 'MiniMax-M3（默认）', value: 'MiniMax-M3' },
          { label: 'DeepSeek V4 Pro', value: 'deepseek-v4-pro' },
          { label: 'DeepSeek V4 Flash', value: 'deepseek-v4-flash' },
          { label: 'MiMo V2.5 Pro', value: 'mimo-v2.5-pro' },
          { label: 'MiMo V2.5', value: 'mimo-v2.5' },
        ]
        pendingSelections.set(chatId, { type: 'model', options: models, ts: Date.now() })
        const lines = models.map((m, i) => `**${i + 1}.** ${m.label}`)
        lines.push('**0.** 取消')
        await feishuCardReply(chatId, `当前模型: **${session.model}**\n\n选择新模型（输入数字）：\n${lines.join('\n')}`)
      }
      break
    }

    case 'name': {
      const newName = cmd.args.join(' ').trim()
      if (newName) {
        session.userName = newName
        saveSession(session)
        await feishuReply(chatId, `已更新称呼: **${newName}**`)
      } else {
        await feishuReply(chatId, `当前称呼: **${session.userName}**\n用法: /name <新称呼>`)
      }
      break
    }

    case 'save': {
      const label = cmd.args.join(' ') || '快速存档'
      if (!cmd.args.join(' ')) {
        session.saves = session.saves.filter(s => s.label !== '快速存档')
      }
      const save = createSave(session, label)
      await feishuReply(chatId, `已存档: **${save.label}**`)
      break
    }

    case 'load': {
      const target = cmd.args.join(' ')
      if (target) {
        if (loadSave(session, target)) {
          const updated = loadSession(session.id)!
          setActiveSession(chatId, updated)
          await feishuReply(chatId, `已读档: **${target}**
对话已恢复，共 ${updated.messages.length} 条消息。`)
          // 重放最后一条助理消息
          const lastAssistant = updated.messages.filter(m => m.role === 'assistant').pop()
          if (lastAssistant) await feishuCardReply(chatId, lastAssistant.content)
        } else {
          await feishuReply(chatId, `找不到存档: ${target}`)
        }
      } else {
        if (session.saves.length === 0) {
          await feishuReply(chatId, '暂无存档。发送 /save 创建存档。')
          break
        }
        // 快速读取
        const qs = session.saves.slice().reverse().find(s => s.label === '快速存档')
        if (qs && loadSave(session, qs.id)) {
          const updated = loadSession(session.id)!
          setActiveSession(chatId, updated)
          const last = updated.messages.filter(m => m.role === 'assistant').pop()
          const replay = last ? '\n\n---\n' + last.content : ''
          await feishuReply(chatId, '已快速读档，共 ' + updated.messages.length + ' 条消息' + replay)
          break
        }
        const options = session.saves.map(s => ({ label: s.label, value: s.id }))
        pendingSelections.set(chatId, { type: 'load', options, ts: Date.now() })
        const lines = options.map((s, i) => `**${i + 1}.** ${s.label}`)
        lines.push('**0.** 取消')
        await feishuCardReply(chatId, `选择存档（输入数字）：\n${lines.join('\n')}`)
      }
      break
    }

    case 'list': {
      if (session.saves.length === 0) {
        await feishuReply(chatId, '暂无存档。发送 /save 创建存档。')
        break
      }
      const list = session.saves.map((s, i) =>
        `${i + 1}. **${s.label}** (${s.messageIndex} 条消息) \`${s.id.slice(0, 8)}\``
      ).join('\n')
      await feishuReply(chatId, `存档列表：\n${list}`)
      break
    }

    case 'delete': {
      const target = cmd.args.join(' ')
      if (!target) { await feishuReply(chatId, '用法: /delete <存档名或ID>'); break }
      if (deleteSave(session, target)) {
        await feishuReply(chatId, `已删除存档: ${target}`)
      } else {
        await feishuReply(chatId, `找不到存档: ${target}`)
      }
      break
    }

    case 'voice':
    case 'tts': {
      const current = ttsEnabled.get(chatId) || false
      ttsEnabled.set(chatId, !current)
      saveTtsState()
      await feishuCardReply(chatId, !current
        ? 'TTS 语音回复已开启'
        : 'TTS 语音回复已关闭')
      break
    }

    case 'status': {
      const recentSaves = session.saves.slice(-3).map(s => s.label).join(', ') || '无'
      await feishuCardReply(chatId, `**当前状态**
角色: ${session.characterName}
模型: ${session.model}
消息数: ${session.messages.length}
音色: ${session.voice}
语音回复: ${ttsEnabled.get(chatId) ? '开启' : '关闭'}
最近存档: ${recentSaves}`)
      break
    }

    case 'resume': {
      systemModes.set(chatId, false)
      await feishuReply(chatId, `已回到正常对话模式。${session.characterName} 正在等待你的对话。`)
      break
    }

    case 'new': {
      // 先对旧 session 做记忆提取 + 摘要（如果有旧 session 且旧 session 不等同于新 session）
      if (session && session.messages.length > 0) {
        runSessionEndCleanup(session)
      }
      const name = cmd.args.join(' ')
      let newSession: Session
      if (name) {
        newSession = createSession(name, `你是${name}。`, '场景待设定')
      } else {
        const lomoPreset = PRESETS.find(p => p.id === 'lomo') || PRESETS[0]
        newSession = createSession(lomoPreset.name, lomoPreset.persona, lomoPreset.scene, lomoPreset.voice, lomoPreset.voiceStyle)
      }
      setActiveSession(chatId, newSession)
      systemModes.set(chatId, false)
      await feishuReply(chatId, `已创建新会话: **${newSession.characterName}**
模型: ${newSession.model}
直接发消息即可开始对话。`)
      break
    }

    case 'character': {
      const desc = cmd.args.join(' ')
      if (!desc) { await feishuReply(chatId, '用法: /character <角色描述>'); break }
      session.characterPrompt = desc
      session.characterName = desc.slice(0, 20)
      session.messages = []
      saveSession(session)
      await feishuReply(chatId, '角色已更新，对话已重置。')
      break
    }

    case 'scene': {
      const desc = cmd.args.join(' ')
      if (!desc) { await feishuReply(chatId, '用法: /scene <场景描述>'); break }
      session.scenePrompt = desc
      session.messages = []
      saveSession(session)
      await feishuReply(chatId, '场景已更新，对话已重置。')
      break
    }

    case 'remind': {
      const sub = cmd.args[0]
      if (sub === 'off' && cmd.args[1]) {
        const ok = deleteReminder(cmd.args[1])
        await feishuReply(chatId, ok ? '已删除提醒。' : '找不到该提醒。')
        break
      }
      // /remind <时间描述> <提醒文字> — 交给 LLM 通过工具创建
      if (cmd.args.length === 0) {
        await feishuReply(chatId, '用法: /remind <时间> <文字>\n或: /remind off <id>\n也可直接对 Lomo 说"提醒我..."')
        break
      }
      // 直接把整段输入交给当前 session 的 LLM 处理
      const remindText = cmd.args.join(' ')
      const fakeMsg = `请帮我创建一个提醒：${remindText}。请使用 reminder_create 工具。`
      await handleCharacter(chatId, session, fakeMsg, senderId)
      break
    }

    case 'reminders': {
      const all = listReminders()
      if (all.length === 0) {
        await feishuReply(chatId, '暂无提醒和定时任务。')
        break
      }
      const lines = all.map(r => {
        const status = r.enabled ? '✓' : '✗'
        const type = r.type === 'once' ? '提醒' : '任务'
        const timeStr = r.type === 'once'
          ? new Date(r.fireAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          : cronToHuman(r.cron || '')
        return `${status} **${r.label || r.text || r.prompt?.slice(0, 20)}** [${type}]\n   ${timeStr} | id: \`${r.id.slice(0, 8)}\``
      })
      await feishuCardReply(chatId, `**提醒和定时任务** (${all.length})\n\n${lines.join('\n')}`)
      break
    }

    case 'task': {
      const sub = cmd.args[0]
      if (sub === 'off' && cmd.args[1]) {
        const ok = deleteReminder(cmd.args[1])
        await feishuReply(chatId, ok ? '已删除任务。' : '找不到该任务。')
        break
      }
      const tasks = listReminders().filter(r => r.type === 'cron')
      if (tasks.length === 0) {
        await feishuReply(chatId, '暂无定时任务。')
        break
      }
      const lines = tasks.map(r => {
        const status = r.enabled ? '✓' : '✗'
        const timeStr = cronToHuman(r.cron || '')
        return `${status} **${r.label}** (${timeStr})\n   ${r.prompt?.slice(0, 50)}... | id: \`${r.id.slice(0, 8)}\``
      })
      await feishuCardReply(chatId, `**定时任务** (${tasks.length})\n\n${lines.join('\n')}`)
      break
    }

    default:
      await feishuCardReply(chatId, `未知命令: \`${command}\`\n发送 /help 查看所有命令。`)
  }
}

// ── 选择处理 ──────────────────────────────────────────────────────

async function handleSelection(chatId: string, session: Session, type: string, value: string): Promise<void> {
  switch (type) {
    case 'role':
      await startPreset(chatId, value, '', session)
      break
    case 'model':
      session.model = value
      saveSession(session)
      await feishuReply(chatId, `模型已切换: **${value}**`)
      break
    case 'load':
      if (loadSave(session, value)) {
        const updated = loadSession(session.id)!
        setActiveSession(chatId, updated)
        const saveName = updated.saves.find(s => s.id === value)?.label || value
        await feishuReply(chatId, `已读档: **${saveName}**`)
        // 重放最后一条助理消息
        const lastAssistant = updated.messages.filter(m => m.role === 'assistant').pop()
        if (lastAssistant) await feishuCardReply(chatId, lastAssistant.content)
      } else {
        await feishuReply(chatId, '读档失败')
      }
      break
  }
}

// ── 普通角色对话 ──────────────────────────────────────────────────

/** 兜底检测 M3 文本式 <tool_call> 块，转成原生 toolCalls，返回清洗后的 content */
function detectXmlToolCalls(resp: { toolCalls?: ToolCall[]; content?: string }): string {
  const text = resp.content || ''
  if (resp.toolCalls && resp.toolCalls.length > 0) return text
  if (!text.includes('<tool_call>')) return text
  const xmlCalls = parseToolCallXml(text)
  if (xmlCalls.length === 0) return text
  console.log(`[tools] XML 工具调用: ${xmlCalls.map(t => t.function.name).join(', ')}`)
  resp.toolCalls = xmlCalls
  return stripToolCallXml(text)
}

/** 工具类型映射（用于进度卡片） */
function toolNameToType(n: string): string {
  if (n === 'web_search') return 'web_search'
  if (n === 'image_gen') return 'image_gen'
  if (n === 'nearby_search') return 'nearby_search'
  if (n.startsWith('reminder_') || n.startsWith('task_')) return 'reminder'
  if (n.startsWith('note_')) return 'note'
  if (n === 'bash_exec') return 'bash'
  if (n === 'mijia_list' || n === 'mijia_get' || n === 'mijia_set') return 'mijia'
  return 'memory'
}

const MAX_TOOL_ITERATIONS = 10

/**
 * 工具调用循环：执行工具 → 拿下一轮 LLM 响应 → 重复，直到 LLM 不再调工具
 * 返回最终回复 + 图片 + 日志
 */
async function runToolLoop(
  initialResp: { content?: string; toolCalls?: ToolCall[]; usage?: any; model?: string; rawContent?: string },
  baseMessages: { role: 'user' | 'assistant'; content: string }[],
  system: string,
  model: string,
  session: Session,
  chatId: string,
  progressMsgId: string,
): Promise<{ finalContent: string; images: string[]; logEntries: Array<{ resp: any; type: 'native' | 'legacy'; calls: any[]; systemPreview: string }> }> {
  const images: string[] = []
  const logEntries: Array<{ resp: any; type: 'native' | 'legacy'; calls: any[]; systemPreview: string }> = []
  let currentResp: any = initialResp
  let rawReply = detectXmlToolCalls(currentResp)
  const lastErrorSigs: string[] = []  // 连续相同错误检测（防死循环）

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const nativeCalls = currentResp.toolCalls && currentResp.toolCalls.length > 0 ? currentResp.toolCalls : []
    const legacyCalls = nativeCalls.length === 0 ? parseToolCalls(rawReply) : []
    if (nativeCalls.length === 0 && legacyCalls.length === 0) break

    if (nativeCalls.length > 0) {
      console.log(`[tools] 轮 ${i + 1} 原生: ${nativeCalls.map((t: ToolCall) => t.function.name).join(', ')}`)
      for (const tc of nativeCalls) {
        const toolType = toolNameToType(tc.function.name)
        await feishuEditCard(progressMsgId, `- Using ${toolType}... ${getModelPrefix(session.model)}`)
      }
      const toolResults = await executeNativeToolCalls(nativeCalls, session.characterName, chatId, session)
      toolResults.filter(r => r.type === 'image' && r.imageUrl).forEach(r => images.push(r.imageUrl!))

      // 检测连续相同错误（连续 2 轮同一工具返回同一错误 → 跳出，防死循环）
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
        console.log('[tools] 检测到连续相同错误，停止循环')
        rawReply = stripToolCallXml(rawReply)
        break
      }

      const toolMessages: ChatMessage[] = toolResults.map(r => ({
        role: 'tool' as const,
        content: r.result + (r.imageUrl ? `\n图片: ${r.imageUrl}` : ''),
        tool_call_id: r.toolCallId,
      }))

      const nextResp = await chat([
        { role: 'system', content: system },
        ...baseMessages,
        { role: 'assistant', content: rawReply || '', tool_calls: nativeCalls },
        ...toolMessages,
      ], { model, maxTokens: 2048, tools: TOOLS })

      logEntries.push({ resp: nextResp, type: 'native', calls: nativeCalls, systemPreview: system.slice(0, 3000) })
      currentResp = nextResp
      rawReply = detectXmlToolCalls(currentResp)
      // 删改类操作后停止循环：防"查→删→再查→再删"死循环
      if (nativeCalls.some(tc => tc.function.name === 'memory_delete' || tc.function.name === 'profile_update')) {
        console.log(`[tools] 轮 ${i + 1} 含 memory_delete/profile_update，停止循环`)
        // 确保 rawReply 不含残留的 XML tool_call 标签
        rawReply = stripToolCallXml(rawReply)
        break
      }
    } else {
      console.log(`[tools] 轮 ${i + 1} 旧格式: ${legacyCalls.length} 个`)
      for (const tc of legacyCalls) {
        const toolType = tc.type === 'search' ? 'web_search' : 'image_gen'
        await feishuEditCard(progressMsgId, `- Using ${toolType}... ${getModelPrefix(session.model)}`)
      }
      const toolResults = await executeLegacyToolCalls(legacyCalls)
      toolResults.filter(r => r.type === 'image' && r.imageUrl).forEach(r => images.push(r.imageUrl!))

      const toolContext = toolResults.map(r => {
        if (r.type === 'search') return `【搜索结果："${r.query}"】\n${r.result}`
        if (r.type === 'image') return `【生成图片："${r.query}"】\n${r.result}`
        return ''
      }).join('\n\n')

      const nextResp = await chat([
        { role: 'system', content: system },
        ...baseMessages,
        { role: 'assistant', content: rawReply },
        { role: 'user', content: `[系统：以下是工具执行结果，请自然地融入你的回复中，不要提及工具的存在]\n\n${toolContext}` },
      ], { model, maxTokens: 2048 })

      logEntries.push({ resp: nextResp, type: 'legacy', calls: legacyCalls, systemPreview: system.slice(0, 3000) })
      currentResp = nextResp
      rawReply = detectXmlToolCalls(currentResp)
    }
  }

  if (currentResp.toolCalls && currentResp.toolCalls.length > 0) {
    console.warn(`[tools] 达到最大轮数 ${MAX_TOOL_ITERATIONS}，强制结束`)
  }

  // 兜底：循环后 rawReply 为空或太短 → 追调一次不带工具的 chat 拿文字总结
  if (!rawReply || rawReply.trim().length < 5) {
    console.log('[tools] rawReply 为空，触发 fallback chat（无工具）')
    try {
      const fallbackResp = await chat([
        { role: 'system', content: system },
        ...baseMessages,
        { role: 'user', content: '工具调用已达最大轮数或遇到重复错误。请直接以文字回答，不要使用任何工具。' },
      ], { model, maxTokens: 2048, tools: [] })
      rawReply = fallbackResp.content || ''
    } catch {
      // fallback 也失败，保持原始 rawReply
    }
  }

  return {
    finalContent: collapseBlankLines(rawReply),
    images,
    logEntries,
  }
}

async function handleCharacter(chatId: string, session: Session, text: string, senderId: string): Promise<void> {
  if (!text.trim()) return

  // 添加用户消息到历史
  const userMsg: Message = { role: 'user', content: text, ts: new Date().toISOString() }
  session.messages.push(userMsg)
  saveSession(session)

  // 构建 context
  const { system, messages } = buildMessagesForLLM(session)

  // 进度指示
  let progressMsgId = ''
  try {
    progressMsgId = await feishuSendProgress(chatId, 'thinking', session)
  } catch {}

  // 调用 LLM（带原生工具定义）
  try {
    const resp = await chat([
      { role: 'system', content: system },
      ...messages,
    ], {
      model: pickModelForCall(session, text),
      maxTokens: 2048,
      tools: TOOLS,
    })

    if (resp.usage) {
      logLlmCall({
        sessionId: session.id,
        model: resp.model || session.model,
        type: 'character',
        inputTokens: resp.usage.inputTokens || 0,
        outputTokens: resp.usage.outputTokens || 0,
        cacheReadTokens: resp.usage.cacheReadInputTokens,
        inputPreview: text.slice(0, 100),
        systemPreview: system.slice(0, 3000),
        rawContent: resp.rawContent,
      })
      // 保存真实上下文 token 数（用于进度百分比）
      if (resp.usage.inputTokens) {
        session.contextTokens = resp.usage.inputTokens
        saveSession(session)
      }
    }

    // ▶️ 工具调用循环（最多 5 轮）
    const toolResult = await runToolLoop(resp, messages, system, pickModelForCall(session), session, chatId, progressMsgId)
    let rawReply = toolResult.finalContent
    const generatedImages = toolResult.images

    // 记录每轮工具调用
    for (const entry of toolResult.logEntries) {
      if (entry.resp.usage) {
        logLlmCall({
          sessionId: session.id,
          model: entry.resp.model || session.model,
          type: 'tool',
          inputTokens: entry.resp.usage.inputTokens || 0,
          outputTokens: entry.resp.usage.outputTokens || 0,
          cacheReadTokens: entry.resp.usage.cacheReadInputTokens,
          inputPreview: `[工具] ${entry.calls.map((c: any) => c.function?.name || c.type).join(', ')}`,
          systemPreview: entry.systemPreview,
          rawContent: entry.resp.rawContent,
        })
      }
    }

    // 提取括号情感
    const { cleanText, styles } = extractVoiceStyle(truncateBrackets(rawReply))
    const voiceStyle = styles.length > 0 ? resolveVoiceStyle(styles[0]) : ''

    // 添加 assistant 消息到历史
    const assistantMsg: Message = {
      role: 'assistant',
      content: rawReply,
      ts: new Date().toISOString(),
      voiceStyle: voiceStyle || undefined,
    }
    session.messages.push(assistantMsg)
    saveSession(session)

    // 先 Done. 再全量输出文字
    if (progressMsgId) {
      await feishuEditCard(progressMsgId, `- Done. [${getModelPrefix(session.model)}-${getContextPct(session)}%]`)
    }
    // 去掉 LLM 回复里的 [M/D HH:MM] 时间戳前缀（LLM 从 context 里学到的）
    const cleanReply = rawReply.replace(/^(\[\d{1,2}\/\d{1,2}\s+\d{2}:\d{2}\]\s*)+/g, '').trim()
    await feishuCardReply(chatId, cleanReply || rawReply)

    // TTS
    if (ttsEnabled.get(chatId) && cleanText) {
      const ttsText = stripCodeBlocksForTTS(cleanText)
      if (ttsText) await sendTTS(chatId, ttsText, session.voice, voiceStyle || session.voiceStyle)
    }

    // 发送图片
    for (const imageUrl of generatedImages) {
      await feishuSendImage(chatId, imageUrl)
    }

    const usage = resp.usage
    if (usage) {
      const cacheInfo = usage.cacheReadInputTokens
        ? ` cache_read=${usage.cacheReadInputTokens}`
        : ''
      console.log(`[chat] model=${resp.model} in=${usage.inputTokens} out=${usage.outputTokens}${cacheInfo}`)
    }
  } catch (err: any) {
    console.error(`[chat] LLM error: ${err.message}`)
    await feishuReply(chatId, `模型调用失败: ${err.message}
发送 /model dsp 切换到 DeepSeek 或 /model mmx 切换到 MiniMax。`)
  }
}

// ── 场外指令处理 ──────────────────────────────────────────────────

async function handleOOC(chatId: string, session: Session, instruction: string, userText: string, senderId: string): Promise<void> {
  // 构建带场外指令的 user message
  let oocMessage = `[场外指令] ${instruction}`
  if (userText) {
    oocMessage += `\n\n---\n${userText}`
  }

  // 同角色对话处理
  const userMsg: Message = { role: 'user', content: oocMessage, ts: new Date().toISOString() }
  session.messages.push(userMsg)
  saveSession(session)

  const { system, messages } = buildMessagesForLLM(session)

  let progressMsgId = ''
  try { progressMsgId = await feishuSendProgress(chatId, 'thinking', session) } catch {}

  try {
    const resp = await chat([
      { role: 'system', content: system },
      ...messages,
    ], {
      model: pickModelForCall(session, userText),
      maxTokens: 2048,
      tools: TOOLS,
    })

    let rawReply: string
    let generatedImages: string[]
    let toolLogEntries: any[]

    if (resp.usage) {
      logLlmCall({
        sessionId: session.id,
        model: resp.model || session.model,
        type: 'ooc',
        inputTokens: resp.usage.inputTokens || 0,
        outputTokens: resp.usage.outputTokens || 0,
        cacheReadTokens: resp.usage.cacheReadInputTokens,
        inputPreview: (instruction + ' ' + userText).slice(0, 100),
        systemPreview: system.slice(0, 3000),
        rawContent: resp.rawContent,
      })
      if (resp.usage.inputTokens) {
        session.contextTokens = resp.usage.inputTokens
        saveSession(session)
      }
    }

    // ▶️ 工具调用循环（最多 5 轮）
    const toolResult = await runToolLoop(resp, messages, system, pickModelForCall(session), session, chatId, progressMsgId)
    rawReply = toolResult.finalContent
    generatedImages = toolResult.images
    toolLogEntries = toolResult.logEntries

    // 记录每轮工具调用
    for (const entry of toolLogEntries) {
      if (entry.resp.usage) {
        logLlmCall({
          sessionId: session.id,
          model: entry.resp.model || session.model,
          type: 'tool',
          inputTokens: entry.resp.usage.inputTokens || 0,
          outputTokens: entry.resp.usage.outputTokens || 0,
          cacheReadTokens: entry.resp.usage.cacheReadInputTokens,
          inputPreview: `[工具] ${entry.calls.map((c: any) => c.function?.name || c.type).join(', ')}`,
          systemPreview: entry.systemPreview,
          rawContent: entry.resp.rawContent,
        })
      }
    }

    const { cleanText, styles } = extractVoiceStyle(truncateBrackets(rawReply))
    const voiceStyle = styles.length > 0 ? resolveVoiceStyle(styles[0]) : ''

    const assistantMsg: Message = {
      role: 'assistant',
      content: rawReply,
      ts: new Date().toISOString(),
      voiceStyle: voiceStyle || undefined,
    }
    session.messages.push(assistantMsg)
    saveSession(session)

    // 先 Done./回复，再发语音
    const cleanReply2 = rawReply.replace(/^(\[\d{1,2}\/\d{1,2}\s+\d{2}:\d{2}\]\s*)+/g, '').trim()
    const replyToSend = cleanReply2 || rawReply
    if (progressMsgId) {
      await feishuEditCard(progressMsgId, replyToSend)
    } else {
      await feishuCardReply(chatId, replyToSend)
    }

    // TTS 状态只决定是否额外发语音
    if (ttsEnabled.get(chatId) && cleanText) {
      const ttsText = stripCodeBlocksForTTS(cleanText)
      if (ttsText) await sendTTS(chatId, ttsText, session.voice, voiceStyle || session.voiceStyle)
    }

    // 发送生成的图片
    for (const imageUrl of generatedImages) {
      await feishuSendImage(chatId, imageUrl)
    }
  } catch (err: any) {
    console.error(`[ooc] LLM error: ${err.message}`)
    await feishuReply(chatId, `模型调用失败: ${err.message}`)
  }
}

// ── 进度 + 模型前缀辅助 ────────────────────────────────────────────

const MODEL_PREFIXES: Record<string, string> = {
  'deepseek-v4-flash': 'dsf',
  'deepseek-v4-pro': 'dsp',
  'MiniMax-M3': 'mmx',
  'mimo-v2.5': 'mif',
  'mimo-v2.5-pro': 'mip',
}

// 折叠多余空行
function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n')
}

function getModelPrefix(model: string): string {
  return MODEL_PREFIXES[model] || model.slice(0, 3)
}

function cronToHuman(expr: string): string {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr
  const [min, hour, dom, month, dow] = parts
  const pad = (s: string) => s.padStart(2, '0')

  // 常见模式
  if (dom === '*' && month === '*') {
    if (dow === '*') return `每天 ${pad(hour)}:${pad(min)}`
    if (dow === '1-5') return `工作日 ${pad(hour)}:${pad(min)}`
    if (dow === '0,6') return `周末 ${pad(hour)}:${pad(min)}`
    const dayNames: Record<string, string> = { '0': '日', '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六' }
    if (dayNames[dow]) return `每周${dayNames[dow]} ${pad(hour)}:${pad(min)}`
  }
  if (dom !== '*' && month === '*' && dow === '*') return `每月${dom}号 ${pad(hour)}:${pad(min)}`
  if (min.startsWith('*/')) return `每${min.slice(2)}小时`
  return expr
}

// 上下文百分比：优先用 API 返回的真实 token 数，再 fallback 到估算
function getContextPct(session: Session): number {
  const maxTokens = 1_000_000 // MiniMax M3 上下文窗口
  if (session.contextTokens && session.contextTokens > 0) {
    return Math.min(100, Math.round((session.contextTokens / maxTokens) * 100))
  }
  // fallback：粗略文字估算
  const totalTokens = session.messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0)
  const pct = Math.min(100, Math.round((totalTokens / maxTokens) * 100))
  return totalTokens > 0 && pct === 0 ? 1 : pct
}

// ── 语音管道 ──────────────────────────────────────────────────────

function _ttsApiKey(): string {
  return process.env.MIMO_API_KEY || process.env.MIMO_KEY || ''
}

/** 剔除 TTS 不适合朗读的内容（仅代码块），用占位符替换以保持朗读连贯 */
function stripCodeBlocksForTTS(text: string): string {
  // 不用括号占位符的原因：extractVoiceStyle 在更早阶段把所有括号内容当成语音风格标签剥掉，
  // 但占位符是在 cleanText 之后才加的，会进入 TTS 文本。MiMo TTS 读括号可能卡壳。
  // 直接用纯中文文字更稳。
  //
  // 不处理行内代码 `xxx`：之前 TTS 朗读行内代码未出问题，先不动，等出问题再处理。
  // 代码块内部的反引号会被 ```...``` 一起捕获替换。
  let out = text.replace(/```[\s\S]*?```/g, '此处为代码块')
  out = out.replace(/\n{3,}/g, '\n\n').trim()
  return out
}

async function sendTTS(chatId: string, text: string, voice: string, style: string): Promise<void> {
  if (!_ttsApiKey()) return

  try {
    // MiMo TTS
    const audio: Record<string, string> = { voice, format: 'mp3' }
    if (style) audio.style = style

    const apiHost = process.env.MIMO_API_HOST || 'https://token-plan-cn.xiaomimimo.com'
    const ttsResp = await fetch(`${apiHost}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': _ttsApiKey() },
      body: JSON.stringify({
        model: 'mimo-v2.5-tts',
        messages: [{ role: 'assistant', content: text }],
        audio,
      }),
    })

    if (!ttsResp.ok) throw new Error(`TTS ${ttsResp.status}`)
    const ttsData = await ttsResp.json() as any
    const audioData = ttsData.choices?.[0]?.message?.audio?.data
    if (!audioData) throw new Error('TTS 无音频数据')

    // 保存 mp3
    const inboxDir = join(STATE_DIR, 'inbox')
    mkdirSync(inboxDir, { recursive: true })
    const mp3Path = join(inboxDir, `tts_${Date.now()}.mp3`)
    writeFileSync(mp3Path, Buffer.from(audioData, 'base64'))

    // ffmpeg 转 opus
    const { execSync } = await import('child_process')
    const opusPath = mp3Path.replace('.mp3', '.opus')
    execSync(`ffmpeg -y -i "${mp3Path}" -c:a libopus -b:a 32k "${opusPath}" 2>/dev/null`, { timeout: 30000 })

    // 上传飞书 + 发送语音消息
    const fileResp = await feishuClient.im.file.create({
      data: { file_type: 'opus', file_name: basename(opusPath), file: createReadStream(opusPath) },
    })
    const fileKey = fileResp?.file_key
    if (!fileKey) throw new Error('语音上传失败')

    await feishuClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'audio',
        content: JSON.stringify({ file_key: fileKey }),
      },
    })

    // 清理临时文件
    try { unlinkSync(mp3Path) } catch {}
    try { unlinkSync(opusPath) } catch {}
  } catch (err: any) {
    console.error(`[tts] 语音发送失败: ${err.message}`)
  }
}

function _doubaoKey(): string {
  return process.env.DOUBAO_API_KEY || ''
}

async function transcribeAudio(filePath: string): Promise<string> {
  if (!_doubaoKey()) throw new Error('DOUBAO_API_KEY 未配置')

  const { execSync } = await import('child_process')
  const wavPath = filePath.replace(/\.[^.]+$/, '') + '_tmp.wav'
  try {
    execSync(`ffmpeg -y -i "${filePath}" -ar 16000 -ac 1 "${wavPath}" 2>/dev/null`, { timeout: 30000 })
  } catch (e: any) {
    throw new Error(`ffmpeg 转换失败: ${e.message}`)
  }

  try {
    const audioBuf = readFileSync(wavPath)
    const b64 = audioBuf.toString('base64')
    const resp = await fetch('https://ark.cn-beijing.volces.com/api/v3/responses', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${_doubaoKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'doubao-seed-2-0-mini-260428',
        input: [{
          role: 'user',
          content: [
            { type: 'input_audio', audio_url: `data:audio/wav;base64,${b64}` },
            { type: 'input_text', text: '请将这段语音内容完整转写为文字，保留原话，用中文输出。' },
          ],
        }],
      }),
    })

    const data = await resp.json() as any
    if (data.error) throw new Error(`Doubao API: ${data.error.message}`)
    return data.output?.[1]?.content?.[0]?.text || '（未识别到语音内容）'
  } finally {
    try { unlinkSync(wavPath) } catch {}
  }
}

// ── 飞书消息收发 ──────────────────────────────────────────────────

/**
 * MiniMax VLM 识图：下载飞书图片 → base64 → VLM 分析 → 返回文字描述
 * API: https://api.minimaxi.com/v1/coding_plan/vlm
 * 需 MINIMAX_API_KEY（与对话模型同 key）
 */
// ── 飞书 Token 缓存（VLM 识图直调用） ────────────────────────────

let _feishuToken: { token: string; expiresAt: number } | null = null

async function getFeishuToken(): Promise<string> {
  if (_feishuToken && Date.now() < _feishuToken.expiresAt - 300_000) {
    return _feishuToken.token
  }
  const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  })
  if (!resp.ok) throw new Error(`获取 token 失败: ${resp.status}`)
  const data = await resp.json() as any
  if (data.code !== 0) throw new Error(`获取 token 失败: ${data.msg}`)
  _feishuToken = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire || 7200) * 1000,
  }
  return _feishuToken.token
}

async function describeFeishuImage(messageId: string, fileKey: string): Promise<string> {
  const key = process.env.MINIMAX_API_KEY || ''
  if (!key) return '（识图不可用：未配置 MINIMAX_API_KEY）'

  // 1. 下载图片（直调飞书 API，不经过 SDK 的 messageResource.get 层，避免版本兼容问题）
  let imageBuf: Buffer | null = null
  try {
    const resp = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=image`,
      {
        headers: {
          // 用 SDK 内部的 request 来获取 token（或者直接拿已经缓存的 token）
          'Authorization': `Bearer ${await getFeishuToken()}`,
        },
      },
    )
    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.statusText)
      throw new Error(`飞书 API ${resp.status}: ${errText.slice(0, 100)}`)
    }
    const ab = await resp.arrayBuffer()
    if (!ab || ab.byteLength === 0) throw new Error('图片数据为空')
    imageBuf = Buffer.from(ab)
  } catch (err: any) {
    console.error(`[feishu] 下载图片失败: ${err.message}`)
    return '（图片下载失败）'
  }
  if (!imageBuf || imageBuf.length === 0) return '（图片为空）'
  if (imageBuf.length > 10 * 1024 * 1024) return '（图片超过 10MB）'

  // 2. base64 → VLM API
  const b64 = imageBuf.toString('base64')
  try {
    const resp = await fetch('https://api.minimaxi.com/v1/coding_plan/vlm', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: '请详细描述这张图片的内容，包括主体、颜色、文字、环境等。如果不是图片，请如实说明。',
        image_url: `data:image/png;base64,${b64}`,
      }),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`MiniMax VLM: ${resp.status} ${text.slice(0, 200)}`)
    }
    const data = await resp.json() as any
    return (data.content || '').trim() || '（VLM 未返回描述）'
  } catch (err: any) {
    console.error(`[feishu] VLM 识图失败: ${err.message}`)
    return `（识图失败: ${err.message.slice(0, 100)}）`
  }
}

async function feishuReply(chatId: string, text: string): Promise<void> {
  try {
    await feishuClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    })
  } catch (err: any) {
    console.error(`[feishu] reply error: ${err.message}`)
  }
}

// 角色对话专用：始终用 card 富文本格式
async function feishuCardReply(chatId: string, text: string): Promise<void> {
  try {
    const card = markdownToCard('', text)
    await feishuClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
    })
  } catch (err: any) {
    console.error(`[feishu] card reply error: ${err.message}`)
  }
}

// 发送图片消息
async function feishuSendImage(chatId: string, imageUrl: string): Promise<void> {
  try {
    const resp = await fetch(imageUrl)
    if (!resp.ok) throw new Error(`下载图片失败: ${resp.status}`)
    const buffer = Buffer.from(await resp.arrayBuffer())

    // 保存临时文件
    const tmpPath = join(STATE_DIR, 'inbox', `img_${Date.now()}.png`)
    mkdirSync(join(STATE_DIR, 'inbox'), { recursive: true })
    writeFileSync(tmpPath, buffer)

    // 上传到飞书
    const imgResp = await feishuClient.im.image.create({
      data: { image_type: 'message', image: createReadStream(tmpPath) },
    })
    const imageKey = imgResp?.image_key
    if (!imageKey) throw new Error('图片上传失败')

    // 发送图片消息
    await feishuClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      },
    })

    // 清理临时文件
    try { unlinkSync(tmpPath) } catch {}
  } catch (err: any) {
    console.error(`[feishu] 图片发送失败: ${err.message}`)
  }
}

// 进度指示（CC 同款格式）
async function feishuSendProgress(chatId: string, type: string, session: Session): Promise<string> {
  const prefix = getModelPrefix(session.model)
  const pct = getContextPct(session)
  const suffix = `[${prefix}-${pct}%]`
  const label = type === 'thinking' ? 'Thinking' : `Using ${type}`
  const text = `${label}... ${suffix}`
  const card = {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '' }, template: 'grey' },
    body: { elements: [{ tag: 'markdown', content: `- ${text}` }] },
  }
  const resp = await feishuClient.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
  })
  return resp?.data?.message_id || resp?.message_id || ''
}

// 编辑卡片内容
async function feishuEditCard(messageId: string, text: string): Promise<void> {
  const card = markdownToCard('', text)
  try {
    await (feishuClient as any).request({
      method: 'PATCH',
      url: `/open-apis/im/v1/messages/${messageId}`,
      data: { content: JSON.stringify(card) },
    })
  } catch (err: any) {
    console.error(`[feishu] edit card error: ${err.message}`)
  }
}

// 删除消息
async function feishuDeleteMsg(messageId: string): Promise<void> {
  try {
    await feishuClient.im.message.delete({ path: { message_id: messageId } })
  } catch {}
}

function markdownToCard(title: string, markdown: string): any {
  const lines = markdown.split('\n')
  const elements: any[] = []
  let inCode = false
  let codeContent = ''
  let codeLang = 'text'

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) {
        elements.push({ tag: 'markdown', content: '```' + codeLang + '\n' + codeContent.trim() + '\n```' })
        codeContent = ''; codeLang = 'text'; inCode = false
      } else {
        inCode = true
        const m = line.match(/^```(\w*)$/)
        if (m) codeLang = m[1] || 'text'
      }
      continue
    }
    if (inCode) { codeContent += line + '\n'; continue }
    if (line.trim() === '') continue

    // 标题
    const h = line.match(/^(#{1,3})\s+(.*)/)
    if (h) { elements.push({ tag: 'markdown', content: h[2], text_size: h[1].length === 1 ? 'large' : h[1].length === 2 ? 'medium' : 'small' }); continue }

    elements.push({ tag: 'markdown', content: line })
  }

  if (inCode) {
    elements.push({ tag: 'markdown', content: '```' + codeLang + '\n' + codeContent.trim() + '\n```' })
  }

  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: title || '' }, template: 'blue' },
    body: { elements },
  }
}

// ── 飞书 WebSocket 事件订阅 ───────────────────────────────────────

async function fetchBotInfo(): Promise<void> {
  try {
    const resp = await (feishuClient as any).request({
      method: 'GET', url: '/open-apis/bot/v3/info/', data: {},
    })
    botOpenId = resp?.bot?.open_id ?? ''
    if (botOpenId) console.log(`[feishu] bot open_id = ${botOpenId}`)
  } catch (err) {
    console.error(`[feishu] 获取 bot info 失败: ${err}`)
  }
}

const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data: any) => {
    try {
      const event = data.event ?? data
      const sender = event.sender
      const message = event.message
      if (!sender || !message) return

      const senderId = sender.sender_id?.open_id ?? ''
      if (!senderId || (botOpenId && senderId === botOpenId)) return

      const chatId = message.chat_id
      const messageType = message.message_type ?? 'text'
      let text = ''

      // 提取消息文本
      if (messageType === 'text') {
        try {
          const parsed = JSON.parse(message.content || '{}')
          text = parsed.text || ''
        } catch {
          text = message.content || ''
        }
      } else if (messageType === 'audio') {
        // 语音消息 → 转写
        try {
          const parsed = JSON.parse(message.content || '{}')
          if (parsed.file_key) {
            const inboxDir = join(STATE_DIR, 'inbox')
            mkdirSync(inboxDir, { recursive: true })
            const opusPath = join(inboxDir, `audio_${Date.now()}.opus`)

            // 下载语音文件
            const resp = await feishuClient.im.messageResource.get({
              path: { message_id: message.message_id, file_key: parsed.file_key },
              params: { type: 'file' },
            })
            const buf = await toBuffer(resp)
            if (buf) {
              writeFileSync(opusPath, buf)
              text = await transcribeAudio(opusPath)
              try { unlinkSync(opusPath) } catch {}
            }
          }
        } catch (err: any) {
          console.error(`[feishu] 语音转写失败: ${err.message}`)
          return
        }
      } else if (messageType === 'location') {
        // 位置消息 → 存盘 + 注入对话历史（让 LLM 当作用户消息处理）
        try {
          const parsed = JSON.parse(message.content || '{}')
          const lat = parseFloat(parsed.latitude)
          const lng = parseFloat(parsed.longitude)
          if (isNaN(lat) || isNaN(lng)) {
            console.error('[feishu] 位置消息经纬度无效')
            return
          }
          const locData = {
            latitude: lat,
            longitude: lng,
            name: parsed.name || '未知位置',
            address: parsed.address || '',
            updated_at: new Date().toISOString(),
          }
          saveLocation(locData)
          console.log(`[feishu] 位置已记录: ${locData.name} (${lat}, ${lng})`)
          // 构造文本，让 LLM 当成用户消息处理（不硬编码回复，避免自相矛盾）
          text = `[位置] 我在 ${locData.name}（${lat.toFixed(4)}, ${lng.toFixed(4)}）${locData.address ? ' — ' + locData.address : ''}`
        } catch (err: any) {
          console.error(`[feishu] 位置消息处理失败: ${err.message}`)
          return
        }
      } else if (messageType === 'image') {
        // 图片消息 → VLM 识图 + 注入对话历史
        try {
          const parsed = JSON.parse(message.content || '{}')
          const fileKey = parsed.image_key
          if (!fileKey) {
            console.error('[feishu] 图片消息缺少 image_key')
            return
          }
          console.log(`[feishu] 收到图片, 开始 VLM 识图...`)
          const description = await describeFeishuImage(message.message_id, fileKey)
          console.log(`[feishu] VLM 描述: ${description.slice(0, 100)}...`)
          text = `[图片] ${description}`
        } catch (err: any) {
          console.error(`[feishu] 图片消息处理失败: ${err.message}`)
          return
        }
      } else if (messageType === 'post') {
        // 富文本消息（多行文本/emoji/链接等）→ 提取纯文本
        try {
          const parsed = JSON.parse(message.content || '{}')
          const postContent = parsed.zh_cn || parsed.en_us || parsed
          const paragraphs: string[] = []
          if (postContent.content && Array.isArray(postContent.content)) {
            for (const line of postContent.content) {
              const parts: string[] = []
              if (Array.isArray(line)) {
                for (const seg of line) {
                  if (seg.tag === 'text' || seg.tag === 'a' || seg.tag === 'at') {
                    parts.push(seg.text || '')
                  }
                }
              }
              paragraphs.push(parts.join(''))
            }
          }
          text = paragraphs.join('\n')
          if (text) console.log('[feishu] post消息解析成功: ' + text.slice(0, 80))
        } catch (err) {
          console.error('[feishu] post消息解析失败: ' + err.message)
          return
        }
      } else {
        // 其他消息类型暂不处理
        return
      }

      // 去掉 @bot mention
      if (message.mentions) {
        for (const m of message.mentions) {
          if (m.id?.open_id === botOpenId) {
            text = text.replace(m.key, '').trim()
          }
        }
      }

      if (!text.trim()) return

      // 去重 + 过滤重连后重放的历史消息
      if (isDuplicate(message.message_id)) return
      if (message.create_time && parseInt(message.create_time) < START_TIME) return

      console.log(`[feishu] ${senderId}: ${text.slice(0, 80)}`)
      await handleMessage(chatId, text, senderId, message.message_id)
    } catch (err: any) {
      console.error(`[feishu] 处理消息失败: ${err.message}`)
    }
  },
})

// Buffer 工具
async function toBuffer(resp: any): Promise<Buffer | null> {
  if (!resp) return null
  if (Buffer.isBuffer(resp)) return resp
  if (resp instanceof ArrayBuffer) return Buffer.from(resp)
  if (typeof resp.arrayBuffer === 'function') return Buffer.from(await resp.arrayBuffer())
  if (typeof resp.getReadableStream === 'function') {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      const stream = resp.getReadableStream()
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', () => resolve(null))
    })
  }
  const data = resp?.data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (Buffer.isBuffer(data)) return data
  try { return Buffer.from(resp) } catch { return null }
}

// ── 启动 ──────────────────────────────────────────────────────────

// Health check HTTP server
// ── HTTP API & Admin ──────────────────────────────────────────────

const ADMIN_HTML_PATH = join(import.meta.dir, '..', 'public', 'admin.html')
const USD_TO_CNY = 7.2

function apiJson(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })
}

// 解析 session ID 从 /api/sessions/:id
function extractSessionId(pathname: string): string | null {
  const m = pathname.match(/^\/api\/sessions\/([^/]+)$/)
  return m ? decodeURIComponent(m[1]) : null
}

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    const pathname = url.pathname

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' } })
    }

    try {
      // ── 管理页面 ──
      if (pathname === '/admin' || pathname === '/admin.html') {
        if (existsSync(ADMIN_HTML_PATH)) {
          const html = readFileSync(ADMIN_HTML_PATH, 'utf8')
          return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        }
        return new Response('Admin page not found. Create public/admin.html', { status: 404 })
      }

      // ── Health ──
      if (pathname === '/health') {
        return apiJson({ status: 'ok', sessions: listSessions().length })
      }

      // ── API: 会话列表 ──
      if (pathname === '/api/sessions' && req.method === 'GET') {
        const all = listSessions()
        return apiJson(all.map(s => {
          const costUsd = getSessionCost(s.id)
          return {
            id: s.id, name: s.name, characterName: s.characterName,
            model: s.model, messages: s.messages.length, saves: s.saves.length,
            cost: Math.round(costUsd * USD_TO_CNY * 1000) / 1000,
            updatedAt: s.messages.length > 0 ? s.messages[s.messages.length - 1].ts : s.saves.length > 0 ? s.saves[s.saves.length - 1].ts : '',
          }
        }))
      }

      // ── API: 单会话 ──
      const sessionId = extractSessionId(pathname)
      if (sessionId && req.method === 'GET') {
        const session = loadSession(sessionId)
        if (!session) return apiJson({ error: 'Session not found' }, 404)
        return apiJson(session)
      }

      // ── API: 更新会话 ──
      if (sessionId && req.method === 'PUT') {
        const session = loadSession(sessionId)
        if (!session) return apiJson({ error: 'Session not found' }, 404)
        const body = await req.json() as any
        if (body.characterPrompt !== undefined) session.characterPrompt = body.characterPrompt
        if (body.characterName !== undefined) session.characterName = body.characterName
        if (body.scenePrompt !== undefined) session.scenePrompt = body.scenePrompt
        if (body.voice !== undefined) session.voice = body.voice
        if (body.voiceStyle !== undefined) session.voiceStyle = body.voiceStyle
        if (body.model !== undefined) session.model = body.model
        saveSession(session)
        return apiJson(session)
      }

      // ── API: LLM 日志 ──
      if (pathname === '/api/logs' && req.method === 'GET') {
        const limit = parseInt(url.searchParams.get('limit') || '50')
        const offset = parseInt(url.searchParams.get('offset') || '0')
        const sessionIdParam = url.searchParams.get('sessionId') || undefined
        const modelParam = url.searchParams.get('model') || undefined
        const typeParam = url.searchParams.get('type') || undefined
        const result = queryLogs({ limit, offset, sessionId: sessionIdParam, model: modelParam, type: typeParam })
        return apiJson(result)
      }

      // ── API: 统计数据 ──
      if (pathname === '/api/stats' && req.method === 'GET') {
        return apiJson(getStats())
      }

      // ── API: Presets（角色模板列表） ──
      if (pathname === '/api/presets' && req.method === 'GET') {
        const { PRESETS } = await import('./presets')
        return apiJson(PRESETS)
      }

      // ── API: 清空日志 ──
      if (pathname === '/api/logs' && req.method === 'DELETE') {
        try { writeFileSync(join(STATE_DIR, 'llm-logs.jsonl'), '') } catch {}
        return apiJson({ ok: true })
      }

      // ── API: Cron - 记忆审阅（外部 cron 触发，需 token 保护） ──
      if (pathname === '/api/cron/memory_review' && req.method === 'POST') {
        const token = url.searchParams.get('token') || ''
        const expected = process.env.CRON_TOKEN || ''
        if (!expected || token !== expected) {
          return apiJson({ error: 'Unauthorized' }, 401)
        }
        const role = url.searchParams.get('role') || ''
        if (!role) return apiJson({ error: 'Missing role' }, 400)
        const extractModel = process.env.MEMORY_EXTRACT_MODEL || 'deepseek-v4-flash'
        void llmReviewTop(role, extractModel).then(toDelete => {
          let deleted = 0
          for (const id of toDelete) {
            if (deleteMemoryById(role, id)) deleted++
          }
          process.stderr.write(`[memory/cron-review] role=${role} deleted=${deleted}/${toDelete.length}\n`)
        })
        return apiJson({ ok: true, queued: true })
      }

    } catch (err: any) {
      return apiJson({ error: err.message }, 500)
    }

    // ── CLI 测试端点 ──
    if (pathname === '/api/cli/send' && req.method === 'POST') {
      lastUserMsgAt = Date.now()  // CLI 消息也算用户活跃
      const body = await req.json() as any
      const text = body.text || ''
      if (!text) return apiJson({ error: 'Missing text' }, 400)

      // 复用或创建 cli session
      const cliChatId = 'cli:default'
      let session = getActiveSession(cliChatId)
      if (!session) {
        const preset = PRESETS[0]
        session = createSession(preset.name, preset.persona, preset.scene, preset.voice, preset.voiceStyle)
        setActiveSession(cliChatId, session)
      }

      // 系统命令
      if (text.startsWith('/')) {
        const cmd = parseSystemCommand(text.slice(1))
        let reply = ''
        switch (cmd.action) {
          case 'status':
            reply = `角色: ${session.characterName}\n模型: ${session.model}\n消息: ${session.messages.length}`
            break
          case 'model':
            if (cmd.args[0]) { session.model = resolveModelAlias(cmd.args[0]); saveSession(session); reply = `模型: ${session.model}` }
            else reply = `当前: ${session.model}`
            break
          case 'new':
            session = createSession(PRESETS[0].name, PRESETS[0].persona, PRESETS[0].scene, PRESETS[0].voice, PRESETS[0].voiceStyle)
            setActiveSession(cliChatId, session)
            reply = '新会话已创建'
            break
          case 'note': {
            const sub = cmd.args[0]
            if (sub === 'del' && cmd.args[1]) {
              const ok = deleteNote(cmd.args[1])
              reply = ok ? '已删除笔记。' : '找不到该笔记。'
            } else if (sub) {
              const notes = searchNotes(cmd.args.join(' '))
              reply = notes.length === 0 ? '未找到相关笔记。' : notes.map(n => `- ${n.content} [${n.id.slice(0, 8)}]`).join('\n')
            } else {
              const notes = listNotes()
              reply = notes.length === 0 ? '暂无笔记。' : notes.map(n => `- ${n.content} [${n.id.slice(0, 8)}]`).join('\n')
            }
            break
          }
          default:
            reply = 'CLI 命令: /status /model <别名> /new /note'
        }
        return apiJson({ reply, sessionId: session.id })
      }

      // 普通消息 → LLM
      session.messages.push({ role: 'user', content: text, ts: new Date().toISOString() })
      saveSession(session)

      const { system, messages } = buildMessagesForLLM(session)
      try {
        const resp = await chat([
          { role: 'system', content: system },
          ...messages,
        ], { model: pickModelForCall(session), maxTokens: 2048, tools: TOOLS })

        if (resp.usage) {
          logLlmCall({ sessionId: session.id, model: resp.model || session.model, type: 'character', inputTokens: resp.usage.inputTokens || 0, outputTokens: resp.usage.outputTokens || 0, cacheReadTokens: resp.usage.cacheReadInputTokens, inputPreview: text.slice(0, 100), systemPreview: system.slice(0, 3000), rawContent: resp.rawContent })
        }

        // ▶️ 工具调用循环（最多 5 轮）
        const toolResult = await runToolLoop(resp, messages, system, pickModelForCall(session), session, cliChatId, '')
        const rawReply = toolResult.finalContent

        session.messages.push({ role: 'assistant', content: rawReply, ts: new Date().toISOString() })
        saveSession(session)
        return apiJson({ reply: rawReply, model: session.model, sessionId: session.id })
      } catch (err: any) {
        return apiJson({ error: err.message }, 500)
      }
    }

    return new Response('Lomo', { status: 200 })
  },
})
console.log(`[Lomo] HTTP health on :${PORT}`)

// ── 主动消息决策（scheduler tick 调用）───────────────────────────

/**
 * v1.0 主动决策流程：
 *   1. 读 proactive.json
 *   2. 检查是否到 20-50min 随机间隔
 *   3. 找第一个有 active session 的 chatId
 *   4. 读 session + buildMessagesForLLM
 *   5. 追加 trigger 消息（临时，不写盘）
 *   6. 调 LLM（maxTokens=512, tools=[]）
 *   7. 判断 SILENCE / 正常 / 异常
 *   8. SILENCE → 记录沉默，session 不动
 *   9. 正常 → checkHardLimit → 追加 session + 发送 + 记录
 *  10. 异常 → 记录 invalid，session 不动
 */
async function runProactiveDecision(): Promise<void> {
  // 1. 加载状态
  let record = loadProactive()

  // 2. 是否到触发间隔（20-50 分钟随机）
  if (!shouldTriggerProactiveCheck(record, 20, 30)) {
    return  // 还不到点
  }

  // 3. 冷却检查：10 分钟内有聊天 → 跳过本轮
  if (lastUserMsgAt > 0 && Date.now() - lastUserMsgAt < 10 * 60_000) {
    record = recordSilence(record, 'user_active')
    saveProactive(record)
    return
  }

  // 4. 找第一个有 active session 的 chatId
  let chatId: string | null = null
  let session: Session | null = null
  for (const [cid, sid] of activeSessions.entries()) {
    const s = loadSession(sid)
    if (s && s.messages.length > 0) {
      chatId = cid
      session = s
      break
    }
  }
  if (!chatId || !session) {
    // 没有活跃对话，不主动
    record = recordSilence(record, 'no_active_session')
    saveProactive(record)
    return
  }

  // 4. 构建 context（完整 Lomo persona + 全量历史）
  const { system, messages } = buildMessagesForLLM(session)

  // 5. 构造触发消息（不写盘，临时）
  const triggerMsg: ChatMessage = {
    role: 'user',
    content: buildTriggerMessage(record),
  }

  // 6. 调 LLM（缓存命中率高）
  let resp
  try {
    resp = await chat([
      { role: 'system', content: system },
      ...messages,
      triggerMsg,
    ], { model: pickModelForCall(session), maxTokens: 512, tools: [] })
  } catch (err: any) {
    process.stderr.write(`[proactive] LLM 调用失败: ${err.message}\n`)
    return
  }

  const rawContent = (resp.content ?? '').trim()

  // 7. 判断 SILENCE
  const silence = isSilence(rawContent)
  if (silence.silent) {
    if (silence.reason === 'llm_silence') {
      process.stderr.write(`[proactive] Lomo 选择沉默 (chatId=${chatId})\n`)
      record = recordSilence(record, 'llm_silence')
    } else {
      process.stderr.write(`[proactive] 无效输出 (${silence.reason}): ${rawContent.slice(0, 80)}\n`)
      record = recordInvalid(record, silence.reason ?? 'unknown')
    }
    saveProactive(record)
    return
  }

  // 8. 硬兜底检查
  const limit = checkHardLimit(record)
  if (!limit.allowed) {
    process.stderr.write(`[proactive] 触发兜底: ${limit.reason}\n`)
    record = triggerPause(record, limit.reason ?? 'unknown')
    saveProactive(record)
    // 飞书告警
    try {
      await feishuCardReply(chatId, `⚠️ Lomo 主动消息触发兜底：${limit.reason}，暂停 ${record.paused_until ? Math.round((new Date(record.paused_until).getTime() - Date.now()) / 3600_000) : 6} 小时。你主动找我照常。`)
    } catch {}
    return
  }

  // 9. 正常发送：追加 session + 发飞书 + 记录
  const topic = extractTopic(rawContent)
  session.messages.push({
    role: 'assistant',
    content: rawContent,
    ts: new Date().toISOString(),
  })
  session.lastActiveAt = new Date().toISOString()
  saveSession(session)

  try {
    await feishuCardReply(chatId, rawContent)
  } catch (err: any) {
    process.stderr.write(`[proactive] 飞书发送失败: ${err.message}\n`)
    // 消息已写入 session，但不计入成功
    return
  }

  record = recordSend(record, rawContent, topic)
  saveProactive(record)
  process.stderr.write(`[proactive] 已发送 (chatId=${chatId}, topic=${topic}): ${rawContent.slice(0, 50)}\n`)
}

// 提醒/任务调度器
initScheduler({
  sendCard: feishuCardReply,
  chatFn: chat,
  presets: PRESETS,
  findChatId: (_role: string) => {
    // 返回任意飞书 chatId（全局统一输出）
    for (const chatId of activeSessions.keys()) {
      return chatId
    }
    return null
  },
  runProactiveDecision,
  forceCleanupAllSessions: async () => {
    // 强制清理所有活跃 session（用于每天 4:30 兜底）
    let count = 0
    const chatIds = Array.from(activeSessions.keys())
    for (const chatId of chatIds) {
      const sessionId = activeSessions.get(chatId)
      if (!sessionId) continue
      const session = loadSession(sessionId)
      if (session) {
        runSessionEndCleanup(session)
        count++
      }
      activeSessions.delete(chatId)
      try { unlinkSync(join(STATE_DIR, 'sessions', `${sessionId}.json`)) } catch {}
      // 4:30 清理后用同 chatId 立刻建占位 session，让 bot_private cron reminder 下次 tick 还能 findChatId 命中
      const lomoPreset = PRESETS.find(p => p.id === 'lomo') || PRESETS[0]
      const newSession = createSession(lomoPreset.name, lomoPreset.persona, lomoPreset.scene, lomoPreset.voice, lomoPreset.voiceStyle)
      setActiveSession(chatId, newSession)
    }
    saveActiveSessions()
    return count
  },
})
startScheduler()

// 飞书 WebSocket
await fetchBotInfo()

const wsClient = new lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  loggerLevel: lark.LoggerLevel.error,
})

wsClient.start({ eventDispatcher }).then(() => {
  console.log('[Lomo] 飞书 WebSocket 已连接')
}).catch((err: any) => {
  console.error(`[Lomo] WebSocket 连接失败: ${err}`)
  process.exit(1)
})

// 优雅关闭
process.on('SIGTERM', () => { stopScheduler(); wsClient?.stop?.(); setTimeout(() => process.exit(0), 300) })
process.on('SIGINT', () => { stopScheduler(); wsClient?.stop?.(); setTimeout(() => process.exit(0), 300) })

console.log('[Lomo] 启动完成')
