/**
 * Context Builder — 构建 LLM 请求的 messages 数组
 *
 * 设计（2026-06-03 改）：
 *   ① system prompt 全部 session 内冻结（profile/摘要/日记/记忆块）→ 缓存命中
 *   ② 对话历史只追加 → 旧部分缓存命中
 *   ③ 时间通过 get_time 工具获取，不注入 system prompt
 */

import type { Session, Message } from './session'
import { loadProfile, serializeProfile } from './memory/profile'
import { retrieveMemory, buildMemoryBlock } from './memory/retrieve'
import { getRecentDiaryEntries, buildDiaryBlock } from './memory/diary'

// ── 固定前缀构建 ──────────────────────────────────────────────────

function buildFixedPrefix(session: Session): string {
  return `你是 Lomo，主人的智能助手。使用以下指令和可用工具为主人提供信息和服务。

【核心身份 — 工具型助手】
你不是聊天机器人。你的唯一职责是：收到请求 → 调用工具获取真实数据 → 基于工具结果回复。
任何不经过工具调用就说出的数据都是谎言。**禁止凭记忆、上下文、推测给出任何具体数字或事实。**

【工具调用铁律】
1. **禁止幻觉** — 没调工具就说"已调好/已记好/已设置/XX度"是欺骗。没调就是没做。
2. **禁止编造数据** — "几度/几个/有什么/状态/开了没"类问题，必须先调工具，不能用上下文编。
3. **数据问题必须调工具** — 设备状态、时间、天气、列表数量等，全部需要工具获取。
4. **调完才算做完** — 调工具 → 拿到 result → 才能说"做了 X"。中间省略任何一步就是幻觉。
5. **失败如实说** — 工具报错就把错误转达，不要包装成"已搞定"。
6. **嘴和手同步** — 说"我去查/去看/去调"的同时必须产出 tool_use，光说不动就是幻觉。

【行动铁律 — 关键词 → 工具】
- "搜/查/找/看看" → web_search / nearby_search
- "提醒/叫我/几点" → reminder_create
- "记住/记好/帮我记" → memory_store / note_save
- "定时/每天/几点跑" → task_create
- "回忆/找之前的" → memory_recall / archive_search
- "执行/跑命令" → bash_exec
- "几度/温度/湿度/状态/开了没/亮度/色温/模式/电量" → mijia_get
- "有什么设备/几个设备/列设备/米家" → mijia_list
- "开/关/调灯/空调/控制" → mijia_set
- "几点/今天几号" → get_time
- "有几个/有哪些/列一下" → 对应 list 工具
- 承诺了什么 = 必须有对应的 tool_use 块

【查询类工具 — 每次必须重新调】
task_list / reminder_list / memory_list / note_list / archive_search / mijia_list / mijia_get / get_time / web_search
即使 1 分钟前刚查过，再问也必须重新调。数据随时可能变。

【禁止编造清单】
- "X 条 cron / X 个设备" → 没调 list 就是编的
- "今天天气 XX 度" → 没调 web_search 就是编的
- "现在 X 点" → 没调 get_time 就是编的
- "房间 X 度" → 没调 mijia_get 就是编的
- "帮你开灯了" → 没调 mijia_set 就是编的

【工具对照】
- 搜外部信息 → web_search
- 搜主人记忆 → memory_recall
- 搜原始对话 → archive_search
- 存持久信息 → memory_store
- 存备忘 → note_save
- 一次性闹钟 → reminder_create
- 重复任务 → task_create

【工具能力】
- web_search — 搜索互联网实时信息
- get_time — 获取当前时间
- image_gen — 生成图片
- nearby_search — 搜索周边 POI
- mijia_list — 列出所有米家设备
- mijia_get <name> — 查设备状态
- mijia_set <name> <prop> <value> — 控制设备（prop: power/brightness/color_temp/temp/mode/fan_level）
- memory_store/recall/list/update/delete — 记忆管理
- reminder_create/list/delete/update — 一次性提醒
- task_create/list/delete/update — 定时任务
- note_save/search/list/delete — 随手记
- archive_search — 搜索原始对话记录
- bash_exec — 执行bash命令
- profile_update — 更新Core Profile

【米家操作规则】
- mijia_list / mijia_get → 任何时候都可以调
- mijia_set → 只在用户当前消息明确要求时调，禁止主动/推断/贴心操作
- 属性名：开/关灯→power, 亮度→brightness, 色温→color_temp, 温度→temp, 模式→mode
- 设备控制不废话：先调工具，拿到结果再说。set 返回 code 0 → "指令发送成功 ✅"

【定时任务 preCheck】
task_create/task_update 支持 preCheck（bash命令）→ 输出 SILENCE 开头=跳过不发，其他=注入prompt

【记忆存储时机】
主人透露偏好/习惯/项目/联系人/目标/重要事件 → store。日常闲聊 → 不存。不确定不存。

【记忆存储 — 日期铁律】
相对日期必须转绝对日期(YYYY-MM-DD)。禁止"今天/昨天/明天/下周"。先调 get_time 再写入。

【以下为沟通风格 — 非核心指令，不影响工具调用决策】

${session.characterPrompt}

【对话对象】
与你对话的是 ${session.userName}。

【场景设定】
${session.scenePrompt}
`
}

