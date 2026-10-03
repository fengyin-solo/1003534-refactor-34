<template>
  <section class="page" data-module="communication">
    <header class="page-head">
      <div>
        <h2>通讯系统管理</h2>
        <p class="page-desc">窄带/蜂窝协议的信号弱边界、告警关闭与归档活动项判定统一走共用规则；存量设备已按最近通讯时刻回填协议版本。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记通讯设备</button>
        <button class="btn" type="button" @click="runDemoFrames">模拟一帧批量上报</button>
        <button class="btn" type="button" :disabled="!hasPending" @click="resumeFrames">续处理失败帧 ({{ pendingCount }})</button>
        <button class="btn" type="button" @click="migrateOldDevice">迁移COMM-0003协议(留站)</button>
        <button class="btn ghost" type="button" @click="resetAll">重置演示数据</button>
        <button class="btn" type="button" @click="exportRows">导出通讯系统清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>信号判定</th>
          <th>活动项</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ formatCell(row, column) }}</td>
          <td>
            <span :class="weakClass(row)">{{ weakText(row) }}</span>
          </td>
          <td>
            <span :class="isActive(row) ? 'tag active' : 'tag inactive'">
              {{ isActive(row) ? '活动' : '非活动' }}
            </span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="selectDevice(row)">历史</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无通讯系统数据，可先登记通讯设备</td>
        </tr>
      </tbody>
    </table>

    <div v-if="outcomes.length" class="frame-panel">
      <h3>本帧处理结果（重复上报只更新一次，协议失败按设备隔离）</h3>
      <ul>
        <li v-for="(item, index) in outcomes" :key="index" :class="`frame-${item.status}`">
          [{{ item.status }}] {{ item.message }}
        </li>
      </ul>
    </div>

    <div v-if="selected" class="history-panel">
      <h3>{{ selected['设备编号'] }} 设备历史依据</h3>
      <p v-if="!history.length" class="empty-state">暂无历史记录</p>
      <ul v-else>
        <li v-for="event in history" :key="event.id">
          <strong>{{ event.time }} · {{ event.type }}</strong>：{{ event.detail }}
          <div class="history-basis">规则版本 {{ event.ruleVersion }}｜{{ event.basis }}</div>
        </li>
      </ul>
    </div>

    <InspectionTodoPanel />

    <footer class="page-foot">
      <span>共 {{ total }} 条通讯系统记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  deviceHistory,
  downloadEntries,
  demoFrames,
  ingestFrames,
  listEntries,
  migrateProtocol,
  moduleMeta,
  pendingFrameCount,
  resetCommunication,
  resetFrameDemo,
  resumePendingFrames,
  runAction as applyAction,
} from '@/api/local-service'
import { isActiveDevice, isWeakSignal, specOf } from '@/domain/protocol-rules'
import type { DeviceHistoryEvent } from '@/domain/device-ledger'
import type { FrameOutcome } from '@/domain/frame-ingest'
import type { EntryRow } from '@/data/types'
import InspectionTodoPanel from '@/components/InspectionTodoPanel.vue'

