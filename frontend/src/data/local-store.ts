import { COMM_SCHEMA_VERSION, migrateCommDevices } from './comm-migration'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'
// 数据结构版本：升级结构（如通讯设备回填协议版本）时递增，加载时自动补迁移。
const SCHEMA_VERSION_KEY = 'hydrology-monitor-station:schema-version'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

function readSchemaVersion(): number {
  if (typeof window === 'undefined' || !window.localStorage) {
    return 1
  }
  const raw = window.localStorage.getItem(SCHEMA_VERSION_KEY)
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isNaN(parsed) ? 1 : parsed
}

function writeSchemaVersion(version: number): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(SCHEMA_VERSION_KEY, String(version))
  }
}

function persist(tables: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tables))
  }
}

// 结构版本落后时补跑迁移（目前只有通讯设备回填协议版本），迁移幂等，重复跑无副作用。
function ensureSchema(): void {
  if (cache === null || readSchemaVersion() >= COMM_SCHEMA_VERSION) {
    return
  }
  cache = { ...cache, communication: migrateCommDevices(cache['communication'] ?? []).rows }
  persist(cache)
  writeSchemaVersion(COMM_SCHEMA_VERSION)
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
    ensureSchema()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  persist(next)
}

export function resetRows(key: string): EntryRow[] {
  saveRows(key, clone(SEED_ROWS[key] ?? []))
  if (key === 'communication') {
    // 重置回示例数据后同样要补齐协议版本，保持「读出来的都是迁移后结构」。
    saveRows(key, migrateCommDevices(listRows(key)).rows)
  }
  return listRows(key)
}

export function storageKey(): string {
  return STORAGE_KEY
}
