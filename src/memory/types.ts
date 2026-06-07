/**
 * Memory System — 类型定义
 *
 * 三个核心数据结构：
 *   - MemoryEntry: 单条记忆
 *   - Profile: Core Profile（始终注入，session 内冻结）
 *   - SessionSummary: 会话摘要（注入到 postMessages）
 */

import { randomUUID } from 'crypto'

// ── Memory Entry ──────────────────────────────────────────────────

export type MemoryType =
  | 'identity'        // 主人身份/基本信息
  | 'preference'      // 偏好/习惯
  | 'relationship'    // 人物关系
  | 'goal'            // 目标/计划
  | 'project'         // 项目信息
  | 'event'           // 事件/经历

export interface MemoryEntry {
  id: string
  type: MemoryType
  content: string           // 1-3 句中文，超过 5 句会被截断
  importance: 1 | 2 | 3 | 4 | 5
  confidence: number        // 0-1
  tags?: string[]
  created_at: string
  last_accessed_at: string
  access_count: number
  pinned: boolean
  supersedes?: string       // 指向被替代的旧记忆 id
}

export function createMemoryEntry(partial: Partial<MemoryEntry> & {
  type: MemoryType
  content: string
}): MemoryEntry {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    importance: 3,
    confidence: 0.8,
    access_count: 0,
    pinned: false,
    created_at: now,
    last_accessed_at: now,
    ...partial,
  }
}

// ── Profile ───────────────────────────────────────────────────────

export interface ProfileHabit {
  habit: string
  since?: string
  source: 'profile_init' | 'llm' | 'owner'
}

export interface ProfileProject {
  name: string
  path?: string
  status?: string
}

export interface Profile {
  name?: string
  preferred_name?: string
  core_habits: ProfileHabit[]
  core_projects: ProfileProject[]
  core_contacts: Record<string, string>
  updated_at: string
}

export function emptyProfile(): Profile {
  return {
    core_habits: [],
    core_projects: [],
    core_contacts: {},
    updated_at: new Date().toISOString(),
  }
}

// ── Session Summary ───────────────────────────────────────────────

export interface SessionSummary {
  session_id: string
  role: string              // 角色 id = session.characterName
  summary: string           // ≤ 150 字
  created_at: string
}

// ── Role Id Helper ────────────────────────────────────────────────

/** 从 session.characterName 拿到记忆目录的子目录名（角色 id） */
export function roleId(characterName: string): string {
  // 暂时直接用 characterName（小写）作为目录名
  return characterName.toLowerCase()
}