const meta = moduleMeta('communication')
const columns = ["设备编号", "设备类型", "所属站点", "通讯协议", "协议版本", "信号强度", "最近通讯时刻", "维护人员", "告警状态", "归档标记"]
const statuses = ["通讯正常", "信号弱", "通讯中断", "待更换"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const outcomes = ref<FrameOutcome[]>([])
const pendingCount = ref(0)
const selected = ref<EntryRow | null>(null)
const history = ref<DeviceHistoryEvent[]>([])

const stats = computed(() => {
  const active = rows.value.filter((row) => isActiveDevice(row))
  const weakCount = active.filter((row) => weakFlag(row) === true).length
  return [
    { label: '设备总数', value: rows.value.length },
    { label: '活动设备数', value: active.length },
    { label: '非活动设备数', value: rows.value.length - active.length },
    { label: '信号弱设备数', value: weakCount },
    { label: '中断设备数', value: active.filter((row) => String(row.status) === '通讯中断').length },
  ]
})

const hasPending = computed(() => pendingCount.value > 0)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function signalDbm(row: EntryRow): number | null {
  const value = Number(row['信号强度'])
  return Number.isFinite(value) ? value : null
}

function weakFlag(row: EntryRow): boolean | null {
  return isWeakSignal({
    protocol: String(row['通讯协议'] ?? ''),
    version: String(row['协议版本'] ?? ''),
    signalDbm: signalDbm(row),
  })
}

function isActive(row: EntryRow): boolean {
  return isActiveDevice(row)
}

function weakText(row: EntryRow): string {
  const weak = weakFlag(row)
  if (weak === null) {
    return '无法判定'
  }
  const spec = specOf(String(row['通讯协议']), String(row['协议版本']))
  return weak ? `信号弱(边界${spec?.weakThresholdDbm}dBm)` : '正常'
}

function weakClass(row: EntryRow): string {
  const weak = weakFlag(row)
  return weak === true ? 'tag weak' : weak === false ? 'tag ok' : 'tag unknown'
}

function formatCell(row: EntryRow, column: string): string | number {
  if (column === '信号强度') {
    const dbm = signalDbm(row)
    return dbm === null ? '—' : `${dbm} dBm`
  }
  if (column === '协议版本' && row[column] === '') {
    return '未回填'
  }
  const value = row[column]
  return value === undefined || value === '' ? '—' : String(value)
}

function actionsFor(row: EntryRow): string[] {
  const base = ["登记故障", "确认恢复", "申请更换"]
  const alarm = row['告警状态'] === '关闭' ? ["重开告警"] : ["关闭告警"]
  const archive = row['归档标记'] === '是' ? ["取消归档"] : ["归档设备"]
  return [...base, ...alarm, ...archive]
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '通讯设备登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
}

function runDemoFrames() {
  errorMessage.value = ''
  const result = ingestFrames(demoFrames())
  outcomes.value = result.outcomes
  pendingCount.value = result.pendingFrames.length
  reload()
}

function resumeFrames() {
  errorMessage.value = ''
  const result = resumePendingFrames()
  if (!result) {
    errorMessage.value = '没有待续处理的失败帧'
    return
  }
  outcomes.value = result.outcomes
  pendingCount.value = result.pendingFrames.length
  reload()
}

function migrateOldDevice() {
  errorMessage.value = ''
  const result = migrateProtocol('COMM-0003', { protocol: '4G LTE', version: 'Cat.1 Bis R16' }, '老旧GPRS模块升级，站点归属保持不变')
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
}

function selectDevice(row: EntryRow) {
  selected.value = row
  history.value = deviceHistory(String(row['设备编号']))
}

function resetAll() {
  resetCommunication()
  resetFrameDemo()
  outcomes.value = []
  pendingCount.value = 0
  selected.value = null
  history.value = []
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    if (selected.value) {
      const fresh = rows.value.find((row) => row['设备编号'] === selected.value?.['设备编号'])
      selected.value = fresh ?? null
      history.value = fresh ? deviceHistory(String(fresh['设备编号'])) : []
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '通讯系统列表读取失败'
  }
}

onMounted(() => {
  pendingCount.value = pendingFrameCount()
  reload()
})
</script>

<style scoped>
.tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 12px;
}
.tag.weak,
.tag.active {
  background: #fde2e2;
  color: #ab091e;
}
.tag.ok {
  background: #def7ec;
  color: #03543f;
}
.tag.inactive {
  background: #e4e7eb;
  color: #627d98;
}
.tag.unknown {
  background: #fef3c7;
  color: #92400e;
}
.frame-panel,
.history-panel {
  margin-top: 20px;
  padding: 16px;
  border: 1px solid #d9e2ec;
  border-radius: 8px;
  background: #f8fafc;
}
.frame-panel h3,
.history-panel h3 {
  margin: 0 0 8px;
  font-size: 15px;
}
.frame-panel ul,
.history-panel ul {
  margin: 0;
  padding-left: 18px;
}
.frame-updated {
  color: #03543f;
}
.frame-duplicate {
  color: #627d98;
}
.frame-failed {
  color: #ab091e;
}
.history-basis {
  font-size: 12px;
  color: #486581;
  margin: 2px 0 8px;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
