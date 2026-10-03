/**
 * 站房巡检待办：其它入口（站房维护、巡检记录页面）都从这里取待办，
 * 协议相关的判定一律复用 protocol-rules，不再另写信号弱 / 活动项判断。
 */
import { isActiveDevice, isWeakSignal, specOf, weakSignalBasis } from './protocol-rules'
import type { EntryRow } from '@/data/types'

export type InspectionTodo = {
  deviceId: string
  stationId: string
  deviceType: string
  protocol: string
  version: string
  signalDbm: number | null
  reasons: string[]
  /** 每条待办携带判定依据，巡检人可核对，也保证各入口看到的结论一致 */
  basis: string[]
}

function signalDbmOf(row: EntryRow): number | null {
  const value = Number(row['信号强度'])
  return Number.isFinite(value) ? value : null
}

/** 基于通讯设备清单生成站房巡检待办：活动设备中通讯中断或信号弱者入选 */
export function buildInspectionTodos(devices: EntryRow[]): InspectionTodo[] {
  return devices
    .filter((row) => isActiveDevice(row))
    .map((row) => {
      const protocol = String(row['通讯协议'] ?? '')
      const version = String(row['协议版本'] ?? '')
      const signalDbm = signalDbmOf(row)
      const status = String(row['状态'] ?? row.status ?? '')
      const reasons: string[] = []
      if (status === '通讯中断') {
        reasons.push('通讯中断')
      }
      const weak = isWeakSignal({ protocol, version, signalDbm })
      if (weak === true) {
        reasons.push('信号弱')
      }
      return {
        deviceId: String(row['设备编号'] ?? ''),
        stationId: String(row['所属站点'] ?? ''),
        deviceType: String(row['设备类型'] ?? ''),
        protocol,
        version,
        signalDbm,
        reasons,
        basis: [
          `活动项：${isActiveDevice(row) ? '是' : '否'}（归档标记=${row['归档标记'] ?? '否'}，告警状态=${row['告警状态'] ?? '开启'}）`,
          weakSignalBasis({ protocol, version, signalDbm }),
        ],
      }
    })
    .filter((todo) => todo.reasons.length > 0)
}

/** 按站点筛待办：站房维护页按站点编号查看本房巡检项 */
export function todosOfStation(todos: InspectionTodo[], stationId: string): InspectionTodo[] {
  return todos.filter((todo) => todo.stationId === stationId)
}

export function todoLabel(todo: InspectionTodo): string {
  const spec = specOf(todo.protocol, todo.version)
  const family = spec ? `（${spec.family === 'narrowband' ? '窄带' : '蜂窝'}）` : ''
  return `${todo.deviceId} ${todo.protocol}${family}：${todo.reasons.join('、')}`
}
