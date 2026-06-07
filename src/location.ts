/**
 * Location — 用户位置存取（会话级，不存记忆）
 *
 * - 只保留最新位置（覆盖写）
 * - 2 小时 TTL，过期自动失效
 * - 存 state/location.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const HOME = process.env.HOME || '/home/user'
const STATE_DIR = join(HOME, 'Projects', 'Lomo', 'state')
const LOCATION_FILE = join(STATE_DIR, 'location.json')

const TTL_MS = 2 * 60 * 60 * 1000 // 2 小时

export interface LocationData {
  latitude: number
  longitude: number
  name: string
  address: string
  updated_at: string // ISO 8601
}

export function saveLocation(loc: LocationData): void {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(LOCATION_FILE, JSON.stringify(loc, null, 2) + '\n')
}

export function getCurrentLocation(): LocationData | null {
  try {
    if (!existsSync(LOCATION_FILE)) return null
    const raw = readFileSync(LOCATION_FILE, 'utf8')
    const loc = JSON.parse(raw) as LocationData
    // TTL 检查
    const age = Date.now() - new Date(loc.updated_at).getTime()
    if (age > TTL_MS) return null
    return loc
  } catch {
    return null
  }
}

export function formatLocation(loc: LocationData): string {
  const name = loc.name || '未知位置'
  const addr = loc.address || ''
  return `${name}（${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}）${addr ? ' — ' + addr : ''}`
}
