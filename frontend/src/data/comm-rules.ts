import type { EntryRow } from './types'

// 通讯设备共用判定规则：窄带/蜂窝的信号弱边界、告警关闭、归档结果三处判断统一收拢在本文件，
// 通讯系统页、帧上报、站房巡检待办都走同一套，不再各算各的。

export type ProtocolKind = '窄带' | '蜂窝'

// 信号弱边界（dBm）全系统唯一一份，调边界只改这里。
export const WEAK_SIGNAL_THRESHOLD_DBM: Record<ProtocolKind, number> = {
  窄带: -105,
  蜂窝: -95,
}

// 各协议帧的信号量程（dBm），帧解析时校验，超出即判定该帧解析失败。
export const SIGNAL_RANGE_DBM: Record<ProtocolKind, [number, number]> = {
  窄带: [-130, -40],
  蜂窝: [-120, -30],
}

// 协议未识别时按更严的边界判定，宁可多报一次巡检也不漏。
const STRICT_FALLBACK_THRESHOLD_DBM = -95

export type CommJudgment = {
  kind: ProtocolKind | null
  thresholdDbm: number
  signalDbm: number | null
  signalWeak: boolean
  alarmOpen: boolean
  archived: boolean
  active: boolean
  basis: string[]
}

export function protocolKindOfText(text: unknown): ProtocolKind | null {
  const value = String(text ?? '')
  if (value.includes('窄带')) {
    return '窄带'
  }
  if (value.includes('蜂窝')) {
    return '蜂窝'
  }
  return null
}

export function protocolKindOf(row: EntryRow): ProtocolKind | null {
  return protocolKindOfText(row['通讯协议'])
}

export function isWeakSignal(kind: ProtocolKind, dbm: number): boolean {
  return dbm < WEAK_SIGNAL_THRESHOLD_DBM[kind]
}

function parseSignalDbm(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) {
    return null
  }
  const parsed = Number(value)
  return Number.isNaN(parsed) ? null : parsed
}

// 三处判断的唯一入口：信号弱边界 → 告警开/关 → 归档/活动项，依据逐条写进 basis 供留存。
export function judgeCommDevice(row: EntryRow): CommJudgment {
  const kind = protocolKindOf(row)
  const thresholdDbm = kind ? WEAK_SIGNAL_THRESHOLD_DBM[kind] : STRICT_FALLBACK_THRESHOLD_DBM
  const signalDbm = parseSignalDbm(row['信号强度'])
  const status = String(row.status)
  const basis: string[] = []

  if (kind) {
    basis.push(`协议=${kind}，信号弱边界=${thresholdDbm}dBm`)
  } else {
    basis.push(`协议「${String(row['通讯协议'] ?? '') || '空'}」未识别，按更严边界${thresholdDbm}dBm判定`)
  }

  const signalWeak = signalDbm !== null && signalDbm < thresholdDbm
  if (signalDbm === null) {
    basis.push('信号强度缺失，无法按边界判定')
  } else {
    basis.push(
      signalWeak
        ? `信号强度${signalDbm}dBm低于边界，判定信号弱`
        : `信号强度${signalDbm}dBm不低于边界`,
    )
  }

  const interrupted = status === '通讯中断'
  const alarmOpen = interrupted || signalWeak
  basis.push(alarmOpen ? `告警打开：${interrupted ? '通讯中断' : '信号弱'}` : '告警关闭：信号恢复且无中断')

  // 归档与活动项共用同一结论：待更换直接归档；告警已关闭（含旧协议恢复）也归档，不再当活动项。
  const replaced = status === '待更换'
  const archived = replaced || !alarmOpen
  basis.push(archived ? `归档：${replaced ? '设备待更换' : '告警已关闭'}` : '未归档：告警仍打开')

  const active = alarmOpen && !archived
  basis.push(active ? '活动项：需巡检处理' : '非活动项：不进入巡检待办')

  return { kind, thresholdDbm, signalDbm, signalWeak, alarmOpen, archived, active, basis }
}

// 协议版本回填规则：以最近通讯时刻为界，之前的存量设备算旧协议 V1，之后的算新协议 V2。
export const PROTOCOL_VERSION_CUTOFF = '2026-01-01 00:00'

export function backfillProtocolVersion(lastCommAt: unknown): { version: string; basis: string } {
  const text = String(lastCommAt ?? '').trim()
  const time = Date.parse(text.replace(' ', 'T'))
  if (!text || Number.isNaN(time)) {
    return { version: 'V1', basis: `最近通讯时刻「${text || '缺失'}」无法解析，按旧协议V1回填` }
  }
  const cutoff = Date.parse(PROTOCOL_VERSION_CUTOFF.replace(' ', 'T'))
  return time >= cutoff
    ? { version: 'V2', basis: `最近通讯时刻${text}不早于${PROTOCOL_VERSION_CUTOFF}，回填新协议V2` }
    : { version: 'V1', basis: `最近通讯时刻${text}早于${PROTOCOL_VERSION_CUTOFF}，回填旧协议V1` }
}
