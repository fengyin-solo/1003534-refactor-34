/**
 * 通讯协议共用规则：窄带 / 蜂窝两族协议的「信号弱边界」「告警关闭」「归档结果」三处判断
 * 统一收口在这里，通讯设备页、通讯帧上报解析、站房巡检待办等入口一律复用，禁止各写一套。
 *
 * 历史依据：每次规则版本（PROTOCOL_RULE_VERSION）变更都应在协议台账上留痕，
 * 设备历史（device-ledger）里的每条判定都记录 ruleVersion 与 basis，事后可复核。
 */
import type { EntryRow } from '@/data/types'

/** 当前共用规则版本，写入设备历史依据，规则调整时升版 */
export const PROTOCOL_RULE_VERSION = 'protocol-rules/v1'

export type ProtocolFamily = 'narrowband' | 'cellular'

/** 协议版本台账：同族协议按启用时间排成时间线，存量设备的协议版本据此回填 */
export type ProtocolSpec = {
  /** 协议取值，与设备记录「通讯协议」字段一致 */
  protocol: string
  family: ProtocolFamily
  /** 协议版本，回填或帧上报时写入设备记录「协议版本」字段 */
  version: string
  /** 该版本启用时间（ISO），最近通讯早于此时间的设备不能回填成该版本 */
  activeFrom: string
  /**
   * 信号弱边界（dBm，信号 <= 该值即判弱）。
   * 窄带按 RSSI 口径、蜂窝按 RSRP 口径，阈值各算各的，但只准在这一张台账里定义。
   */
  weakThresholdDbm: number
}

/**
 * 协议台账（唯一事实来源）。
 * 窄带：NB-IoT 各版本，RSSI 弱信号边界 -110dBm。
 * 蜂窝：GPRS / 4G LTE（含 Cat.1、Cat.1 Bis）/ 5G NR，RSRP 弱信号边界按版本定义。
 */
export const PROTOCOL_SPECS: ProtocolSpec[] = [
  { protocol: 'GPRS', family: 'cellular', version: 'R99', activeFrom: '2000-01-01T00:00:00', weakThresholdDbm: -100 },
  { protocol: '4G LTE', family: 'cellular', version: 'R10', activeFrom: '2011-03-25T00:00:00', weakThresholdDbm: -105 },
  { protocol: '4G LTE', family: 'cellular', version: 'Cat.1 R13', activeFrom: '2016-06-15T00:00:00', weakThresholdDbm: -105 },
  { protocol: 'NB-IoT', family: 'narrowband', version: 'R13', activeFrom: '2016-06-15T00:00:00', weakThresholdDbm: -110 },
  { protocol: '5G NR', family: 'cellular', version: 'R15', activeFrom: '2018-06-14T00:00:00', weakThresholdDbm: -108 },
  { protocol: 'NB-IoT', family: 'narrowband', version: 'R14', activeFrom: '2017-09-15T00:00:00', weakThresholdDbm: -110 },
  { protocol: '4G LTE', family: 'cellular', version: 'Cat.1 Bis R16', activeFrom: '2020-07-03T00:00:00', weakThresholdDbm: -105 },
  { protocol: 'NB-IoT', family: 'narrowband', version: 'R16', activeFrom: '2020-07-03T00:00:00', weakThresholdDbm: -110 },
]

const FAMILY_LABEL: Record<ProtocolFamily, string> = {
  narrowband: '窄带',
  cellular: '蜂窝',
}

export function familyLabel(family: ProtocolFamily): string {
  return FAMILY_LABEL[family]
}

/** 按协议名查族；未知协议返回 null（调用方必须按「无法判定」处理，不能猜一个阈值） */
export function protocolFamilyOf(protocol: string): ProtocolFamily | null {
  return PROTOCOL_SPECS.find((spec) => spec.protocol === protocol)?.family ?? null
}