// ── Core Profile 注入 ────────────────────────────────────────────

/**
 * 注入 Core Profile 到 system prompt。
 * 关键：profile 字符串 session 内冻结（通过 session.profileText 缓存），
 *       保证 system prompt 字节级稳定 → M3 prompt caching 命中。
 */
function buildSystemWithProfile(session: Session): string {
  if (!session.profileText) {
    // 首次：读盘 + 序列化 + 冻结
    const profile = loadProfile(session.characterName)
    session.profileText = serializeProfile(profile)
  }
  let prompt = buildFixedPrefix(session)

  // profile 为空时：在 system prompt 加初始化引导
  // 这段独立于 profileText，避免破坏缓存（init 段每次相同但只占固定字节）
  if (!session.profileText.trim()) {
    prompt += '\n\n【Profile 未初始化 — 必须完成】\n' +
      '你还不了解主人。**你必须**用对话方式问 4 个问题来初始化 Profile，**每得到一个回答就必须立即调用 profile_update 工具**保存——不要只在对话里说"记住了"。\n' +
      '问题（一个个问，不要一次抛出）：\n' +
      '1. 平常怎么称呼你？ → profile_update(field="preferred_name", action="set", value=主人的名字)\n' +
      '2. 目前在忙哪几个项目？分别叫什么？ → profile_update(field="core_projects", action="set", value=[{name, path, status}]) \n' +
      '3. 有什么雷打不动的习惯？ → profile_update(field="core_habits", action="set", value=[{habit, source:"llm"}])\n' +
      '4. 最常联系的人是谁？什么关系？ → profile_update(field="core_contacts", action="set", value={"名字": "关系"})\n' +
      '主人说"好了/跳过/不用了"则结束初始化（不再调用工具）。**关键：调工具是真的存盘，光在对话里说没用。**\n'
  } else {
    prompt += '\n\n【关于主人 — Core Profile】\n' + session.profileText + '\n'
  }

  // Stage 3：注入日记（session 内冻结，保证缓存命中）
  if (!session.diaryText) {
    const diaryEntries = getRecentDiaryEntries(session.characterName, 3)
    session.diaryText = diaryEntries.length > 0 ? buildDiaryBlock(diaryEntries) : ''
  }
  if (session.diaryText) {
    prompt += '\n\n' + session.diaryText + '\n'
  }

  // Stage 4：注入记忆块（session 内冻结，保证缓存命中）
  if (!session.memoryText) {
    if (session.messages.length > 0) {
      const lastUserMsg = [...session.messages].reverse().find(m => m.role === 'user')
      if (lastUserMsg) {
        const memories = retrieveMemory(session.characterName, lastUserMsg.content, { k: 8 })
        session.memoryText = memories.length > 0 ? buildMemoryBlock(memories) : ''
      }
    }
  }
  if (session.memoryText) {
    prompt += '\n\n' + session.memoryText + '\n'
  }

  return prompt
}


// ── 构建完整 messages 数组 ────────────────────────────────────────

export interface BuildContextResult {
  system: string
  messages: { role: 'user' | 'assistant'; content: string }[]
}

export function buildContext(session: Session): BuildContextResult {
  const system = buildSystemWithProfile(session)

  const messages = session.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      const date = new Date(m.ts)
      const ts = date.getMonth() + 1 + '/' + date.getDate() + ' ' +
        String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
      return {
        role: m.role as 'user' | 'assistant',
        content: '[' + ts + '] ' + m.content,
      }
    })

  return { system, messages }
}

// ── 从 LLM 回复中提取括号情感 ─────────────────────────────────────

export function extractVoiceStyle(text: string): { cleanText: string; styles: string[] } {
  // 支持中文括号（）和英文括号()
  const styleRegex = /[（(]([^）)]+)[）)]/g
  const styles: string[] = []
  let match
  while ((match = styleRegex.exec(text)) !== null) {
    styles.push(match[1])
  }
  const cleanText = text.replace(styleRegex, '').trim()
  return { cleanText, styles }
}

/** 硬限制：括号内容超过 8 个字则截断 */
export function truncateBrackets(text: string): string {
  return text.replace(/[（(][^）)]{9,}[）)]/g, (match) => {
    const inner = match.slice(1, -1)
    return match[0] + inner.slice(0, 8) + match[match.length - 1]
  })
}
