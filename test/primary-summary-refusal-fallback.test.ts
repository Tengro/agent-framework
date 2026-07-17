import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedRequest, NormalizedResponse, YieldingStream } from '@animalabs/membrane';
import type { PrimarySummaryIdentity, PrimarySummaryProjection } from '@animalabs/context-manager';
import type { Module } from '../src/index.js';

import { AgentFramework } from '../src/index.js';
import { MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

const FALLBACK_STATE_ID = 'framework/primary-summary-fallback';

afterEach(() => {
  // Individual tests clean their own tempdirs; this hook exists so a failed
  // assertion does not leave the last path behind if cleanup was skipped.
});

function identity(id: string): PrimarySummaryIdentity {
  return {
    id,
    contentHash: `content-${id}`,
    carrierHash: `carrier-${id}`,
    sourceLeafHash: `leaf-${id}`,
  };
}

function projection(branchId: string, generation: number, ids: string[]): PrimarySummaryProjection {
  return {
    namespace: 'default',
    branch: { id: branchId, name: 'main', generation },
    selectedSummaries: ids.map((id, index) => ({
      identity: identity(id),
      level: 1,
      orderedSourceIds: [`src-${id}-1`, `src-${id}-2`],
      renderedAs: 'summary_pair' as const,
      pairRange: { start: index * 2, end: index * 2 + 1 },
    })),
  };
}

function request(system: string, text: string): NormalizedRequest {
  return {
    system,
    messages: [{ participant: 'user', content: [{ type: 'text', text }] }],
    config: { model: 'test-model', maxTokens: 256 },
    assistantParticipant: 'assistant',
    promptCaching: true,
    cacheTtl: '1h',
  };
}

function artifacts(systemTag: string, summaryIds: string[], branchId = 'branch-a', generation = 1) {
  return {
    compileResult: {
      messages: [
        { participant: 'Context Manager', content: [{ type: 'text', text: 'What do you remember from earlier?' }] },
        { participant: 'assistant', content: [{ type: 'text', text: `summary ${summaryIds.join(',')}` }] },
        { participant: 'user', content: [{ type: 'text', text: 'latest input' }] },
      ],
      systemInjections: [],
      primarySummaryProjection: projection(branchId, generation, summaryIds),
    },
    contract: {
      systemHash: `system-${systemTag}`,
      modelConfigHash: `model-${systemTag}`,
      toolContractHash: `tools-${systemTag}`,
    },
  };
}

function refusalResponse(content: ContentBlock[] = []): NormalizedResponse {
  return {
    ...createMockResponse(content, 'refusal'),
    content,
    stopReason: 'refusal',
    rawAssistantText: '',
    toolCalls: [],
    usage: { inputTokens: 40, outputTokens: 0 },
    details: {
      usage: { inputTokens: 40, outputTokens: 0 },
      stop: { reason: 'refusal', wasTruncated: false },
    },
    raw: {
      response: {
        stop_details: { category: 'reasoning_extraction' },
      },
    },
  } as unknown as NormalizedResponse;
}

function toolUseBlock(id = 'tool-1', message = 'hello'): ContentBlock {
  return {
    type: 'tool_use',
    id,
    name: 'echo',
    input: { message },
  } as ContentBlock;
}

class ScriptedMembrane {
  readonly calls: NormalizedRequest[] = [];

  constructor(private readonly responsesByCall: Array<NormalizedResponse[] | YieldingStream>) {}

  complete(): Promise<NormalizedResponse> {
    throw new Error('complete() should not be used by the primary streaming fallback path');
  }

  streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(structuredClone(request));
    const next = this.responsesByCall.shift();
    if (!next) return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'default' }])]);
    return Array.isArray(next) ? new MockYieldingStream(next) : next;
  }

  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}

class LazyStream implements YieldingStream {
  started = false;
  onStart?: () => void;
  readonly isWaitingForTools = false;
  readonly pendingToolCallIds: string[] = [];
  readonly toolDepth = 0;

  provideToolResults(): void {
    throw new Error('LazyStream does not support tool rounds');
  }

