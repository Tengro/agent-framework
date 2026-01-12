import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { AgentInfo, BranchInfo } from '../api/types';

export const useAgentsStore = defineStore('agents', () => {
  // State
  const agents = ref<AgentInfo[]>([]);
  const branches = ref<BranchInfo[]>([]);
  const currentBranch = ref<string>('main');
  const connected = ref(false);

  // Getters
  const currentAgent = computed(() => agents.value[0]);

  const activeAgents = computed(() =>
    agents.value.filter((a) => a.status !== 'idle')
  );

  // Actions
  function setAgents(newAgents: AgentInfo[]) {
    agents.value = newAgents;
  }

  function updateAgentStatus(name: string, status: AgentInfo['status']) {
    const agent = agents.value.find((a) => a.name === name);
    if (agent) {
      agent.status = status;
    }
  }

  function setBranches(newBranches: BranchInfo[]) {
    branches.value = newBranches;
  }

  function setCurrentBranch(branch: string) {
    currentBranch.value = branch;
    // Update isCurrent flag
    for (const b of branches.value) {
      b.isCurrent = b.name === branch;
    }
  }

  function setConnected(isConnected: boolean) {
    connected.value = isConnected;
  }

  return {
    // State
    agents,
    branches,
    currentBranch,
    connected,
    // Getters
    currentAgent,
    activeAgents,
    // Actions
    setAgents,
    updateAgentStatus,
    setBranches,
    setCurrentBranch,
    setConnected,
  };
});
