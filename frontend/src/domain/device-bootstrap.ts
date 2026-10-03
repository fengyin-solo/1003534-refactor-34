/**
 * 存量通讯设备引导：
 * - 识别旧版本地数据（占位样例），迁移为可判定的真实形态；
 * - 存量设备按「最近通讯时刻」回填协议版本（只取启用时间不晚于该时刻的最新版本）；
 * - 迁移协议后设备仍归原站点；
 * - 回填 / 归档 / 告警关闭等历史依据写入设备历史台账。
 */
import {
  PROTOCOL_RULE_VERSION,
  isWeakSignal,
  resolveVersionAt,
  versionBackfillBasis,
  weakSignalBasis,
} from './protocol-rules'
import { hasDeviceEvent, seedDeviceEvents } from './device-ledger'
import type { EntryRow } from '@/data/types'

const NOW = '2026-10-03T00:00:00'

/** 旧版本地数据特征：信号强度不是数值（占位样例里存的是「通讯系统样例N」） */
export function isLegacyCommunicationRows(rows: EntryRow[]): boolean {
  if (rows.length === 0) {
    return false
  }
  return rows.some((row) => row['信号强度'] !== undefined && !Number.isFinite(Number(row['信号强度'])))
}

function ensureFlags(row: EntryRow): EntryRow {
  return {
    ...row,
    告警状态: row['告警状态'] === '关闭' ? '关闭' : '开启',
    归档标记: row['归档标记'] === '是' ? '是' : '否',
    协议版本: row['协议版本'] ?? '',
  }
}

/**
 * 按最近通讯时刻回填协议版本。返回回填后的行（原行已带版本则保留）。
 * 回填事件通过 events 收集，由调用方一次性写入台账，避免重复落盘。
 */
export function backfillProtocolVersions(
  rows: EntryRow[],
): { rows: EntryRow[]; events: { deviceId: string; time: string; detail: string; basis: string }[] } {
  const events: { deviceId: string; detail: string; basis: string; time: string }[] = []
  const next = rows.map((row) => {
    const withFlags = ensureFlags(row)
    const protocol = String(withFlags['通讯协议'] ?? '')
    const observedAt = String(withFlags['最近通讯时刻'] ?? '')
    if (String(withFlags['协议版本'] ?? '') !== '') {
      return withFlags
    }
    const spec = resolveVersionAt(protocol, observedAt)
    if (!spec) {
      return withFlags
    }
    events.push({
      deviceId: String(withFlags['设备编号']),
      time: NOW,
      detail: `协议版本回填：${protocol} → ${spec.version}`,
      basis: versionBackfillBasis(protocol, observedAt, spec.version),
    })
    return { ...withFlags, 协议版本: spec.version }
  })
  return { rows: next, events }
}

/**
 * 迁移设备协议：协议与版本切到目标，但设备仍归原站点（所属站点不变），
 * 原站点记入历史依据。归档 / 告警关闭设备不参与链路活动，直接拒绝。
 */
export function migrateDeviceProtocol(
  row: EntryRow,
  target: { protocol: string; version: string },
  options: { time?: string; reason?: string } = {},
): { row: EntryRow | null; event?: { deviceId: string; time: string; detail: string; basis: string }; error?: string } {
  if (row['归档标记'] === '是' || row['告警状态'] === '关闭') {
    return { row: null, error: '设备已归档或告警已关闭，属非活动设备，不进行协议迁移' }
  }
  const time = options.time ?? NOW
  const originStation = String(row['所属站点'] ?? '')
  const from = `${row['通讯协议']} ${row['协议版本'] ?? ''}`.trim()
  const updated: EntryRow = {
    ...row,
    通讯协议: target.protocol,
    协议版本: target.version,
  }
  const weak = isWeakSignal({
    protocol: target.protocol,
    version: target.version,
    signalDbm: Number(row['信号强度']),
  })
  return {
    row: updated,
    event: {
      deviceId: String(row['设备编号']),
      time,
      detail: `协议迁移：${from} → ${target.protocol} ${target.version}`,
      basis:
        `迁移后设备仍归原站点 ${originStation}（所属站点不变）` +
        (options.reason ? `；迁移原因：${options.reason}` : '') +
        `；按共用规则复核：${weakSignalBasis({
          protocol: target.protocol,
          version: target.version,
          signalDbm: Number(row['信号强度']),
        })}`,
    },
  }
}

/** 初始台账：为种子设备写归档 / 告警关闭基线，保证存量设备历史可追溯 */
export function seedCommunicationBaseline(rows: EntryRow[]): void {
  const baseline: Parameters<typeof seedDeviceEvents>[0] = []
  for (const row of rows) {
    const deviceId = String(row['设备编号'])
    if (row['归档标记'] === '是' && !hasDeviceEvent(deviceId, '设备归档')) {
      baseline.push({
        deviceId,
        time: '2026-09-01T00:00:00',
        type: '设备归档',
        detail: '存量设备归档（旧协议终端下线归档）',
        ruleVersion: PROTOCOL_RULE_VERSION,
        basis: '活动项判定：归档标记=是，告警关闭/归档共用规则判为非活动；旧协议链路恢复也不重新计为活动项',
      })
    }
    if (row['告警状态'] === '关闭' && !hasDeviceEvent(deviceId, '告警关闭')) {
      baseline.push({
        deviceId,
        time: '2026-09-01T00:00:00',
        type: '告警关闭',
        detail: '存量设备告警关闭',
        ruleVersion: PROTOCOL_RULE_VERSION,
        basis: '活动项判定：告警状态=关闭，告警关闭/归档共用规则判为非活动；确认恢复不重开告警',
      })
    }
  }
  if (baseline.length > 0) {
    seedDeviceEvents(baseline)
  }
}