  cancel(): void {
    this.started = true;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<import('@animalabs/membrane').StreamEvent> {
    this.onStart?.();
    this.started = true;
    yield { type: 'complete', response: createMockResponse([], 'refusal') } as import('@animalabs/membrane').StreamEvent;
  }
}

async function createFramework(
  mem: ScriptedMembrane,
  refusalHandling?: Record<string, unknown>,
  modules: Module[] = [],
) {
  const dir = mkdtempSync(join(tmpdir(), 'af-primary-summary-fallback-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'),
    membrane: mem.asMembrane(),
    agents: [{
      name: 'assistant',
      model: 'test-model',
      systemPrompt: 'system',
      refusalHandling,
    }],
    modules,
  });
  const agent = framework.getAgent('assistant')!;
  return { dir, framework, agent };
}

function branchInfo(id = 'branch-a', generation = 1) {
  return {
    id,
    name: 'main',
    head: 1,
    generation,
    created: new Date('2026-07-17T00:00:00.000Z'),
  };
}

function fallbackState(framework: AgentFramework): { requests: Array<Record<string, unknown>> } {
  const raw = framework.getStore().getStateJson(FALLBACK_STATE_ID);
  return raw && typeof raw === 'object'
    ? raw as { requests: Array<Record<string, unknown>> }
    : { requests: [] };
}

async function persistHealthyBaseline(
  framework: AgentFramework,
  agent: ReturnType<AgentFramework['getAgent']>,
  baselineRequest: NormalizedRequest,
  baselineArtifacts: ReturnType<typeof artifacts>,
) {
  const build = (framework as unknown as {
    buildPrimarySummaryRequestRecord: (...args: unknown[]) => Record<string, unknown>;
  }).buildPrimarySummaryRequestRecord.bind(framework);
  const persist = (framework as unknown as {
    persistPrimarySummaryRequestRecord: (record: Record<string, unknown>) => Promise<void>;
  }).persistPrimarySummaryRequestRecord.bind(framework);
  const record = build(
    agent,
    'baseline-request',
    'primary',
    baselineRequest,
    baselineArtifacts,
    branchInfo(baselineArtifacts.compileResult.primarySummaryProjection!.branch.id, baselineArtifacts.compileResult.primarySummaryProjection!.branch.generation),
    'end_turn',
    true,
    0,
    30,
    'success',
  );
  await persist(record);
}

async function waitForStream(framework: AgentFramework, agentName: string): Promise<void> {
  const handle = (framework as unknown as {
    activeStreams: Map<string, Promise<void>>;
  }).activeStreams.get(agentName);
  if (handle) await handle;
}

