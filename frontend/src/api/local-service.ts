import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'
import {
  PROTOCOL_RULE_VERSION,
  activeBasis,
  isActiveDevice,
  isWeakSignal,
  weakSignalBasis,
} from '@/domain/protocol-rules'
import {
  type CommunicationFrame,
  type FrameBatchResult,
  type FrameOutcome,
  applyUpdates,
  processFrames,
} from '@/domain/frame-ingest'
import {
  type DeviceHistoryEvent,
  appendDeviceEvent,
  clearLedger,
  eventsOfDevice,
} from '@/domain/device-ledger'
import { migrateDeviceProtocol } from '@/domain/device-bootstrap'
import { normalizeCommunication } from '@/data/local-store'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const COMMUNICATION_KEY = 'communication'
const FRAME_STATE_KEY = 'hydrology-monitor-station:frame-state'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function recordEvent(
  deviceId: string,
  type: string,
  detail: string,
  basis: string,
): void {
  appendDeviceEvent({
    deviceId,
    time: new Date().toISOString(),
    type,
    detail,
    ruleVersion: PROTOCOL_RULE_VERSION,
    basis,
  })
}

function signalDbm(row: EntryRow): number | null {
  const value = Number(row['信号强度'])
  return Number.isFinite(value) ? value : null
}

/** 共用规则复核：按信号弱边界重算状态 */
function statusFromSignal(row: EntryRow): { status: string; basis: string } {
  const protocol = String(row['通讯协议'] ?? '')
  const version = String(row['协议版本'] ?? '')
  const dbm = signalDbm(row)
  const weak = isWeakSignal({ protocol, version, signalDbm: dbm })
  if (weak === true) {
    return { status: '信号弱', basis: weakSignalBasis({ protocol, version, signalDbm: dbm }) }
  }
  return { status: '通讯正常', basis: weakSignalBasis({ protocol, version, signalDbm: dbm }) }
}

