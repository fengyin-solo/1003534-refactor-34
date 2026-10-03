/**
 * 通讯帧批量上报处理（纯规则层，不落盘）：
 * - 同一帧重复上报只更新一次：按「设备编号 + 帧序号」幂等，已处理帧直接跳过；
 * - 某类协议解析失败不影响其他设备：每帧独立 try/catch，失败只登记错误并继续后面的设备；
 * - 可从该设备继续处理：失败帧不会被标记为已处理，带着同一批帧重试时，成功设备命中幂等
 *   直接跳过，解析从失败设备继续，不会重复更新。
 */
import { specOf } from './protocol-rules'
import type { EntryRow } from '@/data/types'

export type CommunicationFrame = {
  /** 帧序号：同一设备同一帧序号视为重复上报 */
  frameId: string
  deviceId: string
  protocol: string
  version?: string
  signalDbm: number
  observedAt: string
  /** 载荷字符串；无法解析的协议帧会在这里触发解析失败 */
  payload?: string
}

export type FrameParseError =
  | 'UNKNOWN_PROTOCOL'
  | 'MALFORMED_PAYLOAD'
  | 'DEVICE_NOT_FOUND'
  | 'OBSOLETE_FRAME'

export type FrameOutcome = {
  frame: CommunicationFrame
  status: 'updated' | 'duplicate' | 'skipped' | 'failed'
  error?: FrameParseError
  message: string
}

export type FrameBatchResult = {
  outcomes: FrameOutcome[]
  /** 本次实际更新到设备表上的行（索引），由调用方负责持久化 */
  updates: { index: number; row: EntryRow }[]
  /** 未处理成功的帧：调用方保存下来，修复后可直接续处理 */
  pendingFrames: CommunicationFrame[]
  updatedCount: number
  duplicateCount: number
  failedCount: number
}

/** 各协议解析器注册：某类协议解析失败只抛错，由批处理隔离，不影响其他协议的设备 */
export type ProtocolParser = (frame: CommunicationFrame) => { signalDbm: number; observedAt: string }

const DEFAULT_PARSER: ProtocolParser = (frame) => {
  // 载荷若提供，约定形如 "signal=-112;at=2026-10-03T09:00:00"；解析不出即判定该帧损坏
  if (frame.payload !== undefined && frame.payload !== '') {
    const signal = /(?:^|;)signal=(-?\d+)(?:;|$)/.exec(frame.payload)
    const at = /(?:^|;)at=([^;]+)(?:;|$)/.exec(frame.payload)
    if (!signal || !at || Number.isNaN(Number(signal[1]))) {
      throw new Error('MALFORMED_PAYLOAD')
    }
    return { signalDbm: Number(signal[1]), observedAt: at[1] }
  }
  if (!Number.isFinite(frame.signalDbm) || Number.isNaN(Date.parse(frame.observedAt))) {
    throw new Error('MALFORMED_PAYLOAD')
  }
  return { signalDbm: frame.signalDbm, observedAt: frame.observedAt }
}

const parsers = new Map<string, ProtocolParser>()

/** 可按协议注册专用解析器；未注册的协议走默认解析 */
export function registerParser(protocol: string, parser: ProtocolParser): void {
  parsers.set(protocol, parser)
}

export function parserOf(protocol: string): ProtocolParser {
  return parsers.get(protocol) ?? DEFAULT_PARSER
}

/**
 * 批量处理一帧（或续处理一批）。
 * @param seenFrameIds 已处理成功的「设备编号+帧序号」集合，调用方持久化后回传
 * @param now 便于测试注入当前时间
 */
export function processFrames(
  frames: CommunicationFrame[],
  rows: EntryRow[],
  seenFrameIds: Set<string>,
  now: string = new Date().toISOString(),
): FrameBatchResult {
  const outcomes: FrameOutcome[] = []
  const updates: FrameBatchResult['updates'] = []
  const pendingFrames: CommunicationFrame[] = []

  for (const frame of frames) {
    const dedupeKey = `${frame.deviceId}#${frame.frameId}`

    // 同一帧重复上报只更新一次：历史上成功过，或本批已处理过，都直接跳过
    if (seenFrameIds.has(dedupeKey)) {
      outcomes.push({ frame, status: 'duplicate', message: `帧 ${frame.frameId} 已处理过，重复上报只更新一次` })
      continue
    }

    const index = rows.findIndex((row) => String(row['设备编号']) === frame.deviceId)
    if (index < 0) {
      outcomes.push({ frame, status: 'failed', error: 'DEVICE_NOT_FOUND', message: `设备 ${frame.deviceId} 不存在` })
      pendingFrames.push(frame)
      continue
    }

    let parsed: { signalDbm: number; observedAt: string }
    try {
      // 协议未登记或某类协议解析器抛错，都在本帧边界内兜住，后面的设备继续处理
      if (!specOf(frame.protocol, frame.version)) {
        throw new Error('UNKNOWN_PROTOCOL')
      }
      parsed = parserOf(frame.protocol)(frame)
    } catch (error) {
      const errorCode: FrameParseError =
        error instanceof Error && error.message === 'UNKNOWN_PROTOCOL'
          ? 'UNKNOWN_PROTOCOL'
          : 'MALFORMED_PAYLOAD'
      outcomes.push({
        frame,
        status: 'failed',
        error: errorCode,
        message:
          errorCode === 'UNKNOWN_PROTOCOL'
            ? `设备 ${frame.deviceId} 的协议「${frame.protocol}」无法识别，该帧隔离失败，不影响其他设备`
            : `设备 ${frame.deviceId} 的「${frame.protocol}」协议帧解析失败，已隔离，可从该设备继续处理`,
      })
      pendingFrames.push(frame)
      continue
    }

    // 同一批内同一设备的多帧：后帧在最新行上合并，设备只落一次更新
    const current = updates.find((item) => item.index === index)?.row ?? rows[index]
    const updated: EntryRow = {
      ...current,
      通讯协议: frame.protocol,
      ...(frame.version ? { 协议版本: frame.version } : {}),
      信号强度: parsed.signalDbm,
      最近通讯时刻: parsed.observedAt,
    }
    const existing = updates.find((item) => item.index === index)
    if (existing) {
      existing.row = updated
    } else {
      updates.push({ index, row: updated })
    }

    // 标记本帧已处理，同批后续重复帧直接走 duplicate 分支
    seenFrameIds.add(dedupeKey)
    outcomes.push({
      frame,
      status: 'updated',
      message: `设备 ${frame.deviceId} 帧 ${frame.frameId} 已更新（信号 ${parsed.signalDbm}dBm，${parsed.observedAt}）`,
    })
  }

  // 更新数量按设备计：同设备多帧（非同帧重复）只算一次落表更新
  const updatedCount = updates.length
  return {
    outcomes,
    updates,
    pendingFrames,
    updatedCount,
    duplicateCount: outcomes.filter((item) => item.status === 'duplicate').length,
    failedCount: outcomes.filter((item) => item.status === 'failed').length,
  }
}

/** 把处理结果里的更新合并回设备表 */
export function applyUpdates(rows: EntryRow[], updates: FrameBatchResult['updates']): EntryRow[] {
  const next = [...rows]
  for (const { index, row } of updates) {
    next[index] = row
  }
  return next
}

export function frameDedupeKey(frame: CommunicationFrame): string {
  return `${frame.deviceId}#${frame.frameId}`
}
