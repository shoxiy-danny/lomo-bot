/**
 * Memory Tools — 6 个 tool calling 定义 + 执行器
 *
 * 注册到 Lomo 现有 TOOLS 数组后，LLM 可在对话中自主调 memory_store / memory_recall。
 * memory_update / memory_delete / memory_list 仅供 /memory 命令或主人 OOC 使用，
 * 安全规则：LLM 不可自主调 update/delete（防误删）
 *
 * v1 实现：
 *   - 6 个 tool 函数（CRUD + 检索 + 列表）
 *   - 工具执行器 executeMemoryTools()
 *   - ToolDef 数组供 tools.ts 注册
 */

import type { ToolDef, ToolCall } from '../llm/types'
import {
  add, findById, updateById, deleteById, getAll, count,
} from './store'
import { retrieveMemory } from './retrieve'
import { loadProfile, saveProfile } from './profile'
import { checkDedup } from './dedup'
import { forceCleanIfOverCap } from './cleanup'
import {
  createMemoryEntry, type MemoryEntry, type MemoryType, type Profile,
} from './types'

// ── Tool Definitions（给 LLM API 用） ─────────────────────────────

export const MEMORY_STORE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'memory_store',
    description: '存储一条关于主人的长期记忆（偏好/习惯/项目/事件/关系/目标）。content 限 1-3 句中文。这是结构化记忆，会参与后续检索。如果要存"临时备忘/随手记"，用 note_save。',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['identity', 'preference', 'relationship', 'goal', 'project', 'event'],
          description: '记忆类型',
        },
        content: {
          type: 'string',
          description: '1-3 句中文描述',
        },
        importance: {
          type: 'number',
          enum: [1, 2, 3, 4, 5],
          description: '重要度 1-5，默认 3',
        },
        confidence: {
          type: 'number',
          description: '置信度 0-1，默认 0.8',
        },
        tags: {
          type: 'string',
          description: '逗号分隔的标签，如 "咖啡,日式"',
        },
      },
      required: ['type', 'content'],
    },
  },
}

export const MEMORY_RECALL_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'memory_recall',
    description: '搜索已提取的主人记忆（偏好/习惯/项目/关系/目标等）。当你需要了解主人的喜好或背景时调用。如果要搜原始对话记录，用 archive_search。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        type_filter: {
          type: 'string',
          enum: ['identity', 'preference', 'relationship', 'goal', 'project', 'event'],
          description: '可选：只搜某类记忆',
        },
        limit: { type: 'number', description: '返回条数上限，默认 5' },
      },
      required: ['query'],
    },
  },
}

export const MEMORY_LIST_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'memory_list',
    description: '列出主人当前的记忆。可按 type 过滤、按 importance/access/created 排序。供主人查看用。',
    parameters: {
      type: 'object',
      properties: {
        type_filter: {
          type: 'string',
          enum: ['identity', 'preference', 'relationship', 'goal', 'project', 'event'],
        },
        sort_by: {
          type: 'string',
          enum: ['recent', 'importance', 'accessed'],
        },
        limit: { type: 'number' },
      },
    },
  },
}

export const MEMORY_UPDATE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'memory_update',
    description: '更新一条已有记忆的内容/重要度/钉状态。**仅供主人显式命令时使用**（如"把那条记错了删掉"），不要自主调用。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        content: { type: 'string' },
        importance: { type: 'number', enum: [1, 2, 3, 4, 5] },
        pinned: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
}

export const MEMORY_DELETE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'memory_delete',
    description: '删除一条记忆。**仅供主人显式命令时使用**（如"把那条记错了删掉"），不要自主调用。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
}

