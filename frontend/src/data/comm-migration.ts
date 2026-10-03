import { appendCommHistory, nowText } from './comm-history'
import { backfillProtocolVersion } from './comm-rules'
import type { EntryRow } from './types'

// 存量通讯设备迁移：按最近通讯时刻回填协议版本。
// 只补「协议版本」一个字段，所属站点等原有字段原样保留；已回填过的设备跳过，重复执行安全。

export const COMM_SCHEMA_VERSION = 2

export function migrateCommDevices(
  rows: EntryRow[],
  at: string = nowText(),
): { rows: EntryRow[]; changed: number } {
  let changed = 0
  const migrated = rows.map((row) => {
    if (row['协议版本']) {
      return row
    }
    const { version, basis } = backfillProtocolVersion(row['最近通讯时刻'])
    changed += 1
    appendCommHistory(String(row['设备编号']), {
      时刻: at,
      结论: `迁移回填协议版本=${version}`,
      依据: [basis, `所属站点保持「${String(row['所属站点'] ?? '')}」不变`],
    })
    return { ...row, 协议版本: version }
  })
  return { rows: migrated, changed }
}
