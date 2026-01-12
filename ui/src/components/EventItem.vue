<script setup lang="ts">
import { ref, computed } from 'vue';
import { useEventsStore } from '../stores/events';
import type { PersistedEvent } from '../api/types';

const props = defineProps<{
  event: PersistedEvent;
}>();

const eventsStore = useEventsStore();
const expanded = ref(false);

const color = computed(() => eventsStore.getEventColor(props.event.type));

const typeLabel = computed(() => {
  const parts = props.event.type.split(':');
  return parts.length > 1 ? parts[1] : parts[0];
});

const typePrefix = computed(() => {
  const parts = props.event.type.split(':');
  return parts.length > 1 ? parts[0] : '';
});

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}
</script>

<template>
  <div class="event-item" @click="expanded = !expanded">
    <div class="event-header">
      <div class="event-indicator" :style="{ backgroundColor: color }"></div>
      <div class="event-type">
        <span class="type-prefix" v-if="typePrefix">{{ typePrefix }}:</span>
        <span class="type-label">{{ typeLabel }}</span>
      </div>
      <div class="event-time">{{ formatTime(event.timestamp) }}</div>
    </div>

    <div class="event-meta" v-if="event.source || event.agentName">
      <span v-if="event.source" class="meta-item">
        <span class="meta-label">src:</span> {{ event.source }}
      </span>
      <span v-if="event.agentName" class="meta-item">
        <span class="meta-label">agent:</span> {{ event.agentName }}
      </span>
    </div>

    <div v-if="expanded" class="event-payload">
      <pre>{{ formatPayload(event.payload) }}</pre>
    </div>
  </div>
</template>

<style scoped>
.event-item {
  background: #252525;
  border-radius: 6px;
  margin-bottom: 4px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.event-item:hover {
  background: #2a2a2a;
}

.event-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.event-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.event-type {
  flex: 1;
  font-size: 13px;
  font-family: monospace;
}

.type-prefix {
  color: #888;
}

.type-label {
  color: #e0e0e0;
  font-weight: 500;
}

.event-time {
  font-size: 11px;
  color: #666;
  font-family: monospace;
}

.event-meta {
  margin-top: 4px;
  padding-left: 16px;
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.meta-item {
  font-size: 11px;
  color: #888;
}

.meta-label {
  color: #666;
}

.event-payload {
  margin-top: 8px;
  padding: 8px;
  background: #1a1a1a;
  border-radius: 4px;
  overflow-x: auto;
}

.event-payload pre {
  margin: 0;
  font-size: 11px;
  color: #a0a0a0;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
