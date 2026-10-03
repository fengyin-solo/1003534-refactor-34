import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'
import {
  backfillProtocolVersions,
  isLegacyCommunicationRows,
  seedCommunicationBaseline,
} from '@/domain/device-bootstrap'
import { PROTOCOL_RULE_VERSION } from '@/domain/protocol-rules'
import { seedDeviceEvents } from '@/domain/device-ledger'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'
const SCHEMA_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type StoredData = Record<string, EntryRow[]>
type StoredDataWithVersion = {
  [key: string]: EntryRow[] | number | undefined
  __schemaVersion?: number
}

function stripVersion(data: StoredDataWithVersion): StoredData {
  const entries: StoredData = {}
  for (const [key, value] of Object.entries(data)) {
    if (key !== '__schemaVersion') {
      entries[key] = value as EntryRow[]
    }
  }
  return entries
}

function withVersion(data: StoredData): StoredDataWithVersion {
  return { ...data, __schemaVersion: SCHEMA_VERSION }
}

/**
 * 通讯设备存量规范化：
 * 1. 旧版占位样例（信号强度非数值）整组换成新通讯种子；
 * 2. 存量设备按最近通讯时刻回填协议版本；
 * 3. 回填 / 归档 / 告警关闭的历史依据写入设备台账。
 * 返回规范化后的数据与「是否发生变化」。
 */
export function normalizeCommunication(data: StoredData): { data: StoredData; changed: boolean } {
  let changed = false
  let communication = data.communication

  if (communication && isLegacyCommunicationRows(communication)) {
    communication = clone(SEED_ROWS.communication)
    data.communication = communication
    changed = true
  }

  if (communication && communication.length > 0) {
    const before = JSON.stringify(communication)
    const { rows, events } = backfillProtocolVersions(communication)
    communication = rows
    data.communication = rows
    if (JSON.stringify(rows) !== before) {
      changed = true
    }
    if (events.length > 0) {
      seedDeviceEvents(
        events.map((event) => ({ ...event, type: '协议版本回填', ruleVersion: PROTOCOL_RULE_VERSION })),
      )
    }
    // 存量设备归档、告警关闭的历史基线（内部按设备+类型去重）
    seedCommunicationBaseline(communication)
  }

  return { data, changed }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded: StoredData = clone(fallback)
    const { data, changed } = normalizeCommunication(seeded)
    if (changed) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(withVersion(data)))
    }
    return data
  }
  try {
    const parsed = JSON.parse(raw) as StoredDataWithVersion
    const merged: StoredData = { ...clone(SEED_ROWS), ...stripVersion(parsed) }
    if (parsed.__schemaVersion !== SCHEMA_VERSION) {
      const { data, changed } = normalizeCommunication(merged)
      if (changed) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(withVersion(data)))
      }
      return data
    }
    return merged
  } catch {
    const seeded: StoredData = clone(fallback)
    const { data } = normalizeCommunication(seeded)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(withVersion(data)))
    return data
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(withVersion(next)))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
