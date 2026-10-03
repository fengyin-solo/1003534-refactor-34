import { appendCommHistory, commHistoryOf, nowText } from '@/data/comm-history'
import { judgeCommDevice } from '@/data/comm-rules'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 通讯系统的共用判定、帧上报与判定历史，页面统一从这里拿，不直接碰 data 层。
export { commHistoryOf, judgeCommDevice }
export type { CommJudgment } from '@/data/comm-rules'
export type { JudgmentRecord } from '@/data/comm-history'
export { failedCommFrames, ingestCommFrames, resumeCommIngest, sampleCommFrames } from './comm-ingest'
export type { CommFrame, FailedFrame, IngestReport } from './comm-ingest'

// 站房巡检待办：直接复用通讯设备的共用判定，告警未关闭且未归档的设备才进待办。
export type CommInspectionTodo = {
  设备编号: string
  所属站点: string
  通讯协议: string
  协议版本: string
  信号强度: string
  现状: string
  依据: string[]
}

export function commInspectionTodos(): CommInspectionTodo[] {
  return listRows('communication')
    .map((row) => ({ row, judgment: judgeCommDevice(row) }))
    .filter(({ judgment }) => judgment.active)
    .map(({ row, judgment }) => ({
      设备编号: String(row['设备编号'] ?? ''),
      所属站点: String(row['所属站点'] ?? ''),
      通讯协议: String(row['通讯协议'] ?? ''),
      协议版本: String(row['协议版本'] ?? ''),
      信号强度: row['信号强度'] === '' ? '缺失' : `${String(row['信号强度'])}dBm`,
      现状: String(row.status),
      依据: judgment.basis,
    }))
}

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

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

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
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
  if (key === 'communication') {
    // 人工流转同样走共用判定留痕，历史依据不断档。
    appendCommHistory(String(updated['设备编号']), {
      时刻: nowText(),
      结论: `人工${action}：状态→「${target}」`,
      依据: judgeCommDevice(updated).basis,
    })
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
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
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
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
