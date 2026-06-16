/**
 * 工具定义 + 执行层 — web_search + image_gen
 *
 * 支持两种触发方式：
 *   1. 原生 tool calling（LLM API 层面注册工具）
 *   2. 正则标记回退： 【搜索：关键词】/【生图：描述】
 */

import type { ToolDef, ToolCall } from './llm/types'
import { MEMORY_TOOLS, executeMemoryTool, type MemoryToolResult } from './memory/tools'
import { addReminder, deleteReminder, listReminders, updateReminder } from './reminders'
import { addNote, updateNote, deleteNote, listNotes, findNote, type MatchResult } from './notes'
import { getCurrentLocation, type LocationData } from './location'
import { searchArchive } from './memory/archive'
import { execSync } from 'child_process'
import { join } from 'path'
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, statSync, unlinkSync } from 'fs'

// ── 工具定义（给 LLM API 注册用） ──────────────────────────────────

export const SEARCH_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'web_search',
    description: '搜索互联网获取实时信息，如天气、新闻、百科等',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词',
        },
      },
      required: ['query'],
    },
  },
}

export const IMAGE_GEN_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'image_gen',
    description: '根据文字描述生成图片（异步）。调用后立即返回，图片生成完成后系统会自动发送到聊天中。描述越详细效果越好——包含主体、环境、光线、色调。**默认出写实风格**，除非用户明确要求动漫/卡通/水墨等其他风格。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '图片描述：用中文详细描述画面，包含主体、环境、光线、色彩、风格等',
        },
        reference_image: {
          type: 'string',
          description: '参考图片（可选）：公网URL或base64格式。传入后做图生图/风格参考',
        },
      },
      required: ['prompt'],
    },
  },
}

export const VIDEO_GEN_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'video_gen',
    description: '根据文字描述生成短视频（3~15秒，24FPS）。支持写实/电影风格和运镜指令（推进/拉远/左移/右移/上升/下降等）。生成约需1~3分钟，完成后会自动发送。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '视频描述：详细描述画面内容和镜头运动，包含主体、场景、光线、色调、风格（写实/电影/动漫等）。支持运镜指令如[推进][拉远][左移]等',
        },
        duration: {
          type: 'number',
          description: '视频时长（秒），默认 6，最长 15（24FPS）',
        },
      },
      required: ['prompt'],
    },
  },
}

export const GET_TIME_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'get_time',
    description: '获取当前东八区时间。当你需要知道现在几点、今天周几、日期时调用。',
    parameters: { type: 'object', properties: {} },
  },
}

// ── 提醒/任务工具定义 ────────────────────────────────────────────

export const REMINDER_CREATE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'reminder_create',
    description: '创建**一次性**提醒（到点响一次就完）。当用户说"提醒我"、"X点叫我"、"别忘了"时使用。fire_at 是具体时间点（ISO 8601）。如果要设**每天/每周重复执行**的，请用 task_create。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '提醒内容' },
        fire_at: { type: 'string', description: 'ISO 8601 时间字符串，含时区（如 2026-06-03T09:00:00+08:00）' },
        label: { type: 'string', description: '简短标签，方便列表展示' },
      },
      required: ['text', 'fire_at'],
    },
  },
}

export const REMINDER_LIST_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'reminder_list',
    description: '列出当前用户的所有提醒和定时任务。',
    parameters: { type: 'object', properties: {} },
  },
}

export const REMINDER_DELETE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'reminder_delete',
    description: '按 id 删除一个提醒或定时任务。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '提醒/任务的 id' },
      },
      required: ['id'],
    },
  },
}

export const TASK_CREATE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'task_create',
    description: '创建**重复执行**的定时任务（按 cron 表达式周期运行）。当用户说"每天X点"、"每周一"、"定时"时使用。如果要设**一次性**闹钟提醒，请用 reminder_create。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '任务执行指令，如"搜索今日AI行业新闻，按标题+摘要+来源格式整理"' },
        cron: { type: 'string', description: 'cron 表达式，如"0 9 * * 1-5"表示工作日9点，"30 8 * * *"表示每天8:30' },
        label: { type: 'string', description: '任务名称，如"AI日报"' },
        session: { type: 'boolean', description: '任务回复是否追加到对话 session（true=用户下次对话能看到任务结果并继续聊）' },
      },
      required: ['prompt', 'cron', 'label'],
    },
  },
}

export const TASK_LIST_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'task_list',
    description: '列出当前用户的所有定时任务。',
    parameters: { type: 'object', properties: {} },
  },
}

export const TASK_DELETE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'task_delete',
    description: '按 id 删除一个定时任务。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务的 id' },
      },
      required: ['id'],
    },
  },
}

export const REMINDER_UPDATE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'reminder_update',
    description: '更新一个提醒的内容、标签或时间。只传要改的字段即可。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '提醒的 id' },
        text: { type: 'string', description: '新的提醒内容' },
        label: { type: 'string', description: '新的标签' },
        fire_at: { type: 'string', description: '新的触发时间（ISO 8601）' },
        enabled: { type: 'boolean', description: '启用/禁用' },
      },
      required: ['id'],
    },
  },
}

export const TASK_UPDATE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'task_update',
    description: '更新定时任务的执行指令、cron 表达式、标签或启用状态。只传要改的字段即可。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务的 id' },
        prompt: { type: 'string', description: '新的执行指令' },
        cron: { type: 'string', description: '新的 cron 表达式' },
        label: { type: 'string', description: '新的任务名称' },
        enabled: { type: 'boolean', description: '启用/禁用' },
        session: { type: 'boolean', description: '任务回复是否追加到对话 session' },
      },
      required: ['id'],
    },
  },
}

// ── 随手记工具定义（v2）───────────────────────────────────────────