function genericUpdate(
  key: string,
  id: number,
  action: string,
  meta: ModuleMeta,
  target: string,
): ActionResult {
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/** 通讯设备动作：告警关闭 / 归档共用 isActiveDevice 一条规则，并全部留历史依据 */
function communicationAction(row: EntryRow, action: string): ActionResult {
  const deviceId = String(row['设备编号'])
  const currentStatus = String(row.status)
  let updated: EntryRow = { ...row }

  switch (action) {
    case '登记故障':
      if (currentStatus === '通讯中断') {
        return { ok: false, message: '设备已经是「通讯中断」，不用重复操作' }
      }
      updated = { ...row, status: '通讯中断', pending: false, abnormal: true }
      recordEvent(deviceId, '登记故障', '链路登记为通讯中断', activeBasis(row))
      break
    case '确认恢复':
      if (row['归档标记'] === '是' || row['告警状态'] === '关闭') {
        return {
          ok: false,
          message: '设备已归档或告警已关闭，恢复链路不改变非活动身份（共用活动项规则）',
        }
      }
      {
        const judged = statusFromSignal(row)
        updated = { ...row, status: judged.status, pending: judged.status !== '待更换', abnormal: judged.status !== '通讯正常' }
        recordEvent(deviceId, '确认恢复', `链路恢复，按共用规则复核为「${judged.status}」`, judged.basis)
      }
      break
    case '申请更换':
      updated = { ...row, status: '待更换', pending: true, abnormal: true }
      recordEvent(deviceId, '申请更换', '设备标记为待更换', activeBasis(row))
      break
    case '关闭告警':
      if (row['告警状态'] === '关闭') {
        return { ok: false, message: '告警已经是关闭状态' }
      }
      updated = { ...row, 告警状态: '关闭' }
      recordEvent(deviceId, '告警关闭', '告警关闭', activeBasis(updated))
      break
    case '重开告警':
      if (row['告警状态'] !== '关闭') {
        return { ok: false, message: '告警处于开启状态，无需重开' }
      }
      if (row['归档标记'] === '是') {
        return { ok: false, message: '设备已归档，告警不能脱离归档单独重开' }
      }
      updated = { ...row, 告警状态: '开启' }
      recordEvent(deviceId, '重开告警', '告警重新开启', activeBasis(updated))
      break
    case '归档设备':
      if (row['归档标记'] === '是') {
        return { ok: false, message: '设备已归档' }
      }
      updated = { ...row, 归档标记: '是' }
      recordEvent(deviceId, '设备归档', '设备归档，退出活动设备', activeBasis(updated))
      break
    case '取消归档':
      if (row['归档标记'] !== '是') {
        return { ok: false, message: '设备未归档' }
      }
      updated = { ...row, 归档标记: '否' }
      recordEvent(deviceId, '取消归档', '取消归档，重新计为活动设备', activeBasis(updated))
      break
    default:
      return { ok: false, message: `通讯设备没有登记「${action}」这个动作` }
  }

  const rows = listRows(COMMUNICATION_KEY)
  const index = rows.findIndex((item) => Number(item.id) === Number(row.id))
  const next = [...rows]
  next[index] = updated
  saveRows(COMMUNICATION_KEY, next)
  const active = isActiveDevice(updated)
  return {
    ok: true,
    message: `通讯设备已${action}，当前状态「${updated.status}」，${active ? '活动设备' : '非活动设备'}`,
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  if (key === COMMUNICATION_KEY) {
    const rows = listRows(COMMUNICATION_KEY)
    const row = rows.find((item) => Number(item.id) === id)
    if (!row) {
      return { ok: false, message: `没有找到编号为 ${id} 的通讯设备` }
    }
    return communicationAction(row, action)
  }
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  return genericUpdate(key, id, action, meta, target)
}

/** 协议迁移：迁移后设备仍归原站点；非活动设备拒绝 */
export function migrateProtocol(
  deviceId: string,
  target: { protocol: string; version: string },
  reason?: string,
): ActionResult {
  const rows = listRows(COMMUNICATION_KEY)
  const index = rows.findIndex((row) => String(row['设备编号']) === deviceId)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${deviceId} 的通讯设备` }
  }
  const result = migrateDeviceProtocol(rows[index], target, { reason })
  if (!result.row || !result.event) {
    return { ok: false, message: result.error ?? '协议迁移失败' }
  }
  const next = [...rows]
  next[index] = result.row
  saveRows(COMMUNICATION_KEY, next)
  recordEvent(
    deviceId,
    '协议迁移',
    result.event.detail,
    result.event.basis,
  )
  return { ok: true, message: `${deviceId} 已迁移到 ${target.protocol} ${target.version}，仍归原站点 ${rows[index]['所属站点']}` }
}

type FrameState = {
  seenIds: string[]
  pendingFrames: CommunicationFrame[]
  lastOutcomes: FrameOutcome[]
}

function readFrameState(): FrameState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { seenIds: [], pendingFrames: [], lastOutcomes: [] }
  }
  try {
    const raw = window.localStorage.getItem(FRAME_STATE_KEY)
    if (raw) {
      return JSON.parse(raw) as FrameState
    }
  } catch {
    // 状态损坏时从头处理
  }
  return { seenIds: [], pendingFrames: [], lastOutcomes: [] }
}

function writeFrameState(state: FrameState): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(FRAME_STATE_KEY, JSON.stringify(state))
  }
}

/**
 * 通讯帧批量上报：同一帧重复上报只更新一次；某类协议解析失败只隔离该设备，
 * 失败帧保存下来，可从该设备继续处理。
 */
export function ingestFrames(frames: CommunicationFrame[]): FrameBatchResult {
  const rows = listRows(COMMUNICATION_KEY)
  const state = readFrameState()
  const seen = new Set(state.seenIds)
  const result = processFrames(frames, rows, seen)

  // 更新落表前，按共用弱信号规则重算状态；归档 / 告警关闭设备不因此回到活动身份
  const normalizedUpdates = result.updates.map(({ index, row }) => {
    const existing = rows[index]
    if (!isActiveDevice(existing)) {
      return { index, row }
    }
    const judged = statusFromSignal(row)
    return {
      index,
      row: {
        ...row,
        status: judged.status,
        pending: judged.status !== '待更换',
        abnormal: judged.status !== '通讯正常',
      },
    }
  })
  saveRows(COMMUNICATION_KEY, applyUpdates(rows, normalizedUpdates))

  // 按设备写历史（一批一设备一条），信号判定依据来自共用规则
  for (const { row } of normalizedUpdates) {
    const deviceId = String(row['设备编号'])
    const judged = statusFromSignal(row)
    recordEvent(
      deviceId,
      '通讯帧上报',
      `帧上报更新：信号 ${row['信号强度']}dBm，最近通讯时刻 ${row['最近通讯时刻']}，状态「${judged.status}」`,
      `同一帧重复上报只更新一次；${judged.basis}`,
    )
  }

  writeFrameState({
    seenIds: [...seen],
    pendingFrames: result.pendingFrames,
    lastOutcomes: result.outcomes,
  })
  return result
}

/** 续处理上次失败的帧：成功设备命中幂等直接跳过，从失败设备继续 */
export function resumePendingFrames(): FrameBatchResult | null {
  const state = readFrameState()
  if (state.pendingFrames.length === 0) {
    return null
  }
  const result = ingestFrames(state.pendingFrames)
  return result
}

export function lastFrameOutcomes(): FrameOutcome[] {
  return readFrameState().lastOutcomes
}

export function pendingFrameCount(): number {
  return readFrameState().pendingFrames.length
}

/** 演示帧：覆盖正常更新、弱信号、同帧重复、协议解析失败、设备不存在五种情形 */
export function demoFrames(): CommunicationFrame[] {
  return [
    { frameId: 'F-1001', deviceId: 'COMM-0001', protocol: 'NB-IoT', version: 'R14', signalDbm: -88, observedAt: '2026-10-03T09:00:00' },
    { frameId: 'F-1002', deviceId: 'COMM-0002', protocol: '4G LTE', version: 'Cat.1 R13', signalDbm: -116, observedAt: '2026-10-03T09:01:00' },
    { frameId: 'F-1001', deviceId: 'COMM-0001', protocol: 'NB-IoT', version: 'R14', signalDbm: -88, observedAt: '2026-10-03T09:00:00' },
    { frameId: 'F-1003', deviceId: 'COMM-0006', protocol: 'LoRa私有', signalDbm: -99, observedAt: '2026-10-03T09:02:00', payload: 'garbage' },
    { frameId: 'F-1004', deviceId: 'COMM-9999', protocol: 'NB-IoT', signalDbm: -90, observedAt: '2026-10-03T09:03:00' },
  ]
}

export function resetFrameDemo(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(FRAME_STATE_KEY)
  }
}

export function deviceHistory(deviceId: string): DeviceHistoryEvent[] {
  return eventsOfDevice(deviceId)
}

export function resetCommunication(): PageResult {
  // 重置为种子后同样走存量规范化：回填协议版本、补历史基线
  const seeded = resetRows(COMMUNICATION_KEY)
  clearLedger()
  const { data } = normalizeCommunication({ communication: seeded })
  saveRows(COMMUNICATION_KEY, data.communication ?? seeded)
  resetFrameDemo()
  return listEntries(COMMUNICATION_KEY)
}

export function resetModule(key: string): PageResult {
  if (key === COMMUNICATION_KEY) {
    return resetCommunication()
  }
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
