// 通讯设备判定历史：每次判定（迁移回填、帧上报、人工流转）都把结论和依据留痕，
// 独立于业务数据单独持久化，清业务数据不影响这里的历史依据。

const HISTORY_KEY = 'hydrology-monitor-station:comm-history'
const MAX_RECORDS_PER_DEVICE = 20

export type JudgmentRecord = {
  时刻: string
  结论: string
  依据: string[]
}

export function nowText(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

function readAll(): Record<string, JudgmentRecord[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {}
  }
  const raw = window.localStorage.getItem(HISTORY_KEY)
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw) as Record<string, JudgmentRecord[]>
  } catch {
    return {}
  }
}

function writeAll(records: Record<string, JudgmentRecord[]>): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify(records))
}

export function appendCommHistory(deviceNo: string, record: JudgmentRecord): void {
  const all = readAll()
  const list = [...(all[deviceNo] ?? []), record]
  all[deviceNo] = list.slice(-MAX_RECORDS_PER_DEVICE)
  writeAll(all)
}

export function commHistoryOf(deviceNo: string): JudgmentRecord[] {
  return readAll()[deviceNo] ?? []
}