export const NOTE_SAVE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'note_save',
    description: '保存一条新笔记。当用户说"记一下"、"帮我记"、"备忘"、"加入片单"、"收藏"时使用。category 根据内容推断：工作/项目/开会→"工作日志"，电影/剧/片单→"片单"，推文/文章/链接→"收藏"，其他→"默认"。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要记录的内容原文' },
        category: { type: 'string', description: '分类，如"工作日志"、"片单"、"收藏"。不传默认"默认"' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签' },
      },
      required: ['content'],
    },
  },
}

export const NOTE_LIST_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'note_list',
    description: '列出或搜索笔记。不传参数=列出最近30条；传 category=按分类筛选；传 keyword=关键词搜索。返回完整 id，可用于 note_update 或 note_delete。',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: '按分类筛选，如"工作日志"、"片单"' },
        keyword: { type: 'string', description: '关键词搜索（匹配内容和标签）' },
        limit: { type: 'number', description: '返回条数，默认30' },
      },
    },
  },
}

export const NOTE_UPDATE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'note_update',
    description: '更新已有笔记。必须提供 id 或 keyword（二选一）。id 从 note_save 返回值或 note_list 结果中复制，绝对不准自己编。content=完全替换内容；append=追加到末尾（二选一，同时传 content 生效）。可同时更新 category 和 tags。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '笔记 id（从 note_save 或 note_list 结果中复制）' },
        keyword: { type: 'string', description: '关键词匹配要更新的笔记（id 和 keyword 二选一，优先用 id）' },
        content: { type: 'string', description: '新内容（完全替换）' },
        append: { type: 'string', description: '追加到现有内容末尾' },
        category: { type: 'string', description: '新分类' },
        tags: { type: 'array', items: { type: 'string' }, description: '新标签' },
      },
    },
  },
}

export const NOTE_DELETE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'note_delete',
    description: '删除一条笔记。必须提供 id 或 keyword（二选一）。id 从 note_save 或 note_list 结果中复制，绝对不准自己编。keyword 匹配到多条时返回候选，不盲删。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '笔记 id（从 note_save 或 note_list 结果中复制）' },
        keyword: { type: 'string', description: '关键词匹配要删除的笔记（id 和 keyword 二选一，优先用 id）' },
      },
    },
  },
}

// ── Bash 工具 ─────────────────────────────────────────────────────

const SAFE_CMDS = new Set([
  'ls', 'cat', 'grep', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'df',
  'find', 'tree', 'which', 'echo', 'printf', 'date', 'uname', 'whoami',
  'pwd', 'ps', 'free', 'uptime',
])

const FORBIDDEN_CMDS = new Set([
  'sudo', 'su', 'reboot', 'shutdown', 'kill', 'systemctl', 'service',
  'curl', 'wget', 'dd', 'mkfs', 'mount', 'umount', 'ssh', 'scp', 'nc',
  'telnet', 'chown', 'chgrp', 'passwd', 'iptables', 'ufw',
])

const READONLY_GIT_SUB = new Set(['log', 'show', 'diff', 'status', 'branch', 'tag', 'blame', 'stash'])

const LOMO_WORKSPACE = join(process.env.HOME || '/tmp', 'Projects', 'Lomo')

export const BASH_EXEC_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'bash_exec',
    description: '执行 bash 命令。分三级：(1) 只读安全命令（ls/cat/grep/find/ps/df 等）直接执行；(2) 工作区受限命令（git/npm/bun 等）自动限定在 ~/Projects/Lomo/ 目录；(3) 危险命令（sudo/curl/kill 等）拒绝执行。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 bash 命令' },
      },
      required: ['command'],
    },
  },
}

export const ARCHIVE_SEARCH_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'archive_search',
    description: '搜索主人的原始对话记录（最近 90 天）。当主人问"我之前是不是说过"、"上次聊过什么"、"帮我查之前提到的"时使用。如果找的是已提取的记忆（偏好/习惯/项目），用 memory_recall。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，如"股票提醒"、"钢琴"、"高德 key"' },
      },
      required: ['query'],
    },
  },
}

// ── 米家智能家居 ──────────────────────────────────────────────────

const MIJIA_SCRIPT = join(LOMO_WORKSPACE, 'scripts', 'mijia.py')
const MIJIA_PYTHON = join(LOMO_WORKSPACE, 'scripts', 'venv', 'bin', 'python3')

export const MIJIA_LIST_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'mijia_list',
    description: '列出老板家所有米家智能家居设备（灯/空调/音箱/插座/传感器等）。返回 JSON 包含 did、name、model、online、room。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
}

export const MIJIA_GET_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'mijia_get',
    description: '查某台米家设备的当前状态（开关、亮度、温度、模式等）。name 用设备的中文名（如"小米AI音箱"、"大灯"）。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '设备名（中文名或部分匹配）' },
      },
      required: ['name'],
    },
  },
}

export const MIJIA_SET_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'mijia_set',
    description: '控制米家设备开关/调亮度/调色温。name=设备名，prop=属性（power/brightness/color_temp），value=目标值（开=on/关=off/数字）。举例：关灯→mijia_set("大灯","power","off")；开灯→mijia_set("大灯","power","on")；调亮→mijia_set("大灯","brightness","80")。调用前置：用户明确说要做设备动作。禁止在用户没要求时调用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '设备名（中文名或部分匹配）' },
        prop: { type: 'string', description: '属性名（power/brightness/color_temp/temp/mode/fan_level/...）' },
        value: { type: 'string', description: '目标值（on/off/数字）' },
        intent: { type: 'string', description: '用户原话的动作描述（如"开灯"、"调亮 30%"），用于反馈' },
      },
      required: ['name', 'prop', 'value'],
    },
  },
}

