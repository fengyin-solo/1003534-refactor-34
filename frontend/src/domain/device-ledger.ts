/**
 * 通讯设备历史台账：协议版本回填、信号判定、告警关闭/归档、站点迁移、帧上报等动作
 * 都在这里留痕，记录当时使用的共用规则版本与判定依据（basis），保证历史可复核。
 * 数据独立持久化在 localStorage，不改动各业务模块清单的通用结构。
 */
const LEDGER_STORAGE_KEY = 'hydrology-monitor-station:communication-ledger'

export type DeviceHistoryEvent = {
  id: number
  deviceId: string
  time: string
  type: string
  detail: string
  /** 当时引用的共用规则版本，如 protocol-rules/v1 */
  ruleVersion: string
  /** 判定依据原文，如阈值、时间线匹配结果、活动项规则结论 */
  basis: string
}

let cache: DeviceHistoryEvent[] | null = null

function readLedger(): DeviceHistoryEvent[] {
  if (cache) {
    return cache
  }
  cache = []
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const raw = window.localStorage.getItem(LEDGER_STORAGE_KEY)
      if (raw) {
        cache = JSON.parse(raw) as DeviceHistoryEvent[]
      }
    } catch {
      cache = []
    }
  }
  return cache
}

function persist(): void {
  if (typeof window !== 'undefined' && window.localStorage && cache) {
    window.localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(cache))
  }
}

/** 追加一条设备历史（内存态先构建、落盘时统一调用，见 local-store 的迁移流程） */
export function appendDeviceEvent(event: Omit<DeviceHistoryEvent, 'id'>): DeviceHistoryEvent {
  const events = readLedger()
  const next: DeviceHistoryEvent = {
    ...event,
    id: events.reduce((max, item) => Math.max(max, item.id), 0) + 1,
  }
  events.push(next)
  persist()
  return next
}

/** 批量预置历史（存量数据迁移时使用），不逐条落盘 */
export function seedDeviceEvents(events: Omit<DeviceHistoryEvent, 'id'>[]): void {
  const events_ = readLedger()
  let nextId = events_.reduce((max, item) => Math.max(max, item.id), 0) + 1
  for (const event of events) {
    events_.push({ ...event, id: nextId++ })
  }
  persist()
}

/** 历史是否已预置（设备编号 + 事件类型去重），避免每次加载重复追加 */
export function hasDeviceEvent(deviceId: string, type: string): boolean {
  return readLedger().some((event) => event.deviceId === deviceId && event.type === type)
}

export function eventsOfDevice(deviceId: string): DeviceHistoryEvent[] {
  return readLedger()
    .filter((event) => event.deviceId === deviceId)
    .sort((a, b) => (a.time < b.time ? 1 : -1))
}

export function allDeviceEvents(): DeviceHistoryEvent[] {
  return readLedger()
}

export function clearLedger(): void {
  cache = []
  persist()
}

/** 供测试与迁移装配时注入初始事件后落盘 */
export function persistLedger(): void {
  persist()
}

export function ledgerStorageKey(): string {
  return LEDGER_STORAGE_KEY
}