export const PROFILE_UPDATE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'profile_update',
    description: '更新 Core Profile 的某个字段。**两种合法调用场景**：(1) Profile 未初始化时初始化（用户告知了称呼/项目/习惯/联系人时立即调用保存）；(2) 会话结束整理阶段。**重要：更新数组字段（core_habits/core_projects/core_contacts）时，优先用 append（追加一条），不要用 set（覆盖全部），除非用户明确说"替换/清空重来"。**',
    parameters: {
      type: 'object',
      properties: {
        field: {
          type: 'string',
          enum: ['name', 'preferred_name', 'core_habits', 'core_projects', 'core_contacts'],
          description: '要更新的字段',
        },
        action: {
          type: 'string',
          enum: ['set', 'append', 'remove'],
          description: 'set=覆盖, append=追加, remove=删除',
        },
        value: { type: 'string', description: 'JSON 序列化的值。例：preferred_name 直接传 "Alice"；core_habits 传 [{"habit":"不吃早饭","source":"llm"}]；core_contacts 传 {"小明":"同事"}' },
      },
      required: ['field', 'action', 'value'],
    },
  },
}

export const MEMORY_TOOLS: ToolDef[] = [
  MEMORY_STORE_TOOL,
  MEMORY_RECALL_TOOL,
  MEMORY_LIST_TOOL,
  MEMORY_UPDATE_TOOL,
  MEMORY_DELETE_TOOL,
  PROFILE_UPDATE_TOOL,
]

// ── 工具执行器 ────────────────────────────────────────────────────

export interface MemoryToolResult {
  type: string
  ok: boolean
  message: string
  data?: any
}

function truncate(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) + '...' : s
}

function executeStore(role: string, args: any): MemoryToolResult {
  const { type, content, importance, confidence, tags } = args
  if (!type || !content) {
    return { type: 'memory_store', ok: false, message: '缺少 type 或 content' }
  }
  // 截断超长 content（>5 句）
  const sentences = content.split(/[。！？]/).filter((s: string) => s.trim())
  const truncated = sentences.length > 5
    ? sentences.slice(0, 5).join('。') + '。'
    : content

  const tagsArr = tags ? String(tags).split(',').map((t: string) => t.trim()).filter(Boolean) : undefined

  // 写入前去重
  const decision = checkDedup(role, { type: type as MemoryType, content: truncated, tags: tagsArr })
  if (decision.action === 'skip') {
    return {
      type: 'memory_store',
      ok: true,
      message: `已存在相似记忆，跳过写入 (${decision.reason})`,
      data: { id: decision.existingId, skipped: true },
    }
  }
  if (decision.action === 'update' && decision.patch) {
    updateById(role, decision.existingId, decision.patch)
    return {
      type: 'memory_store',
      ok: true,
      message: `更新已有记忆 (${decision.reason})`,
      data: { id: decision.existingId, updated: true },
    }
  }

  // NEW 或 CONFLICT：新增条目
  const entry = createMemoryEntry({
    type: type as MemoryType,
    content: truncated,
    importance: importance ?? 3,
    confidence: confidence ?? 0.8,
    tags: tagsArr,
    ...(decision.action === 'conflict' ? { supersedes: decision.existingId } : {}),
  })
  // 写入前 force-clean（如超 cap）
  forceCleanIfOverCap(role)
  add(role, entry)
  return {
    type: 'memory_store',
    ok: true,
    message: `已记录 [${type}] ${truncate(truncated, 60)}${decision.action === 'conflict' ? ` (替代 ${decision.existingId.slice(0, 8)})` : ''}`,
    data: { id: entry.id },
  }
}

function executeRecall(role: string, args: any): MemoryToolResult {
  const { query, type_filter, limit } = args
  if (!query) return { type: 'memory_recall', ok: false, message: '缺少 query' }
  const results = retrieveMemory(role, query, {
    k: limit ?? 5,
    type_filter: type_filter as MemoryType | undefined,
  })
  if (results.length === 0) {
    return { type: 'memory_recall', ok: true, message: '没有找到相关记忆', data: [] }
  }
  const lines = results.map(m => `[${m.type}] ${truncate(m.content, 100)} (imp=${m.importance})`)
  return {
    type: 'memory_recall',
    ok: true,
    message: `找到 ${results.length} 条:\n${lines.join('\n')}`,
    data: results,
  }
}

