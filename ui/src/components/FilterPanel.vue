<script setup lang="ts">
import { computed } from 'vue';
import { useEventsStore } from '../stores/events';

const eventsStore = useEventsStore();

const filters = computed(() => eventsStore.filters);

function toggleFilter(id: string) {
  eventsStore.toggleFilter(id);
}
</script>

<template>
  <div class="filter-panel">
    <div class="panel-header">
      <h3>Filters</h3>
    </div>

    <div class="filter-list">
      <label
        v-for="filter in filters"
        :key="filter.id"
        class="filter-item"
        :class="{ enabled: filter.enabled }"
      >
        <input
          type="checkbox"
          :checked="filter.enabled"
          @change="toggleFilter(filter.id)"
        />
        <span class="filter-color" :style="{ backgroundColor: filter.color }"></span>
        <span class="filter-label">{{ filter.label }}</span>
        <span class="filter-pattern">{{ filter.pattern }}</span>
      </label>
    </div>
  </div>
</template>

<style scoped>
.filter-panel {
  background: #1e1e1e;
  border-radius: 8px;
  overflow: hidden;
}

.panel-header {
  padding: 12px 16px;
  background: #252525;
  border-bottom: 1px solid #333;
}

.panel-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: #e0e0e0;
}

.filter-list {
  padding: 8px;
}

.filter-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
}

.filter-item:hover {
  background: #252525;
}

.filter-item.enabled {
  background: #252525;
}

.filter-item input[type="checkbox"] {
  width: 14px;
  height: 14px;
  cursor: pointer;
}

.filter-color {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.filter-label {
  flex: 1;
  font-size: 13px;
  color: #e0e0e0;
}

.filter-pattern {
  font-size: 11px;
  color: #666;
  font-family: monospace;
}
</style>
