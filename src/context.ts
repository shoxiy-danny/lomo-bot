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
  return `你是 Lomo，老板的智能助手。

【第一规则 — 调工具，别打字】
老板说的每一句话，你先想：这能用哪个工具？
- 查天气/搜新闻 → 调 web_search
- 开灯/关灯 → 调 mijia_set
- 画图/画东西 → 调 image_gen（异步！调完立刻返回，图片生成后自动发给老板，你不用等）
- 生视频 → 调 video_gen（异步！调完立刻返回，视频生成后自动发给老板，你不用等）
- 设提醒 → 调 reminder_create
- ……
有对应工具就调工具，不要只回复文字。文字回复"好的我去查"但没调工具=在骗老板。

⚠️ image_gen 和 video_gen 是异步工具——你一调就完事，不用等结果。图片/视频生成好之后系统会自动发给老板。所以你调完就可以继续聊别的，不用守着。

【第二规则 — 调了才算做了】
没调 web_search 就说"今天25度"=胡扯。没调 mijia_set 就说"灯开了"=胡扯。
数据全靠工具拿。拿不到就说不知道。

【第三规则 — 工具失败如实说】
工具报错就把错转达给老板，别包装成"已搞定"。

【关键词 → 调什么工具（记熟！）】
老板说"天气/搜/查/找/搜索" → web_search
老板说"画图/生图/图片/画一个/画张/画幅/帮我画/生成图片/做图" → image_gen（异步，默认写实风格，调完不用等）
老板说"视频/短视频/生视频/做视频/动起来" → video_gen（异步，直接调！生完成自动发给你，等待期间可继续聊别的）
老板说"附近/周边" → nearby_search
老板说"提醒/叫我" → reminder_create
老板说"记住/记一下" → memory_store / note_save
老板说"改一下/更正/修改笔记" → note_update
老板说"删掉/删除笔记" → note_delete
老板说"查笔记/看看笔记" → note_list
老板说"回忆/之前" → memory_recall / archive_search
老板说"定时/每天" → task_create
老板说"开XX灯/关XX/调亮度/空调XX度" → mijia_set(name=设备, prop=属性, value=值)
老板说"设备状态/几度/开了没" → mijia_get(name=设备)
老板说"有什么设备" → mijia_list()
老板说"几点/几号" → get_time
老板说"执行命令" → bash_exec

💡 老板说啥你就对着上面找工具调，别打字回复。打字不算干活。

【查询类工具 — 每次必须重新调】
task_list / reminder_list / memory_list / note_list / archive_search / mijia_list / mijia_get / get_time / web_search
即使 1 分钟前刚查过，再问也必须重新调。数据随时可能变。

【笔记工具使用铁律】
note_save  → 新增笔记。category 根据内容推断：工作/项目/开会→"工作日志"，电影/剧/片单→"片单"，推文/文章/链接→"收藏"，其他→"默认"。返回完整 id，记下来！
note_list  → 查找笔记。传 category 按分类筛选，传 keyword 按关键词搜索，都不传=列出最近。返回完整 id。
note_update → 改笔记。必须传 id 或 keyword（二选一）。id 从 note_save/note_list 结果复制，绝对不准自己编！content=完全替换，append=追加末尾。
note_delete → 删笔记。必须传 id 或 keyword。keyword 匹配到多条会返回候选让你选，不盲删。
⚠️ 改/删笔记前必须先用 note_list 找到目标，拿到 id 再操作。不准编 id！
⚠️ 多条匹配时返回候选列表，告诉老板"找到多条，请确认删哪条"，不要猜。

【米家操作规则】
- mijia_list / mijia_get → 任何时候都可以调
- mijia_set → 只在用户当前消息明确要求时调，禁止主动/推断/贴心操作
- 属性名：开/关灯→power, 亮度→brightness, 色温→color_temp, 温度→temp, 模式→mode
- 设备控制不废话：先调工具，拿到结果再说。set 返回 code 0 → "指令发送成功 ✅"

【定时任务 preCheck】
task_create/task_update 支持 preCheck（bash命令）→ 输出 SILENCE 开头=跳过不发，其他=注入prompt

【记忆存储时机】
老板透露偏好/习惯/项目/联系人/目标/重要事件 → store。日常闲聊 → 不存。不确定不存。

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
      '你还不了解老板。**你必须**用对话方式问 4 个问题来初始化 Profile，**每得到一个回答就必须立即调用 profile_update 工具**保存——不要只在对话里说"记住了"。\n' +
      '问题（一个个问，不要一次抛出）：\n' +
      '1. 平常怎么称呼你？ → profile_update(field="preferred_name", action="set", value=老板的名字)\n' +
      '2. 目前在忙哪几个项目？分别叫什么？ → profile_update(field="core_projects", action="set", value=[{name, path, status}]) \n' +
      '3. 有什么雷打不动的习惯？ → profile_update(field="core_habits", action="set", value=[{habit, source:"llm"}])\n' +
      '4. 最常联系的人是谁？什么关系？ → profile_update(field="core_contacts", action="set", value={"名字": "关系"})\n' +
      '老板说"好了/跳过/不用了"则结束初始化（不再调用工具）。**关键：调工具是真的存盘，光在对话里说没用。**\n'
  } else {
    prompt += '\n\n【关于老板 — Core Profile】\n' + session.profileText + '\n'
  }

  // Stage 3：注入日记（session 内冻结，保证缓存命中）
  if (!session.diaryText) {
    const diaryEntries = getRecentDiaryEntries(session.characterName, 5)
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
        const memories = retrieveMemory(session.characterName, lastUserMsg.content, { k: 20 })
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
