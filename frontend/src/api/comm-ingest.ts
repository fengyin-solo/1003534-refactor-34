import { appendCommHistory, nowText } from '@/data/comm-history'
import {
  SIGNAL_RANGE_DBM,
  isWeakSignal,
  judgeCommDevice,
  protocolKindOf,
  protocolKindOfText,
} from '@/data/comm-rules'
import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 通讯帧上报处理：同一帧重复上报只更新一次；某类协议解析失败只隔离该帧，
// 不影响其他设备，失败帧留档后可从该设备继续处理。

const FRAME_STORE_KEY = 'hydrology-monitor-station:comm-frames'
const MAX_PROCESSED_FRAMES = 500

export type CommFrame = {
  frameId: string
  设备编号: string
  协议?: string
  信号强度?: number
  上报时刻?: string
}

export type FailedFrame = {
  frame: CommFrame
  reason: string
  failedAt: string
}

export type IngestReport = {
  applied: number
  duplicated: number
  failed: FailedFrame[]
  resumed: boolean
}

type FrameStore = {
  processed: string[]
  failed: FailedFrame[]
}

function readFrameStore(): FrameStore {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { processed: [], failed: [] }
  }
  const raw = window.localStorage.getItem(FRAME_STORE_KEY)
  if (!raw) {
    return { processed: [], failed: [] }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<FrameStore>
    return { processed: parsed.processed ?? [], failed: parsed.failed ?? [] }
  } catch {
    return { processed: [], failed: [] }
  }
}

function writeFrameStore(store: FrameStore): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(FRAME_STORE_KEY, JSON.stringify(store))
  }
}

export function failedCommFrames(): FailedFrame[] {
  return readFrameStore().failed
}

type ParsedFrame = {
  kind: '窄带' | '蜂窝'
  dbm: number
  at: string
}

// 按协议解析帧：协议未登记、信号缺失或超出该协议量程都算这一帧解析失败。
function parseFrame(frame: CommFrame, device: EntryRow): ParsedFrame {
  const kind = frame.协议 ? protocolKindOfText(frame.协议) : protocolKindOf(device)
  if (!kind) {
    throw new Error(`未登记的通讯协议「${frame.协议 ?? '空'}」，无法解析`)
  }
  const dbm = Number(frame.信号强度)
  if (frame.信号强度 === undefined || Number.isNaN(dbm)) {
    throw new Error(`${kind}帧缺少有效信号强度`)
  }
  const [min, max] = SIGNAL_RANGE_DBM[kind]
  if (dbm < min || dbm > max) {
    throw new Error(`${kind}帧信号强度${dbm}dBm超出量程[${min},${max}]`)
  }
  return { kind, dbm, at: frame.上报时刻 ?? nowText() }
}

// 帧落到设备上：更新信号与最近通讯时刻，再用共用规则重判状态并留痕。
// 收到帧即证明链路已通，通讯中断随之解除；待更换是人工终态，帧不翻案。
function applyFrame(row: EntryRow, parsed: ParsedFrame, frameId: string): EntryRow {
  const next: EntryRow = { ...row, 信号强度: parsed.dbm, 最近通讯时刻: parsed.at }
  if (next.status !== '待更换') {
    next.status = isWeakSignal(parsed.kind, parsed.dbm) ? '信号弱' : '通讯正常'
  }
  next.abnormal = next.status === '信号弱' || next.status === '通讯中断'
  next.pending = next.status !== '待更换'
  const judgment = judgeCommDevice(next)
  appendCommHistory(String(next['设备编号']), {
    时刻: parsed.at,
    结论: `帧${frameId}应用：状态→「${String(next.status)}」`,
    依据: judgment.basis,
  })
  return next
}

export function ingestCommFrames(frames: CommFrame[]): IngestReport {
  const store = readFrameStore()
  const rows = listRows('communication')
  const failed: FailedFrame[] = []
  let applied = 0
  let duplicated = 0

  for (const frame of frames) {
    if (store.processed.includes(frame.frameId)) {
      duplicated += 1
      continue
    }
    const index = rows.findIndex((row) => String(row['设备编号']) === frame.设备编号)
    try {
      if (index < 0) {
        throw new Error(`设备${frame.设备编号}未登记`)
      }
      const parsed = parseFrame(frame, rows[index])
      rows[index] = applyFrame(rows[index], parsed, frame.frameId)
      store.processed.push(frame.frameId)
      applied += 1
    } catch (error) {
      // 单帧失败只进失败清单，其余设备照常处理。
      failed.push({
        frame,
        reason: error instanceof Error ? error.message : '帧解析失败',
        failedAt: nowText(),
      })
    }
  }

  store.processed = store.processed.slice(-MAX_PROCESSED_FRAMES)
  // 同一帧反复失败只留一条最新记录，失败清单不膨胀。
  const failedIds = new Set(failed.map((item) => item.frame.frameId))
  store.failed = [...store.failed.filter((item) => !failedIds.has(item.frame.frameId)), ...failed]
  writeFrameStore(store)
  saveRows('communication', rows)
  return { applied, duplicated, failed, resumed: false }
}

// 从失败设备继续处理：把留档的失败帧按原顺序重投，仍失败的重新留档。
export function resumeCommIngest(): IngestReport {
  const store = readFrameStore()
  const pending = store.failed
  if (pending.length === 0) {
    return { applied: 0, duplicated: 0, failed: [], resumed: true }
  }
  store.failed = []
  writeFrameStore(store)
  const report = ingestCommFrames(pending.map((item) => item.frame))
  return { ...report, resumed: true }
}

// 演示用的一批上报帧：正常帧、旧协议恢复帧、重复帧、未登记协议的坏帧、中断恢复帧。
export function sampleCommFrames(): CommFrame[] {
  const rows = listRows('communication')
  const at = nowText()
  const nonce = Date.now()
  const deviceNo = (index: number) => String(rows[index]?.['设备编号'] ?? `COMM-000${index + 1}`)
  const first: CommFrame = {
    frameId: `F${nonce}-1`,
    设备编号: deviceNo(0),
    协议: '蜂窝',
    信号强度: -75,
    上报时刻: at,
  }
  return [
    first,
    { frameId: `F${nonce}-2`, 设备编号: deviceNo(1), 协议: '窄带', 信号强度: -88, 上报时刻: at },
    { ...first },
    { frameId: `F${nonce}-4`, 设备编号: deviceNo(2), 协议: '卫星', 信号强度: -90, 上报时刻: at },
    { frameId: `F${nonce}-5`, 设备编号: deviceNo(2), 协议: '窄带', 信号强度: -98, 上报时刻: at },
  ]
}