function executeList(role: string, args: any): MemoryToolResult {
  const { type_filter, sort_by, limit } = args
  let all = getAll(role)
  if (type_filter) all = all.filter(e => e.type === type_filter)

  switch (sort_by) {
    case 'importance':
      all.sort((a, b) => b.importance - a.importance || b.last_accessed_at.localeCompare(a.last_accessed_at))
      break
    case 'accessed':
      all.sort((a, b) => b.last_accessed_at.localeCompare(a.last_accessed_at))
      break
    case 'recent':
    default:
      all.sort((a, b) => b.created_at.localeCompare(a.created_at))
  }

  const top = all.slice(0, limit ?? 20)
  if (top.length === 0) {
    return { type: 'memory_list', ok: true, message: '当前没有记忆', data: [] }
  }
  const lines = top.map(m => `- [${m.type}] ${truncate(m.content, 80)} (imp=${m.importance}${m.pinned ? ',pinned' : ''})`)
  return {
    type: 'memory_list',
    ok: true,
    message: `共 ${count(role)} 条，展示前 ${top.length} 条:\n${lines.join('\n')}`,
    data: top,
  }
}

function executeUpdate(role: string, args: any): MemoryToolResult {
  const { id, content, importance, pinned } = args
  if (!id) return { type: 'memory_update', ok: false, message: '缺少 id' }
  const patch: Partial<MemoryEntry> = {}
  if (content !== undefined) patch.content = content
  if (importance !== undefined) patch.importance = importance
  if (pinned !== undefined) patch.pinned = pinned
  const updated = updateById(role, id, patch)
  if (!updated) return { type: 'memory_update', ok: false, message: '未找到该 id' }
  return { type: 'memory_update', ok: true, message: '已更新', data: { id } }
}

function executeDelete(role: string, args: any): MemoryToolResult {
  const { id } = args
  if (!id) return { type: 'memory_delete', ok: false, message: '缺少 id' }
  const ok = deleteById(role, id)
  return { type: 'memory_delete', ok, message: ok ? '已删除' : '未找到该 id' }
}

function executeProfileUpdate(role: string, args: any): MemoryToolResult {
  const { field, action, value } = args
  if (!field || !action || value === undefined) {
    return { type: 'profile_update', ok: false, message: '缺少 field/action/value' }
  }

  const profile = loadProfile(role)
  let parsedValue: any
  try {
    parsedValue = JSON.parse(value)
  } catch {
    parsedValue = value
  }

  switch (field) {
    case 'name':
    case 'preferred_name':
      if (action === 'set') (profile as any)[field] = parsedValue
      else return { type: 'profile_update', ok: false, message: `${field} 只支持 set` }
      break
    case 'core_habits':
    case 'core_projects': {
      const arr = (profile as any)[field] as any[]
      if (action === 'set') {
        ;(profile as any)[field] = Array.isArray(parsedValue) ? parsedValue : [parsedValue]
      } else if (action === 'append') {
        arr.push(parsedValue)
      } else if (action === 'remove') {
        const idx = arr.findIndex((x: any) => JSON.stringify(x) === JSON.stringify(parsedValue))
        if (idx >= 0) arr.splice(idx, 1)
      }
      break
    }
    case 'core_contacts': {
      const contacts = profile.core_contacts
      if (action === 'set' && typeof parsedValue === 'object') {
        Object.assign(contacts, parsedValue)
      } else if (action === 'remove' && typeof parsedValue === 'string') {
        delete contacts[parsedValue]
      } else {
        return { type: 'profile_update', ok: false, message: 'core_contacts 需 set+object 或 remove+string' }
      }
      break
    }
  }

  saveProfile(role, profile)
  return { type: 'profile_update', ok: true, message: `已更新 ${field} (${action})` }
}

/** 工具分发 */
export function executeMemoryTool(
  role: string,
  toolCall: ToolCall,
): MemoryToolResult {
  let args: any = {}
  try {
    args = JSON.parse(toolCall.function.arguments)
  } catch (err: any) {
    return { type: toolCall.function.name, ok: false, message: `参数解析失败: ${err.message}` }
  }

  const name = toolCall.function.name
  switch (name) {
    case 'memory_store': return executeStore(role, args)
    case 'memory_recall': return executeRecall(role, args)
    case 'memory_list': return executeList(role, args)
    case 'memory_update': return executeUpdate(role, args)
    case 'memory_delete': return executeDelete(role, args)
    case 'profile_update': return executeProfileUpdate(role, args)
    default: return { type: name, ok: false, message: '未知工具' }
  }
}