function runMijia(args: string[]): { result: string } {
  const ts = new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' }).replace(' ', 'T')
  const cmd = args.join(' ')
  try {
    const stdout = execSync(`${MIJIA_PYTHON} ${MIJIA_SCRIPT} ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`, {
      timeout: 60000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
      cwd: LOMO_WORKSPACE,
    })
    const trimmed = stdout.slice(0, 6000)
    // 持久化米家调用日志
    try {
      const logLine = JSON.stringify({ ts, cmd, ok: true, output: trimmed.slice(0, 500) }) + '\n'
      appendFileSync(join(LOMO_WORKSPACE, 'state', 'mijia-logs.jsonl'), logLine)
    } catch {}
    return { result: trimmed || '(无输出)' }
  } catch (err: any) {
    const stderr = err.stderr?.slice(0, 500) || ''
    const msg = err.message?.slice(0, 200) || ''
    try {
      const logLine = JSON.stringify({ ts, cmd, ok: false, error: stderr || msg }) + '\n'
      appendFileSync(join(LOMO_WORKSPACE, 'state', 'mijia-logs.jsonl'), logLine)
    } catch {}
    return { result: `mijia 执行失败: ${stderr || msg}` }
  }
}

export const NEARBY_SEARCH_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'nearby_search',
    description: '搜索用户周边的兴趣点（餐厅/咖啡/加油站/医院等）。需要用户先分享过位置。返回名称、地址、距离、评分等信息。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词，如"日料"、"星巴克"、"加油站"' },
        radius: { type: 'number', description: '搜索半径（米），默认 1000，最大 50000' },
        type: { type: 'string', description: 'POI 类型编码（可选），如"050000"为餐饮，"060000"为购物' },
      },
      required: ['keyword'],
    },
  },
}

function classifyCommand(command: string): 'forbidden' | 'safe' | 'dangerous' {
  const firstWord = command.trim().split(/\s+/)[0] || ''
  const cmd = firstWord.split('/').pop() || '' // 去路径前缀

  if (FORBIDDEN_CMDS.has(cmd)) return 'forbidden'

  // git 子命令细分
  if (cmd === 'git') {
    const sub = command.trim().split(/\s+/)[1]
    if (sub && READONLY_GIT_SUB.has(sub)) return 'safe'
    return 'dangerous'
  }

  if (SAFE_CMDS.has(cmd)) return 'safe'

  // 管道/重定向 → 拆开检查第一个命令即可
  // 未知命令 → 按危险处理
  return 'dangerous'
}

function rejectPathTraversal(command: string): string | null {
  // 检查是否包含路径穿越
  if (command.includes('..')) return '禁止路径穿越 (..)'
  // 检查绝对路径引用（排除合法的 /usr/bin /dev/null 等）
  const absPaths = command.match(/(?<!\w)\/[^\s|&;]+/g) || []
  const allowed = ['/dev/null', '/dev/stdout', '/dev/stderr', '/tmp/']
  for (const p of absPaths) {
    if (p.startsWith('/home/') || p.startsWith(LOMO_WORKSPACE)) continue
    if (allowed.some(a => p.startsWith(a))) continue
    return `禁止访问工作区外路径: ${p}`
  }
  return null
}

export function execBash(command: string): { result: string } {
  // 0. 清洗 M3 训练数据泄漏的 ]minimax[ 标记（即使 Anthropic 端点也会偶发）
  let sanitized = command
    .replace(/\]\s*<\s*\]minimax\[\s*>\s*\[/g, '')  // 包裹模式: ]<]minimax[>[
    .replace(/\]minimax\[/g, '')                        // 独立片段: ]minimax[
  sanitized = sanitized.trim()
  if (!sanitized) return { result: '执行失败: 命令为空（可能是工具参数清洗后为空）' }

  // 1. 分类
  const cls = classifyCommand(sanitized)
  if (cls === 'forbidden') return { result: `命令被拒绝执行: ${sanitized.split(/\s+/)[0]}` }

  // 2. 危险命令：锁定工作区
  let finalCmd = sanitized
  if (cls === 'dangerous') {
    const rejection = rejectPathTraversal(command)
    if (rejection) return { result: rejection }
    // cd 进工作区再执行
    finalCmd = `cd "${LOMO_WORKSPACE}" && ${command}`
  }

  // 3. 执行
  console.log(`[bash_exec] cmd="${sanitized}" cls=${cls} final="${finalCmd}"`)
  try {
    const stdout = execSync(finalCmd, {
      timeout: cls === 'safe' ? 10000 : 30000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
      cwd: LOMO_WORKSPACE,
      env: { ...process.env, HOME: process.env.HOME || '/tmp' },
    })
    const trimmed = stdout.slice(0, 4000)
    console.log(`[bash_exec] OK len=${stdout.length} trimmed=${trimmed.length}`)
    return { result: trimmed || '(无输出)' }
  } catch (err: any) {
    const stderr = err.stderr?.slice(0, 500) || ''
    const msg = err.message?.slice(0, 200) || ''
    return { result: `执行失败: ${stderr || msg}` }
  }
}

export const TOOLS: ToolDef[] = [
  SEARCH_TOOL, IMAGE_GEN_TOOL, VIDEO_GEN_TOOL, GET_TIME_TOOL,
  ...MEMORY_TOOLS,
  REMINDER_CREATE_TOOL, REMINDER_LIST_TOOL, REMINDER_DELETE_TOOL, REMINDER_UPDATE_TOOL,
  TASK_CREATE_TOOL, TASK_LIST_TOOL, TASK_DELETE_TOOL, TASK_UPDATE_TOOL,
  NOTE_SAVE_TOOL, NOTE_LIST_TOOL, NOTE_UPDATE_TOOL, NOTE_DELETE_TOOL,
  BASH_EXEC_TOOL,
  MIJIA_LIST_TOOL, MIJIA_GET_TOOL, MIJIA_SET_TOOL,
  NEARBY_SEARCH_TOOL,
  ARCHIVE_SEARCH_TOOL,
]

