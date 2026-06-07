/**
 * 三层消息路由：系统命令 → 指令 → 普通对话
 */

// ── 路由结果类型 ──────────────────────────────────────────────────

export type RouteResult =
  | { mode: 'system'; command: string }
  | { mode: 'instruction'; instruction: string; userText: string }
  | { mode: 'chat'; text: string }

// ── 指令语法 ──────────────────────────────────────────────────────

const INSTRUCTION_PATTERNS = [
  /^[（(]([^）)]+)[）)]$/s,   // （任意内容）或 (任意内容) — 纯圆括号 = 潜台词
]

// ── 系统命令解析 ──────────────────────────────────────────────────

export interface SystemCommand {
  action: 'model' | 'save' | 'load' | 'list' | 'delete' |
    'voice' | 'status' | 'resume' | 'new' | 'help' | 'name' |
    'character' | 'scene' | 'memory' | 'note' | 'unknown'
  args: string[]
}

export function parseSystemCommand(text: string): SystemCommand {
  const parts = text.trim().split(/\s+/)
  const cmd = (parts[0] || '').toLowerCase().replace(/^\//, '')
  const args = parts.slice(1)

  switch (cmd) {
    case 'model': return { action: 'model', args }
    case 'save': return { action: 'save', args }
    case 'load': return { action: 'load', args }
    case 'list': return { action: 'list', args }
    case 'delete': case 'del': return { action: 'delete', args }
    case 'voice':
    case 'tts': return { action: 'voice', args }
    case 'status': return { action: 'status', args }
    case 'resume': case '回来': case '正常对话': return { action: 'resume', args }
    case 'new': return { action: 'new', args }
    case 'name': return { action: 'name', args }
    case 'help': case '?': case '帮助': return { action: 'help', args }
    case 'character': case '角色': return { action: 'character', args }
    case 'scene': case '场景': return { action: 'scene', args }
    case 'memory': case 'mem': case '记忆': return { action: 'memory', args }
    case 'note': case 'notes': case '笔记': return { action: 'note', args }
    case 'remind': return { action: 'remind', args }
    case 'reminder': return { action: 'reminders', args }
    case 'task': case 'tasks': return { action: 'task', args }
    default: return { action: 'unknown', args }
  }
}

// ── 路由器 ────────────────────────────────────────────────────────

export function routeMessage(
  text: string,
  systemMode: boolean,
): RouteResult {
  const trimmed = text.trim()
  if (!trimmed) return { mode: 'chat', text: '' }

  // 1. 系统模式下所有消息都当系统命令
  if (systemMode) {
    if (trimmed === '回来' || trimmed === '正常对话' || trimmed === 'resume') {
      return { mode: 'system', command: 'resume' }
    }
    return { mode: 'system', command: trimmed }
  }

  // 2. 指令检测（括号包裹的内容）
  for (const pat of INSTRUCTION_PATTERNS) {
    const m = trimmed.match(pat)
    if (m) {
      return { mode: 'instruction', instruction: m[1], userText: '' }
    }
  }

  // 4. 指令 + 普通消息混合（如 "（xxx）\n普通消息"）
  const lines = trimmed.split('\n')
  const firstLine = lines[0].trim()
  for (const pat of INSTRUCTION_PATTERNS) {
    const m = firstLine.match(pat)
    if (m) {
      const userText = lines.slice(1).join('\n').trim()
      return { mode: 'instruction', instruction: m[1], userText }
    }
  }

  // 5. 普通消息
  return { mode: 'chat', text: trimmed }
}

// ── 模型别名表（与 CC 一致）────────────────────────────────────────

const MODEL_ALIASES: Record<string, string> = {
  dsf: 'deepseek-v4-flash',
  dsp: 'deepseek-v4-pro',
  mmx: 'MiniMax-M3',
  mif: 'mimo-v2.5',
  mip: 'mimo-v2.5-pro',
}

export function resolveModelAlias(alias: string): string {
  return MODEL_ALIASES[alias.toLowerCase()] || alias
}

// ── 音色预设（与 SAM 一致）────────────────────────────────────────

export const VOICE_PRESETS = [
  { id: 'mimo_default', label: '默认' },
  { id: '冰糖', label: '冰糖' },
  { id: '茉莉', label: '茉莉' },
  { id: '苏打', label: '苏打' },
  { id: '白桦', label: '白桦' },
  { id: 'Mia', label: 'Mia' },
  { id: 'Chloe', label: 'Chloe' },
  { id: 'Milo', label: 'Milo' },
  { id: 'Dean', label: 'Dean' },
]

// ── TTS 风格映射 ──────────────────────────────────────────────────

const STYLE_MAP: Record<string, string> = {
  温柔: 'gentle', 温和: 'gentle', 轻柔: 'gentle', 柔和: 'gentle',
  开心: 'happy', 高兴: 'happy', 愉快: 'happy', 兴奋: 'happy',
  悲伤: 'sad', 难过: 'sad', 忧伤: 'sad', 哀伤: 'sad',
  生气: 'angry', 愤怒: 'angry', 暴怒: 'angry',
  严肃: 'serious', 沉重: 'serious', 冷冷: 'serious', 冰冷: 'serious',
  活泼: 'playful', 调皮: 'playful', 恶作剧: 'playful',
  惊讶: 'surprised', 震惊: 'surprised', 吃惊: 'surprised',
  激动: 'passionate', 热情: 'passionate',
  紧张: 'nervous', 焦虑: 'nervous', 焦急: 'nervous',
  沉思: 'pensive', 深沉: 'pensive',
  冷漠: 'indifferent', 淡漠: 'indifferent', 冷淡: 'indifferent',
  微笑: 'gentle', 笑: 'happy', 哭: 'sad', 怒: 'angry',
}

export function resolveVoiceStyle(hint: string): string {
  // hint 是括号里的内容，如 "温柔地" "微微一笑" "严肃地说"
  const normalized = hint.replace(/[地的着了说喊叫]/g, '').trim()
  // 尝试完全匹配
  if (STYLE_MAP[normalized]) return STYLE_MAP[normalized]
  // 尝试部分匹配
  for (const [key, val] of Object.entries(STYLE_MAP)) {
    if (normalized.includes(key)) return val
  }
  return ''
}