/** 按协议名 + 版本取台账条目；版本缺省时取该协议最新版本 */
export function specOf(protocol: string, version?: string): ProtocolSpec | null {
  const candidates = PROTOCOL_SPECS.filter((spec) => spec.protocol === protocol)
  if (candidates.length === 0) {
    return null
  }
  const matched = version ? candidates.find((spec) => spec.version === version) : undefined
  return (
    matched ??
    [...candidates].sort((a, b) => Date.parse(b.activeFrom) - Date.parse(a.activeFrom))[0]
  )
}

/**
 * 共用判断 1：信号弱边界。
 * 窄带、蜂窝的阈值在台账里各算各的，这里只做统一取值与比较，任何入口不得再自定阈值。
 * 返回 null 表示协议未知 / 信号非数值，无法判定。
 */
export function isWeakSignal(input: {
  protocol: string
  version?: string
  signalDbm: number | null | undefined
}): boolean | null {
  const spec = specOf(input.protocol, input.version)
  if (!spec) {
    return null
  }
  if (input.signalDbm === null || input.signalDbm === undefined || !Number.isFinite(input.signalDbm)) {
    return null
  }
  return input.signalDbm <= spec.weakThresholdDbm
}

/** 信号判定的可读依据，写入设备历史，保证「为什么判弱」可复核 */
export function weakSignalBasis(input: {
  protocol: string
  version?: string
  signalDbm: number | null | undefined
}): string {
  const spec = specOf(input.protocol, input.version)
  const signal = input.signalDbm
  if (!spec) {
    return `协议「${input.protocol}」未登记，信号弱边界无台账可查，不作判定`
  }
  if (signal === null || signal === undefined || !Number.isFinite(signal)) {
    return `信号强度缺失，无法对照${familyLabel(spec.family)}阈值 ${spec.weakThresholdDbm}dBm`
  }
  const metric = spec.family === 'narrowband' ? 'RSSI' : 'RSRP'
  const weak = signal <= spec.weakThresholdDbm
  return `${spec.protocol} ${spec.version} 属${familyLabel(spec.family)}，${metric}=${signal}dBm，` +
    `共用弱信号边界 ${spec.weakThresholdDbm}dBm：${weak ? '已越界，判信号弱' : '未越界'}`
}

/** 共用判断 2/3：活动项。告警关闭与设备归档过去各写一套，且旧协议设备链路一恢复就被
 *  无条件当成活动项；现在统一为：归档或告警关闭任一成立即非活动，恢复链路不解除这两个标记。 */
export function isActiveDevice(row: Pick<EntryRow, string> | Record<string, unknown>): boolean {
  return row['归档标记'] !== '是' && row['告警状态'] !== '关闭'
}

export function activeBasis(row: Record<string, unknown>): string {
  if (row['归档标记'] === '是') {
    return '活动项判定：归档标记=是，告警关闭/归档共用规则判为非活动（恢复链路不解除归档）'
  }
  if (row['告警状态'] === '关闭') {
    return '活动项判定：告警状态=关闭，告警关闭/归档共用规则判为非活动（恢复链路不重开告警）'
  }
  return '活动项判定：归档标记≠是 且 告警状态≠关闭，判为活动设备'
}

/** 按最近通讯时刻回填协议版本：取启用时间不晚于该时刻的最新版本；没有匹配版本返回 null */
export function resolveVersionAt(protocol: string, observedAt: string): ProtocolSpec | null {
  const at = Date.parse(observedAt)
  if (Number.isNaN(at)) {
    return null
  }
  return (
    PROTOCOL_SPECS.filter(
      (spec) => spec.protocol === protocol && Date.parse(spec.activeFrom) <= at,
    ).sort((a, b) => Date.parse(b.activeFrom) - Date.parse(a.activeFrom))[0] ?? null
  )
}

export function versionBackfillBasis(protocol: string, observedAt: string, version: string): string {
  return `按最近通讯时刻 ${observedAt} 匹配协议时间线，回填 ${protocol} ${version}（仅取启用时间不晚于该时刻的版本）`
}