// ── 旧格式正则解析（回退方案） ─────────────────────────────────────

interface LegacyToolCall {
  type: 'search' | 'image'
  query: string
}

export function parseToolCalls(text: string): LegacyToolCall[] {
  const calls: LegacyToolCall[] = []
  const searchRegex = /【搜索[：:]\s*(.+?)】/g
  const imageRegex = /【生图[：:]\s*(.+?)】/g

  let match
  while ((match = searchRegex.exec(text)) !== null) {
    calls.push({ type: 'search', query: match[1] })
  }
  while ((match = imageRegex.exec(text)) !== null) {
    calls.push({ type: 'image', query: match[1] })
  }
  return calls
}

// ── Qwen 风格 <tool_call> 解析（兼容 M3 文本式工具调用）─────────

/**
 * 从文本中解析 Qwen 风格 <tool_call> 块
 * 支持三种参数格式：
 *   1. JSON：{"key": "value"}
 *   2. <parameter name="key">value</parameter>
 *   3. <invoke name="key">value</key> 或 <key>value</key>
 * 返回的 ToolCall 可与原生 tool_calls 合并使用
 */
export function parseToolCallXml(text: string): ToolCall[] {
  // 0. 清洗 M3 训练数据泄漏的 ]minimax[ 标记
  //    Anthropic 端点第 3+ 轮工具循环时，M3 退化成 XML 文本模式，
  //    每个 XML 标签前后被 ]<]minimax[>[ 包裹，不洗掉会导致命令参数污染
  const clean = text
    .replace(/\]\s*<\s*\]minimax\[\s*>\s*\[/g, '')  // 包裹模式: ]<]minimax[>[
    .replace(/\]minimax\[/g, '')                        // 独立片段: ]minimax[
  const calls: ToolCall[] = []
  // 1. 提取 <tool_call>...</tool_call> 块
  //    注意：JS 解析器对 /.../ 字面量里的 / 敏感，用 new RegExp 避免歧义
  const blockRegex = new RegExp('<tool_call>([\\s\\S]*?)</tool_call>', 'g')
  let blockMatch: RegExpExecArray | null
  let idx = 0
  while ((blockMatch = blockRegex.exec(clean)) !== null) {
    const block = blockMatch[1]
    // 2. 在块内找最外层 <invoke name="X">...</invoke>
    //    注意：必须从第一个 <invoke 匹配到最后一个 </invoke>（非贪婪会被内层截胡）
    const funcMatch = block.match(/<invoke\s+name=["']([^"']+)["']\s*>/)
    if (!funcMatch) continue
    const funcName = funcMatch[1]
    const firstEnd = funcMatch.index! + funcMatch[0].length
    const lastClose = block.lastIndexOf('</invoke>')
    const argsBlock = lastClose > firstEnd ? block.slice(firstEnd, lastClose) : block.slice(firstEnd)
    const args = parseArgsBlock(argsBlock)
    calls.push({
      id: `xml_${Date.now()}_${idx++}`,
      type: 'function' as const,
      function: {
        name: funcName,
        arguments: JSON.stringify(args),
      },
    })
  }
  return calls
}

/**
 * 从参数块解析键值对
 * 策略顺序：JSON → <parameter> → <invoke name=> → 简单 <x>value</x> → 纯文本
 */
function parseArgsBlock(block: string): Record<string, any> {
  const trimmed = block.trim()
  // 1. 纯 JSON：直接返回
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try { return JSON.parse(trimmed) } catch {}
  }

  const args: Record<string, any> = {}
  let m: RegExpExecArray | null

  // 2. <parameter name="X">value</parameter>
  const paramRegex = new RegExp('<parameter\\s+name=["\']([^"\']+)["\']\\s*>([\\s\\S]*?)</parameter\\s*>', 'g')
  while ((m = paramRegex.exec(block)) !== null) {
    args[m[1]] = m[2].trim()
  }

  // 3. <invoke name="X">value</X>（Qwen 风格，X 为参数名）
  //    仅当 tag 名不在 args 里时添加（避免和 parameter 冲突）
  const invokeArgRegex = new RegExp('<invoke\\s+name=["\']([^"\']+)["\']\\s*>([\\s\\S]*?)(?=<invoke\\s+name=|</invoke\\s*>|$)', 'g')
  while ((m = invokeArgRegex.exec(block)) !== null) {
    const argName = m[1]
    if (argName in args) continue
    let value = m[2].trim().replace(/<\/?\w+>/g, '').trim()
    args[argName] = value
  }

  // 4. 简单 <X>value</X> 标签（仅当 X 不在 args 里）
  const tagRegex = new RegExp("<([a-zA-Z_]\\w*)\\s*>([\\s\\S]*?)</\\1\\s*>", "g")
  while ((m = tagRegex.exec(block)) !== null) {
    const tagName = m[1]
    if (tagName === 'invoke') continue
    if (tagName in args) continue
    args[tagName] = m[2].trim()
  }

  // 5. 没匹配上任何结构：纯文本
  if (Object.keys(args).length === 0) {
    return { text: trimmed }
  }
  return args
}

/** 从文本中移除所有 <tool_call>...</tool_call> 块（用于清洗用户看到的回复） */
export function stripToolCallXml(text: string): string {
  return text.replace(new RegExp('<tool_call>[\\s\\S]*?</tool_call>', 'g'), '').trim()
}

// ── Web Search（MiniMax API） ──────────────────────────────────────

function getMiniMaxKey(): string {
  return process.env.MINIMAX_API_KEY || ''
}

