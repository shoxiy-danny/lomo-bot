/**
 * Profile — profile.json 读写 + 稳定序列化
 *
 * 关键约束：
 *   - serializeProfile() 输出必须**字节级稳定**（同样 Profile → 同样字符串）
 *   - 否则 system prompt 拼接 profile 后会破坏 M3 的 prompt caching
 *   - 字段顺序固定 + JSON.stringify 不带空格 + 不带 undefined 字段
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import type { Profile } from './types'
import { emptyProfile, roleId } from './types'

const STATE_ROOT = join(
  process.env.HOME || '/tmp',
  'Projects', 'Lomo', 'state', 'memory',
)

function profileFile(role: string): string {
  return join(STATE_ROOT, roleId(role), 'profile.json')
}

function ensureDir(role: string): void {
  const dir = join(STATE_ROOT, roleId(role))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function atomicWrite(filePath: string, content: string): void {
  const tmpPath = filePath + '.tmp'
  writeFileSync(tmpPath, content, { mode: 0o600 })
  renameSync(tmpPath, filePath)
}

// ── 公共 API ──────────────────────────────────────────────────────

/** 读取 profile（不存在则返回空 profile，不写盘） */
export function loadProfile(role: string): Profile {
  const file = profileFile(role)
  if (!existsSync(file)) return emptyProfile()
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return data as Profile
  } catch (err) {
    console.error(`[memory/profile] ${role}/profile.json 损坏: ${err}`)
    return emptyProfile()
  }
}

/** 保存 profile（原子写） */
export function saveProfile(role: string, profile: Profile): void {
  ensureDir(role)
  const updated: Profile = { ...profile, updated_at: new Date().toISOString() }
  atomicWrite(profileFile(role), JSON.stringify(updated, null, 2) + '\n')
}

/** 是否已初始化（profile.json 存在） */
export function isInitialized(role: string): boolean {
  return existsSync(profileFile(role))
}

/**
 * 序列化为稳定字符串
 *
 * 稳定性保证：
 *   - 字段顺序固定（手写拼装，不依赖 JSON.stringify 默认顺序）
 *   - 无多余空格
 *   - undefined 字段不输出
 */
export function serializeProfile(profile: Profile): string {
  const parts: string[] = []
  if (profile.name) parts.push(`姓名: ${profile.name}`)
  if (profile.preferred_name) parts.push(`称呼: ${profile.preferred_name}`)
  if (profile.core_habits.length > 0) {
    parts.push('核心习惯:')
    for (const h of profile.core_habits) {
      const since = h.since ? `（从 ${h.since}）` : ''
      parts.push(`  - ${h.habit}${since}`)
    }
  }
  if (profile.core_projects.length > 0) {
    parts.push('核心项目:')
    for (const p of profile.core_projects) {
      const path = p.path ? ` [${p.path}]` : ''
      const status = p.status ? ` (${p.status})` : ''
      parts.push(`  - ${p.name}${path}${status}`)
    }
  }
  if (Object.keys(profile.core_contacts).length > 0) {
    parts.push('重要联系人:')
    for (const [name, relation] of Object.entries(profile.core_contacts)) {
      parts.push(`  - ${name}: ${relation}`)
    }
  }
  return parts.join('\n')
}
