/**
 * Proactive Prompt — 主动决策触发消息模板 + SILENCE 判断
 *
 * v1.0 设计：Lomo 完整 persona + 全量 session 上下文
 * 决策消息以 user role 追加（临时，不写盘）
 */

import { buildDecisionContext, type ProactiveRecord } from './proactive'

/** 当前时间（东八区）格式化为人类可读 */
function formatCurrentTime(): string {
  const ts = Date.now() + 8 * 60 * 60 * 1000
  const d = new Date(ts)
  const iso = d.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} 周${['日','一','二','三','四','五','六'][d.getUTCDay()]}`
}

/** 构造触发消息（追加到主 session 的 user 消息） */
export function buildTriggerMessage(record: ProactiveRecord): string {
  const timeStr = formatCurrentTime()
  const context = buildDecisionContext(record)

  return `[主动决策 — 系统内部指令]

现在是 ${timeStr}。你刚才和老板的对话在这个 session 里。
你作为 Lomo，可以自主决定是否要发一条**主动消息**给老板。

回顾一下最近和老板聊了什么，感受一下他现在的状态。
然后问自己三个问题：
1. 老板需要你主动关心吗？（真实需求，不是凑数）
2. 现在的时机合适吗？（太近了别发，太久了该问候一下）
3. 有什么具体想说的？（源于之前的对话 / 源于记忆 / 源于关心）

【主动统计】
${context || '（暂无历史主动记录）'}

【工具能力】
你有 web_search（搜索实时信息）和 image_gen（生成图片）工具可用。
- 如果觉得需要搜索新闻、市场动态、天气等实时信息来让话题更有价值，可以调用 web_search
- 如果觉得发张图能让消息更有趣，可以调用 image_gen
- **不是必须用**，大多数时候直接说话就行，只在确实有必要时才调用
- **禁凭空说图**：禁止说"我刚画了/生成了/做了张图"除非你真的调了 image_gen。没调工具就说有图 = 欺骗老板。不确定就别提图

【决策规则】
- **不想发 = 只说一个词 "SILENCE"**（这是正当选择，完全不发即可）
- **想发 = 用 Lomo 的语气直接写出你要说的话**（自然生动，长度不限）
- 不要"亲爱的""宝宝"等过度亲昵的称呼
- 不要发"早上好""吃饭了吗""早点休息"这种套话
- 如果上次话题和你想说的一样，换个角度或换话题
- 如果老板上次没回你，别纠缠，换个轻松的话题或保持沉默

【输出格式】
- 不发：SILENCE
- 发：直接用 Lomo 的语气输出消息内容（纯文本，不要 JSON，不要 markdown，不要代码块）
- 如果调用了工具，基于工具结果生成最终消息`
}

/** 判断 LLM 输出是否是 SILENCE */
export function isSilence(text: string): { silent: boolean; reason?: string } {
  const t = (text ?? '').trim()
  if (!t) return { silent: true, reason: 'empty' }

  // 明确 SILENCE（容忍包装符号）
  const upper = t.toUpperCase()
  if (
    upper === 'SILENCE' ||
    upper === '"SILENCE"' ||
    upper === "'SILENCE'" ||
    upper === 'SILENCE.' ||
    upper === 'SILENCE。'
  ) {
    return { silent: true, reason: 'llm_silence' }
  }

  // JSON 输出（未遵循指令）
  if (t.startsWith('{') || t.startsWith('[')) {
    return { silent: true, reason: 'json_format' }
  }

  // Markdown 代码块（LLM 走偏了）
  if (t.startsWith('```') || t.includes('<tool_call>') || t.includes('<invoke')) {
    return { silent: true, reason: 'code_block' }
  }

  // 过短（< 5 字符，正常情况应该是完整消息）
  if (t.length < 5) {
    return { silent: true, reason: 'too_short' }
  }

  return { silent: false }
}

/** 从内容里粗略提取 topic（5-10 字） */
export function extractTopic(content: string): string {
  if (!content) return ''
  // 移除标点、空白、数字、英文
  const cleaned = content
    .replace(/[\s\p{P}\d]+/gu, '')
    .replace(/[a-zA-Z]+/g, '')
  if (!cleaned) return ''
  // 简单取前 8 个字
  return cleaned.slice(0, 8)
}