export async function webSearch(query: string): Promise<string> {
  if (!getMiniMaxKey()) return '（搜索不可用：未配置 MINIMAX_API_KEY）'

  try {
    const resp = await fetch('https://api.minimax.chat/v1/coding_plan/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getMiniMaxKey()}`,
      },
      body: JSON.stringify({ q: query }),
    })

    if (!resp.ok) return `（搜索失败: ${resp.status}）`
    const data = await resp.json() as any

    // 检查业务状态码
    const baseResp = data?.base_resp || {}
    const code = baseResp.status_code ?? 0
    if (code === 1004) return '（搜索不可用: API 认证失败）'
    if (code === 2038) return '（搜索不可用: API 需实名认证）'
    if (code !== 0) return `（搜索失败: ${code} - ${baseResp.status_msg || ''}）`

    // 解析搜索结果，格式化为文本摘要
    const results = data?.results || data?.organic || []
    if (!Array.isArray(results) || results.length === 0) return '（搜索无结果）'

    return results.map((r: any, i: number) => {
      const title = r.title || ''
      const snippet = (r.snippet || r.content || '').replace(/<[^>]+>/g, '')
      const link = r.link || ''
      return `${i + 1}. ${title}\n   ${snippet}${link ? `\n   来源: ${link}` : ''}`
    }).join('\n\n')
  } catch (err: any) {
    return `（搜索出错: ${err.message}）`
  }
}

// ── Image Generation（Agnes 主 → MiniMax fallback）──────────────────

function getAgnesKey(): string {
  return process.env.AGNES_API_KEY || ''
}

function getAgnesFallbackKey(): string {
  return process.env.AGNES_API_KEY_FALLBACK || ''
}

function resolveImageSource(source: string): string {
  if (source.startsWith('data:')) return source
  if (source.startsWith('http://') || source.startsWith('https://')) return source
  // 本地文件 → base64
  const buf = readFileSync(source)
  const ext = source.split('.').pop()?.toLowerCase() || 'png'
  const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
  return `data:${mime[ext] || 'image/png'};base64,${buf.toString('base64')}`
}

async function agnesImageGen(prompt: string, referenceImage?: string): Promise<string | null> {
  const keys = [getAgnesKey(), getAgnesFallbackKey()].filter(Boolean)
  if (keys.length === 0) return null
  for (const key of keys) {
    try {
      const extraBody: Record<string, unknown> = { response_format: 'url' }
      if (referenceImage) extraBody.image = [resolveImageSource(referenceImage)]
      const resp = await fetch('https://apihub.agnes-ai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: 'agnes-image-2.1-flash',
          prompt,
          size: '1024x1024',
          extra_body: extraBody,
        }),
      })
      if (resp.ok) {
        const data = await resp.json() as any
        const url = data.data?.[0]?.url
        if (url) return url
      }
    } catch {}
  }
  return null
}

export async function imageGen(prompt: string, referenceImage?: string): Promise<{ text: string; imageUrl: string }> {
  // 主路径：Agnes（付费 → 免费降级）
  const agnesUrl = await agnesImageGen(prompt, referenceImage)
  if (agnesUrl) return { text: '图片已生成 (Agnes)', imageUrl: agnesUrl }

  // fallback: MiniMax
  if (!getMiniMaxKey()) return { text: '（生图不可用）', imageUrl: '' }

  try {
    const resp = await fetch('https://api.minimax.chat/v1/image_generation', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getMiniMaxKey()}`,
      },
      body: JSON.stringify({
        model: 'image-01',
        prompt: prompt,
        n: 1,
      }),
    })
    if (!resp.ok) return { text: `（生图失败: ${resp.status}）`, imageUrl: '' }
    const data = await resp.json() as any
    const urls = data?.data?.image_urls || []
    const imageUrl = Array.isArray(urls) && urls.length > 0 ? urls[0] : ''
    return { text: imageUrl ? '图片已生成 (MiniMax)' : '（生图无结果）', imageUrl }
  } catch (err: any) {
    return { text: `（生图出错: ${err.message}）`, imageUrl: '' }
  }
}

// ── Video Generation（Agnes 视频 API）────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Agnes 视频生成（付费 → 免费降级） */
export async function videoGen(prompt: string, duration: number = 6): Promise<{ text: string; videoFile?: string; downloadUrl?: string }> {
  const keys = [getAgnesKey(), getAgnesFallbackKey()].filter(Boolean)
  if (keys.length === 0) return { text: '（视频生成不可用：未配置 AGNES_API_KEY）' }
  for (const key of keys) {
    const result = await videoGenWithKey(key, prompt, duration)
    if (!result.text.startsWith('（') || keys.length === 1) return result
  }
  return { text: '（视频生成失败：所有 key 均不可用）' }
}

async function videoGenWithKey(key: string, prompt: string, duration: number): Promise<{ text: string; videoFile?: string; downloadUrl?: string }> {

  // 1. 创建任务
  const numFrames = Math.min(Math.round(duration * 24 / 8) * 8 + 1, 360)  // 24FPS ≤15s
  const actualDuration = (numFrames / 24).toFixed(1)
  const body = {
    model: 'agnes-video-v2.0',
    prompt,
    width: 1152,
    height: 768,
    num_frames: numFrames,
    frame_rate: 24,
  }

  try {
    const createResp = await fetch('https://apihub.agnes-ai.com/v1/videos', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!createResp.ok) {
      const errText = await createResp.text().catch(() => '')
      return { text: `（视频创建失败: ${createResp.status} ${errText.slice(0, 100)}）` }
    }
    const createData = await createResp.json() as any
    const videoId = createData.video_id || createData.id
    if (!videoId) return { text: '（视频创建未返回 video_id）' }

    // 2. 轮询
    const startedAt = Date.now()
    const deadline = startedAt + 10 * 60_000
    let downloadUrl: string | undefined

    while (Date.now() < deadline) {
      await sleep(15_000)
      const qResp = await fetch(`https://apihub.agnes-ai.com/agnesapi?video_id=${encodeURIComponent(videoId)}`, {
        headers: { Authorization: `Bearer ${key}` },
      })
      if (!qResp.ok) continue
      const qData = await qResp.json() as any
      if (qData.status === 'completed') {
        downloadUrl = qData.download_url || qData.result?.video?.download_url || qData.video?.url || qData.remixed_from_video_id
        break
      }
      if (qData.status === 'failed') return { text: '（视频生成失败）' }
    }

    if (!downloadUrl) return { text: '（视频生成超时）' }

    // 3. 下载（30s 超时，VIDEO_PROXY 环境变量支持走代理）
    let buf: Buffer | null = null
    try {
      const abort = AbortSignal.timeout(30_000)
      const dlResp = await fetch(downloadUrl, { signal: abort })
      if (dlResp.ok) {
        buf = Buffer.from(await dlResp.arrayBuffer())
      }
    } catch {}
    if (!buf) {
      // 直连失败 + 有代理 → curl 重试
      const proxyUrl = process.env.VIDEO_PROXY
      if (proxyUrl) {
        const proxyOutDir = join(process.env.HOME || '/tmp', 'Projects', 'Lomo', 'state', 'inbox')
        mkdirSync(proxyOutDir, { recursive: true })
        const tmpPath = join(proxyOutDir, `video_${Date.now()}.mp4`)
        try {
          const { execSync } = await import('child_process')
          execSync(`curl -x "${proxyUrl}" -sS -o "${tmpPath}" --connect-timeout 10 --max-time 60 "${downloadUrl}"`, { timeout: 70_000 })
          const stat = statSync(tmpPath)
          if (stat.size > 0) {
            buf = readFileSync(tmpPath)
          }
        } catch {}
        if (!buf) try { unlinkSync(tmpPath) } catch {}
      }
    }
    if (!buf) return { text: '（视频下载失败：直连超时且代理不可用）', downloadUrl }

    const outDir = join(process.env.HOME || '/tmp', 'Projects', 'Lomo', 'state', 'inbox')
    mkdirSync(outDir, { recursive: true })
    const filePath = join(outDir, `video_${Date.now()}.mp4`)
    writeFileSync(filePath, buf)

    return { text: `视频已生成 (${actualDuration}s, ${(buf.length / 1024 / 1024).toFixed(1)}MB)`, videoFile: filePath }
  } catch (err: any) {
    return { text: `（视频生成出错: ${err.message.slice(0, 100)}）` }
  }
}

