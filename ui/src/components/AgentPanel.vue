<script setup lang="ts">
import { ref, computed } from 'vue';
import { useAgentsStore } from '../stores/agents';

const emit = defineEmits<{
  (e: 'sendMessage', content: string): void;
}>();

const agentsStore = useAgentsStore();

const message = ref('');
const agent = computed(() => agentsStore.currentAgent);
const connected = computed(() => agentsStore.connected);

function sendMessage() {
  if (!message.value.trim()) return;
  emit('sendMessage', message.value.trim());
  message.value = '';
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'idle':
      return '#6b7280';
    case 'inferring':
      return '#10b981';
    case 'waiting_for_tools':
      return '#f59e0b';
    case 'ready':
      return '#3b82f6';
    default:
      return '#6b7280';
  }
}
</script>

<template>
  <div class="agent-panel">
    <div class="panel-header">
      <h3>Agent</h3>
      <div class="connection-status" :class="{ connected }">
        {{ connected ? 'Connected' : 'Disconnected' }}
      </div>
    </div>

    <div class="agent-info" v-if="agent">
      <div class="agent-name">{{ agent.name }}</div>
      <div class="agent-status">
        <span class="status-dot" :style="{ backgroundColor: getStatusColor(agent.status) }"></span>
        {{ agent.status }}
      </div>
      <div class="agent-model">{{ agent.model }}</div>
    </div>

    <div class="message-input">
      <textarea
        v-model="message"
        placeholder="Type a message..."
        @keydown.enter.exact.prevent="sendMessage"
        :disabled="!connected"
      ></textarea>
      <button @click="sendMessage" :disabled="!connected || !message.trim()">
        Send
      </button>
    </div>
  </div>
</template>

<style scoped>
.agent-panel {
  background: #1e1e1e;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
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

.connection-status {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: #991b1b;
  color: #fecaca;
}

.connection-status.connected {
  background: #166534;
  color: #bbf7d0;
}

.agent-info {
  padding: 16px;
  border-bottom: 1px solid #333;
}

.agent-name {
  font-size: 16px;
  font-weight: 600;
  color: #e0e0e0;
  margin-bottom: 8px;
}

.agent-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #a0a0a0;
  margin-bottom: 4px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.agent-model {
  font-size: 12px;
  color: #666;
  font-family: monospace;
}

.message-input {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.message-input textarea {
  width: 100%;
  min-height: 80px;
  padding: 12px;
  background: #252525;
  border: 1px solid #333;
  border-radius: 6px;
  color: #e0e0e0;
  font-size: 14px;
  resize: vertical;
}

.message-input textarea:focus {
  outline: none;
  border-color: #3b82f6;
}

.message-input textarea:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.message-input button {
  padding: 10px 20px;
  background: #3b82f6;
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}

.message-input button:hover:not(:disabled) {
  background: #2563eb;
}

.message-input button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