describe('primary summary refusal fallback', () => {
  it('feature disabled preserves the existing one-call refusal path', async () => {
    const membrane = new ScriptedMembrane([[refusalResponse()]]);
    const { dir, framework, agent } = await createFramework(membrane);
    try {
      const preparedRequest = request('system', 'hello');
      const preparedArtifacts = artifacts('disabled', ['L1-1']);
      (agent as unknown as {
        prepareActivationRequest: () => Promise<{ request: NormalizedRequest; artifacts: ReturnType<typeof artifacts> }>;
        getCurrentBranchGeneration: () => ReturnType<typeof branchInfo>;
      }).prepareActivationRequest = async () => ({ request: preparedRequest, artifacts: preparedArtifacts });
      (agent as unknown as { getCurrentBranchGeneration: () => ReturnType<typeof branchInfo> }).getCurrentBranchGeneration =
        () => branchInfo();

      await (framework as unknown as {
        startAgentStream: (agent: object, trigger: Record<string, unknown>) => Promise<void>;
      }).startAgentStream(agent, {
        agentName: 'assistant',
        reason: 'test',
        source: 'test',
        timestamp: Date.now(),
      });
      await waitForStream(framework, 'assistant');

      assert.equal(membrane.calls.length, 1);
      assert.equal((framework as unknown as { pendingRequests: unknown[] }).pendingRequests.length, 0);
      assert.deepEqual(fallbackState(framework).requests, []);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('zero-output refusal with one newly admitted summary triggers exactly one expanded retry', async () => {
    const membrane = new ScriptedMembrane([
      [refusalResponse()],
      [[createMockResponse([{ type: 'text', text: 'Recovered' }])][0]],
    ]);
    const { dir, framework, agent } = await createFramework(membrane, {
      primarySummaryFallback: { enabled: true, maxNewSummaries: 4, requestBudgetTokens: 4096 },
    });
    try {
      const baselineRequest = request('system', 'baseline');
      const baselineArtifacts = artifacts('shared', ['L1-1']);
      await persistHealthyBaseline(framework, agent, baselineRequest, baselineArtifacts);

      const currentRequest = request('system', 'latest input');
      const currentArtifacts = artifacts('shared', ['L1-1', 'L1-2']);
      const retryRequest = request('system', 'expanded raw source');
      const retryArtifacts = {
        ...currentArtifacts,
        compileResult: {
          ...currentArtifacts.compileResult,
          primarySummaryProjection: {
            ...currentArtifacts.compileResult.primarySummaryProjection!,
            selectedSummaries: currentArtifacts.compileResult.primarySummaryProjection!.selectedSummaries.map((selection) => ({
              ...selection,
              renderedAs: selection.identity.id === 'L1-2' ? 'raw_expansion' as const : selection.renderedAs,
            })),
          },
        },
      };

      const quarantineCalls: Array<ReadonlyArray<PrimarySummaryIdentity>> = [];
      (agent as unknown as {
        prepareActivationRequest: () => Promise<{ request: NormalizedRequest; artifacts: typeof currentArtifacts }>;
        buildPrimarySummaryRawExpansionRequest: (
          artifacts: typeof currentArtifacts,
          summaries: ReadonlyArray<PrimarySummaryIdentity>,
        ) => { request: NormalizedRequest; artifacts: typeof retryArtifacts };
        getCurrentBranchGeneration: () => ReturnType<typeof branchInfo>;
      }).prepareActivationRequest = async () => ({ request: currentRequest, artifacts: currentArtifacts });
      (agent as unknown as {
        buildPrimarySummaryRawExpansionRequest: (
          artifacts: typeof currentArtifacts,
          summaries: ReadonlyArray<PrimarySummaryIdentity>,
        ) => { request: NormalizedRequest; artifacts: typeof retryArtifacts };
      }).buildPrimarySummaryRawExpansionRequest = (_artifacts, summaries) => {
        assert.deepEqual(summaries.map((summary) => summary.id), ['L1-2']);
        return { request: retryRequest, artifacts: retryArtifacts };
      };
      (agent as unknown as { getCurrentBranchGeneration: () => ReturnType<typeof branchInfo> }).getCurrentBranchGeneration =
        () => branchInfo();
      const cm = agent.getContextManager() as unknown as {
        quarantinePrimarySummaryForPrimaryLane: (
          contract: Record<string, unknown>,
          summaries: ReadonlyArray<PrimarySummaryIdentity>,
        ) => Promise<void>;
      };
      cm.quarantinePrimarySummaryForPrimaryLane = async (_contract, summaries) => {
        quarantineCalls.push(summaries);
      };

      const start = (framework as unknown as {
        startAgentStream: (agent: object, trigger: Record<string, unknown>) => Promise<void>;
        pendingRequests: Array<Record<string, unknown>>;
      }).startAgentStream.bind(framework);
      const trigger = {
        agentName: 'assistant',
        reason: 'test',
        source: 'test',
        timestamp: Date.now(),
      };
      await start(agent, trigger);
      await waitForStream(framework, 'assistant');

      const queuedRetry = (framework as unknown as { pendingRequests: Array<Record<string, unknown>> }).pendingRequests.shift();
      assert.ok(queuedRetry, 'a single fallback retry should be queued');
      assert.equal(membrane.calls.length, 1);

      await start(agent, queuedRetry!);
      await waitForStream(framework, 'assistant');

      assert.equal(membrane.calls.length, 2);
      assert.equal(membrane.calls[1]!.messages[0]!.content[0]!.type, 'text');
      assert.equal((membrane.calls[1]!.messages[0]!.content[0] as { text: string }).text, 'expanded raw source');
      assert.equal(quarantineCalls.length, 1);

      const records = fallbackState(framework).requests;
      const original = records.find((record) => record.requestId !== 'baseline-request')!;
      assert.equal(original.fallbackStatus, 'success');
      assert.equal(records.filter((record) => record.dispatchKind === 'primary_summary_fallback_retry').length, 1);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('holds instead of retrying when no compatible healthy baseline exists', async () => {
    const membrane = new ScriptedMembrane([[refusalResponse()]]);
    const { dir, framework, agent } = await createFramework(membrane, {
      primarySummaryFallback: { enabled: true, maxNewSummaries: 4, requestBudgetTokens: 4096 },
    });
    try {
      const currentRequest = request('system', 'latest input');
      const currentArtifacts = artifacts('shared', ['L1-1']);
      (agent as unknown as {
        prepareActivationRequest: () => Promise<{ request: NormalizedRequest; artifacts: typeof currentArtifacts }>;
        getCurrentBranchGeneration: () => ReturnType<typeof branchInfo>;
      }).prepareActivationRequest = async () => ({ request: currentRequest, artifacts: currentArtifacts });
      (agent as unknown as { getCurrentBranchGeneration: () => ReturnType<typeof branchInfo> }).getCurrentBranchGeneration =
        () => branchInfo();

      await (framework as unknown as {
        startAgentStream: (agent: object, trigger: Record<string, unknown>) => Promise<void>;
      }).startAgentStream(agent, {
        agentName: 'assistant',
        reason: 'test',
        source: 'test',
        timestamp: Date.now(),
      });
      await waitForStream(framework, 'assistant');

      assert.equal(membrane.calls.length, 1);
      assert.equal((framework as unknown as { pendingRequests: unknown[] }).pendingRequests.length, 0);
      const held = fallbackState(framework).requests[0]!;
      assert.equal(held.finalStatus, 'held');
      assert.equal(held.fallbackHeldReason, 'primary_summary_refusal_no_compatible_healthy_baseline');
      assert.deepEqual(
        framework.healthSnapshot().primarySummaryFallback,
        { requests: 1, pendingDispatches: 0, unresolvedIntents: 0, held: 1 },
      );
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('holds instead of retrying when no newly admitted summaries exist', async () => {
    const membrane = new ScriptedMembrane([[refusalResponse()]]);
    const { dir, framework, agent } = await createFramework(membrane, {
      primarySummaryFallback: { enabled: true, maxNewSummaries: 4, requestBudgetTokens: 4096 },
    });
    try {
      const baselineRequest = request('system', 'baseline');
      const baselineArtifacts = artifacts('shared', ['L1-1']);
      await persistHealthyBaseline(framework, agent, baselineRequest, baselineArtifacts);
      const currentRequest = request('system', 'latest input');
      const currentArtifacts = artifacts('shared', ['L1-1']);
      (agent as unknown as {
        prepareActivationRequest: () => Promise<{ request: NormalizedRequest; artifacts: typeof currentArtifacts }>;
        getCurrentBranchGeneration: () => ReturnType<typeof branchInfo>;
      }).prepareActivationRequest = async () => ({ request: currentRequest, artifacts: currentArtifacts });
      (agent as unknown as { getCurrentBranchGeneration: () => ReturnType<typeof branchInfo> }).getCurrentBranchGeneration =
        () => branchInfo();

      await (framework as unknown as {
        startAgentStream: (agent: object, trigger: Record<string, unknown>) => Promise<void>;
      }).startAgentStream(agent, {
        agentName: 'assistant',
        reason: 'test',
        source: 'test',
        timestamp: Date.now(),
      });
      await waitForStream(framework, 'assistant');

      const record = fallbackState(framework).requests.find((entry) => entry.requestId !== 'baseline-request')!;
      assert.equal(record.finalStatus, 'held');
      assert.equal(record.fallbackHeldReason, 'primary_summary_refusal_no_newly_admitted_candidates');
      assert.equal((framework as unknown as { pendingRequests: unknown[] }).pendingRequests.length, 0);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('holds instead of retrying when newly admitted summaries exceed the configured maximum', async () => {
    const membrane = new ScriptedMembrane([[refusalResponse()]]);
    const { dir, framework, agent } = await createFramework(membrane, {
      primarySummaryFallback: { enabled: true, maxNewSummaries: 1, requestBudgetTokens: 4096 },
    });
    try {
      const baselineRequest = request('system', 'baseline');
      const baselineArtifacts = artifacts('shared', ['L1-1']);
      await persistHealthyBaseline(framework, agent, baselineRequest, baselineArtifacts);
      const currentRequest = request('system', 'latest input');
      const currentArtifacts = artifacts('shared', ['L1-1', 'L1-2', 'L1-3']);
      (agent as unknown as {
        prepareActivationRequest: () => Promise<{ request: NormalizedRequest; artifacts: typeof currentArtifacts }>;
        getCurrentBranchGeneration: () => ReturnType<typeof branchInfo>;
      }).prepareActivationRequest = async () => ({ request: currentRequest, artifacts: currentArtifacts });
      (agent as unknown as { getCurrentBranchGeneration: () => ReturnType<typeof branchInfo> }).getCurrentBranchGeneration =
        () => branchInfo();

      await (framework as unknown as {
        startAgentStream: (agent: object, trigger: Record<string, unknown>) => Promise<void>;
      }).startAgentStream(agent, {
        agentName: 'assistant',
        reason: 'test',
        source: 'test',
        timestamp: Date.now(),
      });
      await waitForStream(framework, 'assistant');

      const record = fallbackState(framework).requests.find((entry) => entry.requestId !== 'baseline-request')!;
      assert.equal(record.finalStatus, 'held');
      assert.equal(record.fallbackHeldReason, 'primary_summary_refusal_too_many_candidates');
      assert.equal((framework as unknown as { pendingRequests: unknown[] }).pendingRequests.length, 0);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('holds instead of retrying for partial text output', async () => {
    const membrane = new ScriptedMembrane([[refusalResponse([{ type: 'text', text: 'partial' }])]]);
    const { dir, framework, agent } = await createFramework(membrane, {
      primarySummaryFallback: { enabled: true, maxNewSummaries: 4, requestBudgetTokens: 4096 },
    });
    try {
      const baselineRequest = request('system', 'baseline');
      const baselineArtifacts = artifacts('shared', ['L1-1']);
      await persistHealthyBaseline(framework, agent, baselineRequest, baselineArtifacts);
      const currentRequest = request('system', 'latest input');
      currentRequest.tools = [{
        name: 'echo-module--echo',
        description: 'Echoes the input',
        inputSchema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
          },
          required: ['message'],
        },
      }];
      const currentArtifacts = artifacts('shared', ['L1-1', 'L1-2']);
      (agent as unknown as {
        prepareActivationRequest: () => Promise<{ request: NormalizedRequest; artifacts: typeof currentArtifacts }>;
        getCurrentBranchGeneration: () => ReturnType<typeof branchInfo>;
      }).prepareActivationRequest = async () => ({ request: currentRequest, artifacts: currentArtifacts });
      (agent as unknown as { getCurrentBranchGeneration: () => ReturnType<typeof branchInfo> }).getCurrentBranchGeneration =
        () => branchInfo();

      await (framework as unknown as {
        startAgentStream: (agent: object, trigger: Record<string, unknown>) => Promise<void>;
      }).startAgentStream(agent, {
        agentName: 'assistant',
        reason: 'test',
        source: 'test',
        timestamp: Date.now(),
      });
      await waitForStream(framework, 'assistant');

      const record = fallbackState(framework).requests.find((entry) => entry.requestId !== 'baseline-request')!;
      assert.equal(record.finalStatus, 'held');
      assert.equal(record.fallbackHeldReason, 'primary_summary_refusal_partial_output');
      assert.equal((framework as unknown as { pendingRequests: unknown[] }).pendingRequests.length, 0);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('holds instead of retrying for refusal content that includes a tool block', async () => {
    const membrane = new ScriptedMembrane([[refusalResponse([toolUseBlock('tool-partial', 'partial tool')])]]);
    const { dir, framework, agent } = await createFramework(membrane, {
      primarySummaryFallback: { enabled: true, maxNewSummaries: 4, requestBudgetTokens: 4096 },
    });
    try {
      const baselineRequest = request('system', 'baseline');
      const baselineArtifacts = artifacts('shared', ['L1-1']);
      await persistHealthyBaseline(framework, agent, baselineRequest, baselineArtifacts);
      const currentRequest = request('system', 'latest input');
      const currentArtifacts = artifacts('shared', ['L1-1', 'L1-2']);
      (agent as unknown as {
        prepareActivationRequest: () => Promise<{ request: NormalizedRequest; artifacts: typeof currentArtifacts }>;
        getCurrentBranchGeneration: () => ReturnType<typeof branchInfo>;
      }).prepareActivationRequest = async () => ({ request: currentRequest, artifacts: currentArtifacts });
      (agent as unknown as { getCurrentBranchGeneration: () => ReturnType<typeof branchInfo> }).getCurrentBranchGeneration =
        () => branchInfo();

      await (framework as unknown as {
        startAgentStream: (agent: object, trigger: Record<string, unknown>) => Promise<void>;
      }).startAgentStream(agent, {
        agentName: 'assistant',
        reason: 'test',
        source: 'test',
        timestamp: Date.now(),
      });
      await waitForStream(framework, 'assistant');

      const record = fallbackState(framework).requests.find((entry) => entry.requestId !== 'baseline-request')!;
      assert.equal(record.finalStatus, 'held');
      assert.equal(record.fallbackHeldReason, 'primary_summary_refusal_partial_output');
      assert.equal((framework as unknown as { pendingRequests: unknown[] }).pendingRequests.length, 0);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats same generation on a different branch id as incompatible', async () => {
    const membrane = new ScriptedMembrane([[refusalResponse()]]);
    const { dir, framework, agent } = await createFramework(membrane, {
      primarySummaryFallback: { enabled: true, maxNewSummaries: 4, requestBudgetTokens: 4096 },
    });
    try {
      const baselineRequest = request('system', 'baseline');
      const baselineArtifacts = artifacts('shared', ['L1-1'], 'branch-b');
      await persistHealthyBaseline(framework, agent, baselineRequest, baselineArtifacts);
      const currentRequest = request('system', 'latest input');
      const currentArtifacts = artifacts('shared', ['L1-1', 'L1-2'], 'branch-a');
      (agent as unknown as {
        prepareActivationRequest: () => Promise<{ request: NormalizedRequest; artifacts: typeof currentArtifacts }>;
        getCurrentBranchGeneration: () => ReturnType<typeof branchInfo>;
      }).prepareActivationRequest = async () => ({ request: currentRequest, artifacts: currentArtifacts });
      (agent as unknown as { getCurrentBranchGeneration: () => ReturnType<typeof branchInfo> }).getCurrentBranchGeneration =
        () => branchInfo('branch-a');

      await (framework as unknown as {
        startAgentStream: (agent: object, trigger: Record<string, unknown>) => Promise<void>;
      }).startAgentStream(agent, {
        agentName: 'assistant',
        reason: 'test',
        source: 'test',
        timestamp: Date.now(),
      });
      await waitForStream(framework, 'assistant');

      const record = fallbackState(framework).requests.find((entry) => entry.requestId !== 'baseline-request')!;
      assert.equal(record.finalStatus, 'held');
      assert.equal(record.fallbackHeldReason, 'primary_summary_refusal_no_compatible_healthy_baseline');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats system or tool contract changes as incompatible', async () => {
    const membrane = new ScriptedMembrane([[refusalResponse()]]);
    const { dir, framework, agent } = await createFramework(membrane, {
      primarySummaryFallback: { enabled: true, maxNewSummaries: 4, requestBudgetTokens: 4096 },
    });
    try {
      const baselineRequest = request('system', 'baseline');
      const baselineArtifacts = artifacts('shared', ['L1-1']);
      await persistHealthyBaseline(framework, agent, baselineRequest, baselineArtifacts);
      const currentRequest = request('system', 'latest input');
      currentRequest.tools = [{
        name: 'echo',
        description: 'Echoes',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
      }];
      const currentArtifacts = artifacts('changed', ['L1-1', 'L1-2']);
      (agent as unknown as {
        prepareActivationRequest: () => Promise<{ request: NormalizedRequest; artifacts: typeof currentArtifacts }>;
        getCurrentBranchGeneration: () => ReturnType<typeof branchInfo>;
      }).prepareActivationRequest = async () => ({ request: currentRequest, artifacts: currentArtifacts });
      (agent as unknown as { getCurrentBranchGeneration: () => ReturnType<typeof branchInfo> }).getCurrentBranchGeneration =
        () => branchInfo();

      await (framework as unknown as {
        startAgentStream: (agent: object, trigger: Record<string, unknown>) => Promise<void>;
      }).startAgentStream(agent, {
        agentName: 'assistant',
        reason: 'test',
        source: 'test',
        timestamp: Date.now(),
      });
      await waitForStream(framework, 'assistant');

      const record = fallbackState(framework).requests.find((entry) => entry.requestId !== 'baseline-request')!;
      assert.equal(record.finalStatus, 'held');
      assert.equal(record.fallbackHeldReason, 'primary_summary_refusal_no_compatible_healthy_baseline');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('holds instead of dispatching an over-budget expanded retry', async () => {
    const membrane = new ScriptedMembrane([[refusalResponse()]]);
    const { dir, framework, agent } = await createFramework(membrane, {
      primarySummaryFallback: { enabled: true, maxNewSummaries: 4, requestBudgetTokens: 64 },
    });
    try {
      const baselineRequest = request('system', 'baseline');
      const baselineArtifacts = artifacts('shared', ['L1-1']);
      await persistHealthyBaseline(framework, agent, baselineRequest, baselineArtifacts);
      const currentRequest = request('system', 'latest input');
      const currentArtifacts = artifacts('shared', ['L1-1', 'L1-2']);
      const retryRequest = request('system', 'expanded raw source '.repeat(200));
      (agent as unknown as {
        prepareActivationRequest: () => Promise<{ request: NormalizedRequest; artifacts: typeof currentArtifacts }>;
        buildPrimarySummaryRawExpansionRequest: (
          artifacts: typeof currentArtifacts,
          summaries: ReadonlyArray<PrimarySummaryIdentity>,
        ) => { request: NormalizedRequest; artifacts: typeof currentArtifacts };
        getCurrentBranchGeneration: () => ReturnType<typeof branchInfo>;
      }).prepareActivationRequest = async () => ({ request: currentRequest, artifacts: currentArtifacts });
      (agent as unknown as {
        buildPrimarySummaryRawExpansionRequest: (
          artifacts: typeof currentArtifacts,
          summaries: ReadonlyArray<PrimarySummaryIdentity>,
        ) => { request: NormalizedRequest; artifacts: typeof currentArtifacts };
      }).buildPrimarySummaryRawExpansionRequest = () => ({ request: retryRequest, artifacts: currentArtifacts });
      (agent as unknown as { getCurrentBranchGeneration: () => ReturnType<typeof branchInfo> }).getCurrentBranchGeneration =
        () => branchInfo();

      await (framework as unknown as {
        startAgentStream: (agent: object, trigger: Record<string, unknown>) => Promise<void>;
      }).startAgentStream(agent, {
        agentName: 'assistant',
        reason: 'test',
        source: 'test',
        timestamp: Date.now(),
      });
      await waitForStream(framework, 'assistant');

      assert.equal(membrane.calls.length, 1);
      const record = fallbackState(framework).requests.find((entry) => entry.requestId !== 'baseline-request')!;
      assert.equal(record.finalStatus, 'held');
      assert.equal(record.fallbackHeldReason, 'primary_summary_refusal_retry_over_budget');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restart reconciliation holds unresolved pending intents instead of retrying', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-primary-summary-fallback-restart-'));
    const storePath = join(dir, 'store.chronicle');
    const firstMembrane = new ScriptedMembrane([]);
    const first = await AgentFramework.create({
      storePath,
      membrane: firstMembrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'system' }],
      modules: [],
    });
    try {
      first.getStore().setStateJson(FALLBACK_STATE_ID, {
        requests: [{
          requestId: 'stuck-request',
          agentName: 'assistant',
          namespace: 'default',
          timestamp: Date.now(),
          dispatchKind: 'primary',
          branch: { id: 'branch-a', name: 'main', generation: 1 },
          projection: projection('branch-a', 1, ['L1-1']),
          requestInputBoundTokens: 100,
          requestCompleteBoundTokens: 356,
          providerInputTokens: 40,
          systemHash: 'system-shared',
          modelConfigHash: 'model-shared',
          toolContractHash: 'tools-shared',
          stopReason: 'refusal',
          visibleAssistantOutput: false,
          executedToolCalls: 0,
          finalStatus: 'refusal',
          fallbackIntent: {
            intentId: 'intent-1',
            createdAt: Date.now(),
            baselineRequestId: 'baseline-request',
            candidateSummaries: [identity('L1-2')],
            retryRequestHash: 'retry-hash',
            retryCompleteBoundTokens: 512,
            requestBudgetTokens: 4096,
          },
          fallbackStatus: 'pending',
        }],
      });
    } finally {
      await first.stop();
    }

    const secondMembrane = new ScriptedMembrane([]);
    const second = await AgentFramework.create({
      storePath,
      membrane: secondMembrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'system' }],
      modules: [],
    });
    try {
      const record = fallbackState(second).requests[0]!;
      assert.equal(record.fallbackStatus, 'held');
      assert.equal(record.fallbackHeldReason, 'primary_summary_fallback_unresolved_on_restart');
      assert.equal(secondMembrane.calls.length, 0);
    } finally {
      await second.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('holds after a fallback retry refuses and never dispatches a second retry', async () => {
    const membrane = new ScriptedMembrane([
      [refusalResponse()],
      [refusalResponse()],
    ]);
    const { dir, framework, agent } = await createFramework(membrane, {
      primarySummaryFallback: { enabled: true, maxNewSummaries: 4, requestBudgetTokens: 4096 },
    });
    try {
      const baselineRequest = request('system', 'baseline');
      const baselineArtifacts = artifacts('shared', ['L1-1']);
      await persistHealthyBaseline(framework, agent, baselineRequest, baselineArtifacts);

      const currentRequest = request('system', 'latest input');
      const currentArtifacts = artifacts('shared', ['L1-1', 'L1-2']);
      const retryRequest = request('system', 'expanded raw source');
      (agent as unknown as {
        prepareActivationRequest: () => Promise<{ request: NormalizedRequest; artifacts: typeof currentArtifacts }>;
        buildPrimarySummaryRawExpansionRequest: (
          artifacts: typeof currentArtifacts,
          summaries: ReadonlyArray<PrimarySummaryIdentity>,
        ) => { request: NormalizedRequest; artifacts: typeof currentArtifacts };
        getCurrentBranchGeneration: () => ReturnType<typeof branchInfo>;
      }).prepareActivationRequest = async () => ({ request: currentRequest, artifacts: currentArtifacts });
      (agent as unknown as {
        buildPrimarySummaryRawExpansionRequest: (
          artifacts: typeof currentArtifacts,
          summaries: ReadonlyArray<PrimarySummaryIdentity>,
        ) => { request: NormalizedRequest; artifacts: typeof currentArtifacts };
      }).buildPrimarySummaryRawExpansionRequest = () => ({ request: retryRequest, artifacts: currentArtifacts });
      (agent as unknown as { getCurrentBranchGeneration: () => ReturnType<typeof branchInfo> }).getCurrentBranchGeneration =
        () => branchInfo();

      const start = (framework as unknown as {
        startAgentStream: (agent: object, trigger: Record<string, unknown>) => Promise<void>;
        pendingRequests: Array<Record<string, unknown>>;
      }).startAgentStream.bind(framework);
      const trigger = {
        agentName: 'assistant',
        reason: 'test',
        source: 'test',
        timestamp: Date.now(),
      };
      await start(agent, trigger);
      await waitForStream(framework, 'assistant');

      const queuedRetry = (framework as unknown as { pendingRequests: Array<Record<string, unknown>> }).pendingRequests.shift();
      assert.ok(queuedRetry);
      await start(agent, queuedRetry!);
      await waitForStream(framework, 'assistant');

      assert.equal(membrane.calls.length, 2);
      assert.equal((framework as unknown as { pendingRequests: Array<Record<string, unknown>> }).pendingRequests.length, 0);
      const records = fallbackState(framework).requests;
      const original = records.find((record) => record.requestId !== 'baseline-request' && record.dispatchKind === 'primary')!;
      const retry = records.find((record) => record.dispatchKind === 'primary_summary_fallback_retry')!;
      assert.equal(original.fallbackStatus, 'held');
      assert.equal(original.fallbackHeldReason, 'primary_summary_fallback_retry_refusal');
      assert.equal(retry.finalStatus, 'held');
      assert.equal(retry.fallbackHeldReason, 'primary_summary_fallback_retry_refusal');
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the pending request record before a lazy stream is iterated', async () => {
    const lazy = new LazyStream();
    const membrane = new ScriptedMembrane([lazy]);
    const { dir, framework, agent } = await createFramework(membrane, {
      primarySummaryFallback: { enabled: true, maxNewSummaries: 4, requestBudgetTokens: 4096 },
    });
    try {
      const preparedRequest = request('system', 'hello');
      const preparedArtifacts = artifacts('shared', ['L1-1']);
      let sawPendingBeforeIteration = false;
      lazy.onStart = () => {
        const stored = fallbackState(framework).requests;
        sawPendingBeforeIteration = stored.length === 1 && stored[0]!.finalStatus === 'pending';
      };
      (agent as unknown as {
        prepareActivationRequest: () => Promise<{ request: NormalizedRequest; artifacts: typeof preparedArtifacts }>;
        getCurrentBranchGeneration: () => ReturnType<typeof branchInfo>;
      }).prepareActivationRequest = async () => ({ request: preparedRequest, artifacts: preparedArtifacts });
      (agent as unknown as { getCurrentBranchGeneration: () => ReturnType<typeof branchInfo> }).getCurrentBranchGeneration =
        () => branchInfo();

      await (framework as unknown as {
        startAgentStream: (agent: object, trigger: Record<string, unknown>) => Promise<void>;
      }).startAgentStream(agent, {
        agentName: 'assistant',
        reason: 'test',
        source: 'test',
        timestamp: Date.now(),
      });
      await waitForStream(framework, 'assistant');
      assert.equal(lazy.started, true);
      assert.equal(sawPendingBeforeIteration, true);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