// ── 周边搜索（高德 API）───────────────────────────────────────────

function getAmapKey(): string {
  return process.env.AMAP_API_KEY || ''
}

async function nearbySearch(
  loc: LocationData,
  keyword: string,
  radius: number,
  typeCode?: string,
): Promise<string> {
  const key = getAmapKey()
  if (!key) return '（周边搜索不可用：未配置 AMAP_API_KEY，请在 state/.env 中添加）'
  if (!keyword) return '请提供搜索关键词，如"日料"、"咖啡"、"加油站"。'

  try {
    const params = new URLSearchParams({
      key,
      location: `${loc.longitude},${loc.latitude}`,
      keywords: keyword,
      radius: String(Math.min(radius, 50000)),
      offset: '10',
      extensions: 'all',
    })
    if (typeCode) params.set('types', typeCode)

    const resp = await fetch(`https://restapi.amap.com/v3/place/around?${params}`)
    if (!resp.ok) return `（高德 API 请求失败: ${resp.status}）`

    const data = await resp.json() as any
    if (data.status !== '1') return `（高德 API 错误: ${data.info || '未知'}）`

    const pois = data.pois || []
    if (pois.length === 0) return `在 ${loc.name || '你的位置'} 附近 ${radius}m 内没有找到"${keyword}"。`

    return pois.slice(0, 8).map((p: any, i: number) => {
      const name = p.name || '未知'
      const addr = p.address || p.cityname || ''
      const dist = p.distance ? `${p.distance}m` : ''
      const rating = p.biz_ext?.rating || p.deep_info?.rating || ''
      const cost = p.biz_ext?.cost || ''
      const tel = p.tel || ''
      const parts = [`${i + 1}. ${name}`]
      if (dist) parts.push(`距离: ${dist}`)
      if (rating) parts.push(`评分: ${rating}`)
      if (cost) parts.push(`人均: ${cost}`)
      if (addr) parts.push(`地址: ${addr}`)
      if (tel) parts.push(`电话: ${tel}`)
      return parts.join(' | ')
    }).join('\n')
  } catch (err: any) {
    return `（周边搜索出错: ${err.message}）`
  }
}

// ── 原生 ToolCall 执行 ────────────────────────────────────────────

export interface ToolResult {
  type: 'search' | 'image' | 'video' | 'memory' | 'reminder' | 'note'
  query: string
  result: string
  imageUrl?: string
  videoFile?: string   // 视频生成后本地文件路径
  toolCallId?: string
}

