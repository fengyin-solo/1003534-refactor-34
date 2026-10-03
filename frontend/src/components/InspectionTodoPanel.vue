<template>
  <section class="todo-panel">
    <header class="todo-head">
      <h3>站房巡检待办</h3>
      <span class="todo-count">共 {{ todos.length }} 项 · 协议判定共用 protocol-rules</span>
    </header>
    <p v-if="!todos.length" class="empty-state">暂无因通讯问题产生的巡检待办</p>
    <table v-else class="data-table">
      <thead>
        <tr>
          <th>设备编号</th>
          <th>所属站点</th>
          <th>通讯协议</th>
          <th>信号(dBm)</th>
          <th>待办原因</th>
          <th>判定依据</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="todo in todos" :key="todo.deviceId">
          <td>{{ todo.deviceId }}</td>
          <td>{{ todo.stationId }}</td>
          <td>{{ todo.protocol }} {{ todo.version }}</td>
          <td>{{ todo.signalDbm ?? '—' }}</td>
          <td>{{ todo.reasons.join('、') }}</td>
          <td class="todo-basis">
            <span v-for="(line, i) in todo.basis" :key="i">{{ line }}</span>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'

import { listRows } from '@/data/local-store'
import { buildInspectionTodos } from '@/domain/inspection-todos'
import type { InspectionTodo } from '@/domain/inspection-todos'

const props = defineProps<{ stationId?: string }>()

// 其它入口（站房维护、巡检记录）直接复用：活动项、信号弱边界全部走共用规则
const todos = computed<InspectionTodo[]>(() => {
  const all = buildInspectionTodos(listRows('communication'))
  return props.stationId ? all.filter((todo) => todo.stationId === props.stationId) : all
})
</script>

<style scoped>
.todo-panel {
  margin-top: 24px;
  padding: 16px;
  border: 1px solid #d9e2ec;
  border-radius: 8px;
  background: #f8fafc;
}
.todo-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
}
.todo-head h3 {
  margin: 0;
  font-size: 16px;
}
.todo-count {
  font-size: 12px;
  color: #627d98;
}
.todo-basis {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #486581;
}
</style>