/** 执行原生 tool_calls */
export async function executeNativeToolCalls(
  toolCalls: ToolCall[],
  contextRole?: string,
  chatId?: string,
  session?: any,  // Session（用于 mijia_set 的 confirm 机制）
): Promise<ToolResult[]> {
  const results: ToolResult[] = []
  for (const tc of toolCalls) {
    try {
      const args = JSON.parse(tc.function.arguments)
      if (tc.function.name === 'web_search') {
        const result = await webSearch(args.query || '')
        results.push({ type: 'search', query: args.query || '', result, toolCallId: tc.id })
      } else if (tc.function.name === 'image_gen') {
        // 异步：生成由 server.ts 的 runToolLoop 统一 fire-and-forget
        results.push({ type: 'image', query: args.prompt || '', result: '图片正在生成，完成后会自动发送。', toolCallId: tc.id })
      } else if (tc.function.name === 'video_gen') {
        // 异步：生成由 server.ts 的 runToolLoop 统一 fire-and-forget
        results.push({ type: 'video', query: args.prompt || '', result: '视频正在生成（约1~3分钟），完成后会自动发送。', toolCallId: tc.id })
      } else if (tc.function.name === 'get_time') {
        const ts = Date.now() + 8 * 60 * 60 * 1000
        const d = new Date(ts)
        const dayStr = ['日', '一', '二', '三', '四', '五', '六'][d.getUTCDay()]
        const iso = d.toISOString()
        const timeStr = `${iso.slice(0, 10)} ${iso.slice(11, 16)} 周${dayStr}`
        results.push({ type: 'search', query: 'get_time', result: `当前东八区时间：${timeStr}`, toolCallId: tc.id })
      } else if (
        contextRole && (
          tc.function.name === 'memory_store' ||
          tc.function.name === 'memory_recall' ||
          tc.function.name === 'memory_list' ||
          tc.function.name === 'memory_update' ||
          tc.function.name === 'memory_delete' ||
          tc.function.name === 'profile_update'
        )
      ) {
        const memResult = executeMemoryTool(contextRole, tc)
        results.push({
          type: 'memory',
          query: tc.function.name,
          result: memResult.message + (memResult.data ? `\n${JSON.stringify(memResult.data)}` : ''),
          toolCallId: tc.id,
        })
      } else if (tc.function.name === 'reminder_create' || tc.function.name === 'task_create') {
        if (tc.function.name === 'reminder_create') {
          const fireAt = new Date(args.fire_at).getTime()
          if (isNaN(fireAt)) {
            results.push({ type: 'reminder', query: 'reminder_create', result: 'fire_at 格式无效，请使用 ISO 8601 格式（如 2026-06-03T09:00:00+08:00）', toolCallId: tc.id })
            continue
          }
          const entry = addReminder({
            chatId: chatId || '',
            role: contextRole || 'lomo',
            delivery: 'fixed',
            type: 'once',
            text: args.text,
            label: args.label || args.text?.slice(0, 20),
            fireAt,
            enabled: true,
          })
          results.push({ type: 'reminder', query: 'reminder_create', result: `提醒已创建，将在 ${new Date(fireAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 提醒你。id: ${entry.id.slice(0, 8)}` })
        } else {
          // task_create — 默认 bot_private，任务结果发到 bot 私聊
          const entry = addReminder({
            chatId: chatId || '',
            role: contextRole || 'lomo',
            delivery: 'bot_private',
            type: 'cron',
            prompt: args.prompt,
            label: args.label,
            cron: args.cron,
            session: args.session === true ? true : undefined,
            fireAt: Date.now() + 60_000,
            enabled: true,
          })
          results.push({ type: 'reminder', query: 'task_create', result: `定时任务「${args.label}」已创建（cron: ${args.cron}）。id: ${entry.id.slice(0, 8)}` })
        }
      } else if (tc.function.name === 'reminder_list' || tc.function.name === 'task_list') {
        const all = listReminders(chatId)
        const filtered = tc.function.name === 'task_list'
          ? all.filter(r => r.type === 'cron')
          : all.filter(r => r.type === 'once')
        if (filtered.length === 0) {
          results.push({ type: 'reminder', query: tc.function.name, result: '暂无' + (tc.function.name === 'task_list' ? '定时任务' : '提醒') + '。' })
        } else {
          const lines = filtered.map(r => {
            const time = new Date(r.fireAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
            const status = r.enabled ? '✓' : '✗'
            const sess = r.session ? ' [进session]' : ''
            return `${status} [${r.id.slice(0, 8)}] ${r.label || r.text || r.prompt} — ${r.type === 'once' ? time : r.cron}${sess}`
          })
          results.push({ type: 'reminder', query: tc.function.name, result: lines.join('\n') })
        }
      } else if (tc.function.name === 'reminder_delete' || tc.function.name === 'task_delete') {
        const ok = deleteReminder(args.id)
        results.push({ type: 'reminder', query: tc.function.name, result: ok ? '已删除。' : '找不到该 id。' })
      } else if (tc.function.name === 'reminder_update' || tc.function.name === 'task_update') {
        const patch: any = {}
        if (args.text !== undefined) patch.text = args.text
        if (args.label !== undefined) patch.label = args.label
        if (args.prompt !== undefined) patch.prompt = args.prompt
        if (args.cron !== undefined) patch.cron = args.cron
        if (args.enabled !== undefined) patch.enabled = args.enabled
        if (args.session !== undefined) patch.session = args.session
        if (args.fire_at) {
          const fireAt = new Date(args.fire_at).getTime()
          if (isNaN(fireAt)) {
            results.push({ type: 'reminder', query: tc.function.name, result: 'fire_at 格式无效。', toolCallId: tc.id })
            continue
          }
          patch.fireAt = fireAt
        }
        const updated = updateReminder(args.id, patch)
        results.push({ type: 'reminder', query: tc.function.name, result: updated ? `已更新 ${Object.keys(patch).join('、')}。` : '找不到该 id。' })
      } else if (tc.function.name === 'note_save') {
        const entry = addNote(args.content, args.category || '默认', args.tags || [])
        results.push({ type: 'note', query: 'note_save', result: `已保存 [${entry.category}] id=${entry.id}\n内容: ${entry.content.slice(0, 60)}` })
      } else if (tc.function.name === 'note_list') {
        const { notes, total } = listNotes({ category: args.category, keyword: args.keyword, limit: args.limit })
        if (notes.length === 0) {
          results.push({ type: 'note', query: 'note_list', result: `暂无笔记${args.category ? `（分类：${args.category}）` : ''}${args.keyword ? `（关键词：${args.keyword}）` : ''}。` })
        } else {
          const lines = notes.map(n => {
            const time = new Date(n.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
            const tags = n.tags.length > 0 ? ` [${n.tags.join(',')}]` : ''
            return `- [${n.id}] [${n.category}] ${n.content.slice(0, 80)}${tags} (${time})`
          })
          const header = args.keyword ? `搜索"${args.keyword}"` : (args.category ? `分类：${args.category}` : '全部笔记')
          results.push({ type: 'note', query: 'note_list', result: `${header}（${total}条，显示前${notes.length}条）\n${lines.join('\n')}` })
        }
      } else if (tc.function.name === 'note_update') {
        if (!args.id && !args.keyword) {
          results.push({ type: 'note', query: 'note_update', result: '必须提供 id 或 keyword 参数。' })
        } else {
          const match = findNote({ id: args.id, keyword: args.keyword })
          if (match.type === 'not_found') {
            results.push({ type: 'note', query: 'note_update', result: `找不到该笔记。${args.id ? 'id: ' + args.id.slice(0, 8) : 'keyword: ' + args.keyword}` })
          } else if (match.type === 'ambiguous') {
            const lines = match.candidates!.map(n => {
              const time = new Date(n.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
              return `- [${n.id}] ${n.content.slice(0, 60)} (${time})`
            })
            results.push({ type: 'note', query: 'note_update', result: `找到${match.candidates!.length}条匹配，请用 id 指定：\n${lines.join('\n')}` })
          } else {
            const updated = updateNote(match.note!.id, { content: args.content, append: args.append, category: args.category, tags: args.tags })
            results.push({ type: 'note', query: 'note_update', result: `已更新。id=${updated!.id}\n内容: ${updated!.content.slice(0, 80)}` })
          }
        }
      } else if (tc.function.name === 'note_delete') {
        if (!args.id && !args.keyword) {
          results.push({ type: 'note', query: 'note_delete', result: '必须提供 id 或 keyword 参数。' })
        } else {
          const match = findNote({ id: args.id, keyword: args.keyword })
          if (match.type === 'not_found') {
            results.push({ type: 'note', query: 'note_delete', result: `找不到该笔记。${args.id ? 'id: ' + args.id.slice(0, 8) : 'keyword: ' + args.keyword}` })
          } else if (match.type === 'ambiguous') {
            const lines = match.candidates!.map(n => {
              const time = new Date(n.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
              return `- [${n.id}] ${n.content.slice(0, 60)} (${time})`
            })
            results.push({ type: 'note', query: 'note_delete', result: `找到${match.candidates!.length}条匹配，请用 id 指定要删除的：\n${lines.join('\n')}` })
          } else {
            deleteNote(match.note!.id)
            results.push({ type: 'note', query: 'note_delete', result: `已删除。id=${match.note!.id}` })
          }
        }
      } else if (tc.function.name === 'bash_exec') {
        const { result } = execBash(args.command || '')
        results.push({ type: 'search', query: 'bash_exec', result })
      } else if (tc.function.name === 'mijia_list') {
        const { result } = runMijia(['list'])
        results.push({ type: 'search', query: 'mijia_list', result })
      } else if (tc.function.name === 'mijia_get') {
        const { result } = runMijia(['get', args.name || ''])
        results.push({ type: 'search', query: 'mijia_get', result })
      } else if (tc.function.name === 'mijia_set') {
        const name = args.name || ''
        const prop = args.prop || ''
        const value = String(args.value ?? '')
        const { result } = runMijia(['set', name, prop, value])
        results.push({ type: 'search', query: 'mijia_set', result, toolCallId: tc.id })
      } else if (tc.function.name === 'nearby_search') {
        const loc = getCurrentLocation()
        if (!loc) {
          results.push({ type: 'search', query: 'nearby_search', result: '用户尚未分享位置，请先让用户在飞书中发送位置消息（点击"+"→位置）。' })
        } else {
          const result = await nearbySearch(loc, args.keyword || '', args.radius || 1000, args.type)
          results.push({ type: 'search', query: args.keyword || '', result })
        }
      } else if (tc.function.name === 'archive_search') {
        const role = contextRole || 'lomo'
        const found = searchArchive(role, args.query || '')
        if (found.length === 0) {
          results.push({ type: 'search', query: args.query || '', result: `没有在最近 90 天的历史对话中找到关于"${args.query}"的记录。` })
        } else {
          const lines = found.map((f, i) =>
            `${i + 1}. [${f.date}] ${f.context}`
          )
          results.push({ type: 'search', query: args.query || '', result: `找到 ${found.length} 条相关记录：\n\n${lines.join('\n\n')}` })
        }
      }
      // 统一设置 toolCallId
      if (results.length > 0 && !results[results.length - 1].toolCallId) {
        results[results.length - 1].toolCallId = tc.id
      }
    } catch (err: any) {
      let toolType: 'search' | 'image' | 'video' | 'memory' | 'reminder' | 'note' = 'search'
      if (tc.function.name === 'image_gen') toolType = 'image'
      else if (tc.function.name === 'video_gen') toolType = 'video'
      else if (tc.function.name.startsWith('memory_') || tc.function.name === 'profile_update') toolType = 'memory'
      else if (tc.function.name.startsWith('reminder_') || tc.function.name.startsWith('task_')) toolType = 'reminder'
      else if (tc.function.name.startsWith('note_')) toolType = 'note'
      results.push({ type: toolType, query: '', result: `工具执行出错: ${err.message}`, toolCallId: tc.id })
    }
  }
  return results
}

/** 执行旧格式工具调用（回退） */
export async function executeLegacyToolCalls(calls: LegacyToolCall[]): Promise<ToolResult[]> {
  const results: ToolResult[] = []
  for (const call of calls) {
    if (call.type === 'search') {
      const result = await webSearch(call.query)
      results.push({ type: 'search', query: call.query, result })
    } else if (call.type === 'image') {
      const { text, imageUrl } = await imageGen(call.query)
      results.push({ type: 'image', query: call.query, result: text, imageUrl })
    }
  }
  return results
}
