import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';

import type {
  ContentBlock,
  NormalizedRequest,
  NormalizedResponse,
  StreamEvent,
  YieldingStream,
} from '@animalabs/membrane';
import {
  AutobiographicalStrategy,
  type PrimarySummaryIdentity,
  type SummaryEntry,
} from '@animalabs/context-manager';

import type {
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

const NODELESS_DATE = '2026-07-17T00:00:00.000Z';
const FALLBACK_STATE_ID = 'framework/primary-summary-fallback';
const RAW_PRIVATE_SENTINEL = 'RAW_PRIVATE_SENTINEL_2026_07_17';
const SUMMARY_PRIVATE_SENTINEL = 'SUMMARY_PRIVATE_SENTINEL_2026_07_17';
const RETRY_OUTPUT_SENTINEL = 'RETRY_OUTPUT_SENTINEL_2026_07_17';
const TOOL_ARG_SENTINEL = 'TOOL_ARG_SENTINEL_2026_07_17';
const TOOL_RESULT_SENTINEL = 'TOOL_RESULT_SENTINEL_2026_07_17';
const FINAL_TOOL_ARG_SENTINEL = 'FINAL_TOOL_ARG_SENTINEL_2026_07_17';
const NON_EXECUTED_TOOL_RESULT = '[tool not executed]';
const PRIMARY_SUMMARY_SETTLEMENT_METADATA_KEY = 'primarySummarySettlement';

const paths: string[] = [];
let fixtureSequence = 0;

function freshPath(): string {
  const path = `./test-primary-summary-refusal-fallback-int-${fixtureSequence++}`;
  paths.push(path);
  return path;
}

after(() => {
  for (const path of paths) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
});

class ProbeStrategy extends AutobiographicalStrategy {
  seed(entry: SummaryEntry): void {
    this.pushSummary(entry);
  }
}

class ScriptedMembrane {
  readonly calls: NormalizedRequest[] = [];

  constructor(private readonly streams: Array<NormalizedResponse[] | YieldingStream>) {}

  complete(): Promise<NormalizedResponse> {
    throw new Error('complete() is not used by the primary streaming path');
  }

  streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(structuredClone(request));
    const next = this.streams.shift();
    if (!next) return new MockYieldingStream([createMockResponse([{ type: 'text', text: 'default' }])]);
    return Array.isArray(next) ? new MockYieldingStream(next) : next;
  }

  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}

class ErrorStream implements YieldingStream {
  readonly isWaitingForTools = false;
  readonly pendingToolCallIds: string[] = [];
  readonly toolDepth = 0;

  constructor(private readonly message: string) {}

  provideToolResults(): void {
    throw new Error('ErrorStream does not support tool rounds');
  }

  cancel(): void {}

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'error', error: new Error(this.message) } as StreamEvent;
  }
}

class AbortedStream implements YieldingStream {
  readonly isWaitingForTools = false;
  readonly pendingToolCallIds: string[] = [];
  readonly toolDepth = 0;

  constructor(private readonly reason: string) {}

  provideToolResults(): void {
    throw new Error('AbortedStream does not support tool rounds');
  }

  cancel(): void {}

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'aborted', reason: this.reason } as StreamEvent;
  }
}

class HookedCompleteStream implements YieldingStream {
  readonly isWaitingForTools = false;
  readonly pendingToolCallIds: string[] = [];
  readonly toolDepth = 0;

  constructor(
    private readonly response: NormalizedResponse,
    private readonly beforeYield?: () => Promise<void> | void,
  ) {}

  provideToolResults(): void {
    throw new Error('HookedCompleteStream does not support tool rounds');
  }

  cancel(): void {}

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    await this.beforeYield?.();
    yield { type: 'complete', response: this.response } as StreamEvent;
  }
}

class EchoModule implements Module {
  readonly name = 'toolbox';
  private ctx: ModuleContext | null = null;
  readonly calls: ToolCall[] = [];
  readonly quarantineObserved: boolean[] = [];

  constructor(private readonly isQuarantineVisible: () => boolean) {}

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  getTools(): ToolDefinition[] {
    return [{
      name: 'echo',
      description: 'Echoes a sentinel payload',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
        },
        required: ['message'],
      },
    }];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    this.quarantineObserved.push(this.isQuarantineVisible());
    return {
      success: true,
      data: { echoed: TOOL_RESULT_SENTINEL },
    };
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }
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

function toolRoundResponse(): NormalizedResponse {
  return createMockResponse([
    { type: 'text', text: 'checking tool path' },
    { type: 'tool_use', id: 'call-1', name: 'toolbox--echo', input: { message: TOOL_ARG_SENTINEL } } as ContentBlock,
  ], 'tool_use');
}

function outputResponse(text = RETRY_OUTPUT_SENTINEL): NormalizedResponse {
  return createMockResponse([{ type: 'text', text }]);
}

function summary(id: string, sourceIds: string[], first: string, last: string, content: string): SummaryEntry {
  return {
    id,
    level: 1,
    content,
    tokens: 20,
    sourceLevel: 0,
    sourceIds,
    sourceRange: { first, last },
    created: 1,
  };
}

function fallbackState(framework: AgentFramework): { requests: Array<Record<string, unknown>> } {
  const raw = framework.getStore().getStateJson(FALLBACK_STATE_ID);
  return raw && typeof raw === 'object'
    ? raw as { requests: Array<Record<string, unknown>> }
    : { requests: [] };
}

function primarySummaryQuarantineState(framework: AgentFramework, agentName: string): unknown {
  return framework.getStore().getStateJson(`agents/${agentName}/autobio:primary-summary-quarantine`);
}

function jsonContains(value: unknown, needle: string): boolean {
  return JSON.stringify(value ?? null).includes(needle);
}

function countMessagesContaining(messages: Array<{ content: ContentBlock[] }>, needle: string): number {
  return messages.filter((message) => JSON.stringify(message.content).includes(needle)).length;
}

function chronicleMessages(agent: NonNullable<ReturnType<AgentFramework['getAgent']>>): Array<{
  id: string;
  sequence: number;
  participant: string;
  content: ContentBlock[];
  metadata?: Record<string, unknown>;
  bodyGroupId?: string;
  shardIndex?: number;
}> {
  return (agent.getContextManager() as unknown as {
    getAllMessages: () => Array<{
      id: string;
      sequence: number;
      participant: string;
      content: ContentBlock[];
      metadata?: Record<string, unknown>;
      bodyGroupId?: string;
      shardIndex?: number;
    }>;
  }).getAllMessages();
}

function settlementMessages(
  agent: NonNullable<ReturnType<AgentFramework['getAgent']>>,
  requestId: string,
): Array<{
  id: string;
  sequence: number;
  participant: string;
  content: ContentBlock[];
  metadata?: Record<string, unknown>;
  bodyGroupId?: string;
  shardIndex?: number;
}> {
  return chronicleMessages(agent).filter((message) =>
    ((message.metadata?.[PRIMARY_SUMMARY_SETTLEMENT_METADATA_KEY] as { requestId?: string } | undefined)?.requestId) === requestId);
}

function shardingStrategy(targetChunkTokens = 8): ProbeStrategy {
  return new ProbeStrategy({
    compressionModel: 'same-model',
    targetChunkTokens,
    recentWindowTokens: 0,
    headWindowTokens: 0,
    autoTickOnNewMessage: false,
    minChunkCharsForLLM: 0,
    mergeThreshold: 99,
    adaptiveResolution: true,
  });
}

function longShardText(label: string, repeat = 240): string {
  return `${label} ${'segment '.repeat(repeat)}`;
}

function shardIngressContent(
  strategy: ProbeStrategy,
  participant: string,
  content: ContentBlock[],
): { bodyGroupId: string; shards: Array<{ content: ContentBlock[]; shardIndex: number }> } {
  const sharded = strategy.chunkIngressMessage(participant, content);
  assert.ok(sharded, 'expected ingress sharding to activate');
  assert.ok(sharded.shards.length > 1, 'expected multiple physical shards');
  return sharded;
}

function appendPhysicalMessage(
  agent: NonNullable<ReturnType<AgentFramework['getAgent']>>,
  participant: string,
  content: ContentBlock[],
  metadata?: Record<string, unknown>,
  extra?: { bodyGroupId?: string; shardIndex?: number },
): string {
  const message = (agent.getContextManager() as unknown as {
    messageStore: {
      append: (
        participant: string,
        content: ContentBlock[],
        metadata?: Record<string, unknown>,
        causedBy?: string[],
        extra?: { bodyGroupId?: string; shardIndex?: number },
      ) => { id: string };
    };
  }).messageStore.append(participant, content, metadata, undefined, extra);
  return message.id;
}

function settlementMetadata(options: {
  requestId: string;
  agentName?: string;
  dispatchKind?: 'primary' | 'primary_summary_fallback_retry';
  outcome?: 'held' | 'success';
  branchId?: string;
  branchName?: string;
  branchGeneration?: number;
  holdReason?: string;
  stopReason?: string;
  providerInputTokens?: number;
  visibleAssistantOutput?: boolean;
  executedToolCalls?: number;
  entryIndex: number;
  entryCount: number;
  role: 'assistant' | 'user';
  kind: 'assistant_output' | 'generated_tool_result';
  settlementId?: string;
}): Record<string, unknown> {
  const dispatchKind = options.dispatchKind ?? 'primary';
  const outcome = options.outcome ?? 'held';
  return {
    [PRIMARY_SUMMARY_SETTLEMENT_METADATA_KEY]: {
      version: 1,
      requestId: options.requestId,
      settlementId: options.settlementId ?? `${dispatchKind}:${outcome}:terminal:v1`,
      agentName: options.agentName ?? 'assistant',
      dispatchKind,
      outcome,
      ...(options.holdReason ? { holdReason: options.holdReason } : {}),
      ...(options.stopReason ? { stopReason: options.stopReason } : {}),
      ...(options.providerInputTokens !== undefined ? { providerInputTokens: options.providerInputTokens } : {}),
      visibleAssistantOutput: options.visibleAssistantOutput ?? true,
      executedToolCalls: options.executedToolCalls ?? 0,
      branch: {
        id: options.branchId ?? 'main',
        name: options.branchName ?? options.branchId ?? 'main',
        generation: options.branchGeneration ?? 1,
      },
      role: options.role,
      kind: options.kind,
      entryIndex: options.entryIndex,
      entryCount: options.entryCount,
    },
  };
}

function branchInfo(id = 'main', generation = 1) {
  return {
    id,
    name: id,
    head: 1,
    generation,
    created: new Date(NODELESS_DATE),
  };
}

function projection(branchId: string, generation: number, ids: string[]): Record<string, unknown> {
  return {
    namespace: 'default',
    branch: { id: branchId, name: branchId, generation },
    selectedSummaries: ids.map((id, index) => ({
      identity: {
        id,
        contentHash: `content-${id}`,
        carrierHash: `carrier-${id}`,
        sourceLeafHash: `leaf-${id}`,
      },
      level: 1,
      orderedSourceIds: [`src-${id}-1`, `src-${id}-2`],
      renderedAs: 'summary_pair',
      pairRange: { start: index * 2, end: index * 2 + 1 },
    })),
  };
}

function fallbackRecords(framework: AgentFramework): Array<Record<string, unknown>> {
  return fallbackState(framework).requests;
}

async function createFrameworkFixture(options?: {
  path?: string;
  membrane?: ScriptedMembrane;
  strategy?: ProbeStrategy;
  agentName?: string;
  modules?: Module[];
  extraAgents?: Array<{ name: string; strategy: ProbeStrategy }>;
  maxStreamTokens?: number;
}): Promise<{
  path: string;
  framework: AgentFramework;
  agent: NonNullable<ReturnType<AgentFramework['getAgent']>>;
  strategy: ProbeStrategy;
  membrane: ScriptedMembrane;
}> {
  const path = options?.path ?? freshPath();
  const strategy = options?.strategy ?? new ProbeStrategy({
    compressionModel: 'same-model',
    targetChunkTokens: 100,
    recentWindowTokens: 0,
    headWindowTokens: 0,
    autoTickOnNewMessage: false,
    minChunkCharsForLLM: 0,
    mergeThreshold: 99,
  });
  const membrane = options?.membrane ?? new ScriptedMembrane([]);
  const agentName = options?.agentName ?? 'assistant';
  const agents = [
    {
      name: agentName,
      model: 'test-model',
      systemPrompt: 'system',
      strategy,
      ...(options?.maxStreamTokens !== undefined ? { maxStreamTokens: options.maxStreamTokens } : {}),
      refusalHandling: {
        primarySummaryFallback: { enabled: true, maxNewSummaries: 4, requestBudgetTokens: 100_000 },
      },
    },
    ...((options?.extraAgents ?? []).map((entry) => ({
      name: entry.name,
      model: 'test-model',
      systemPrompt: 'system',
      strategy: entry.strategy,
      refusalHandling: {
        primarySummaryFallback: { enabled: true, maxNewSummaries: 4, requestBudgetTokens: 100_000 },
      },
    }))),
  ];
  const framework = await AgentFramework.create({
    storePath: path,
    membrane: membrane.asMembrane(),
    agents,
    modules: options?.modules ?? [],
  });
  const agent = framework.getAgent(agentName)!;
  return { path, framework, agent, strategy, membrane };
}

function addSourcePair(agent: NonNullable<ReturnType<AgentFramework['getAgent']>>, label: string): string[] {
  const manager = agent.getContextManager();
  return [
    manager.addMessage('User', [{ type: 'text', text: `${RAW_PRIVATE_SENTINEL}:${label}:user ${'u '.repeat(30)}` }]),
    manager.addMessage(agent.name, [{ type: 'text', text: `${RAW_PRIVATE_SENTINEL}:${label}:assistant ${'a '.repeat(30)}` }]),
  ];
}

function addLatestPrompt(agent: NonNullable<ReturnType<AgentFramework['getAgent']>>, label: string): string {
  return agent.getContextManager().addMessage('User', [{ type: 'text', text: `latest ${label} ${'l '.repeat(20)}` }]);
}

function seedSummary(strategy: ProbeStrategy, id: string, sourceIds: string[]): void {
  strategy.seed(summary(
    id,
    sourceIds,
    sourceIds[0]!,
    sourceIds[sourceIds.length - 1]!,
    `${SUMMARY_PRIVATE_SENTINEL}:${id}`,
  ));
}

async function persistHealthyBaseline(
  framework: AgentFramework,
  agent: NonNullable<ReturnType<AgentFramework['getAgent']>>,
  requestId = 'baseline-request',
): Promise<void> {
  const tools = framework.getAllTools().filter((tool) => agent.canUseTool(tool.name));
  const prepared = await agent.prepareActivationRequest(tools);
  const build = (framework as unknown as {
    buildPrimarySummaryRequestRecord: (...args: unknown[]) => Record<string, unknown>;
  }).buildPrimarySummaryRequestRecord.bind(framework);
  const persist = (framework as unknown as {
    persistPrimarySummaryRequestRecord: (record: Record<string, unknown>) => Promise<void>;
  }).persistPrimarySummaryRequestRecord.bind(framework);
  const record = build(
    agent,
    requestId,
    'primary',
    prepared.request,
    prepared.artifacts,
    agent.getCurrentBranchGeneration() ?? branchInfo(),
    'end_turn',
    true,
    0,
    30,
    'success',
  );
  await persist(record);
}

async function enqueueAndDrain(framework: AgentFramework, agentName = 'assistant'): Promise<void> {
  (framework as unknown as {
    pendingRequests: Array<Record<string, unknown>>;
  }).pendingRequests.push({
    agentName,
    reason: 'test',
    source: 'test',
    timestamp: Date.now(),
  });
  await framework.runUntilIdle();
}

async function runPrimaryOnly(
  framework: AgentFramework,
  agent: NonNullable<ReturnType<AgentFramework['getAgent']>>,
): Promise<void> {
  await (framework as unknown as {
    startAgentStream: (agent: object, trigger: Record<string, unknown>) => Promise<void>;
  }).startAgentStream(agent, {
    agentName: agent.name,
    reason: 'test',
    source: 'test',
    timestamp: Date.now(),
  });
  const active = (framework as unknown as {
    activeStreams: Map<string, Promise<void>>;
  }).activeStreams.get(agent.name);
  if (active) await active;
}

function fallbackRetryRecords(framework: AgentFramework): Array<Record<string, unknown>> {
  return fallbackRecords(framework).filter((record) => record.dispatchKind === 'primary_summary_fallback_retry');
}

function latestPrimaryRecord(framework: AgentFramework, requestIdExclusions: string[] = ['baseline-request']): Record<string, unknown> {
  return fallbackRecords(framework)
    .filter((record) =>
      record.dispatchKind === 'primary'
      && !requestIdExclusions.includes(String(record.requestId)))
    .at(-1)!;
}

function manualPrimaryRecord(options: {
  requestId: string;
  finalStatus?: 'pending' | 'refusal' | 'held' | 'success';
  fallbackStatus?: 'pending' | 'refusal' | 'held' | 'success';
  fallbackHeldReason?: string;
  branchId?: string;
  branchName?: string;
  branchGeneration?: number;
  projectionIds?: string[];
  fallbackIntent?: Record<string, unknown>;
}): Record<string, unknown> {
  const branchId = options.branchId ?? 'main';
  const branchName = options.branchName ?? branchId;
  const branchGeneration = options.branchGeneration ?? 1;
  return {
    requestId: options.requestId,
    agentName: 'assistant',
    namespace: 'default',
    timestamp: Date.now(),
    dispatchKind: 'primary',
    branch: { id: branchId, name: branchName, generation: branchGeneration },
    projection: projection(branchId, branchGeneration, options.projectionIds ?? ['L1-X']),
    requestInputBoundTokens: 100,
    requestCompleteBoundTokens: 200,
    providerInputTokens: 40,
    systemHash: 'system-shared',
    modelConfigHash: 'model-shared',
    toolContractHash: 'tools-shared',
    stopReason: 'refusal',
    visibleAssistantOutput: true,
    executedToolCalls: 0,
    finalStatus: options.finalStatus ?? 'refusal',
    ...(options.fallbackStatus ? { fallbackStatus: options.fallbackStatus } : {}),
    ...(options.fallbackHeldReason ? { fallbackHeldReason: options.fallbackHeldReason } : {}),
    ...(options.fallbackIntent ? { fallbackIntent: options.fallbackIntent } : {}),
  };
}

function resolvedFallbackRetryLogs(framework: AgentFramework): Array<Record<string, unknown>> {
  return framework.queryInferenceLogs({ limit: 100 }).entries
    .map(({ sequence }) => framework.getInferenceLog(sequence, true)!)
    .filter((entry) =>
      (entry.entry.request as { kind?: string } | undefined)?.kind === 'primary_summary_fallback_retry'
      || (entry.entry.response as { kind?: string } | undefined)?.kind === 'primary_summary_fallback_retry')
    .map((entry) => entry.entry as unknown as Record<string, unknown>);
}

describe('primary summary refusal fallback integration', () => {
  it('holds a retry stream error without entering the generic retry loop and survives restart', async () => {
    const membrane = new ScriptedMembrane([
      [refusalResponse()],
      new ErrorStream('transport broke during retry'),
    ]);
    const { path, framework, agent, strategy } = await createFrameworkFixture({ membrane });
    try {
      const a = addSourcePair(agent, 'A');
      seedSummary(strategy, 'L1-A', a);
      addLatestPrompt(agent, 'baseline');
      await persistHealthyBaseline(framework, agent);

      const b = addSourcePair(agent, 'B');
      seedSummary(strategy, 'L1-B', b);
      addLatestPrompt(agent, 'current');

      await enqueueAndDrain(framework);

      assert.equal(membrane.calls.length, 2, 'one refusal family may dispatch the provider at most twice');
      assert.equal(fallbackRetryRecords(framework).length, 1, 'retry record must stay singular');
      assert.equal((framework as unknown as { pendingRequests: unknown[] }).pendingRequests.length, 0);

      const records = fallbackRecords(framework);
      const original = records.find((record) => record.requestId !== 'baseline-request' && record.dispatchKind === 'primary')!;
      const retry = records.find((record) => record.dispatchKind === 'primary_summary_fallback_retry')!;
      assert.equal(original.fallbackStatus, 'held');
      assert.equal(original.fallbackHeldReason, 'primary_summary_fallback_retry_stream_error');
      assert.equal(retry.finalStatus, 'held');
      assert.equal(retry.fallbackHeldReason, 'primary_summary_fallback_retry_stream_error');
    } finally {
      await framework.stop();
    }

    const restarted = await createFrameworkFixture({
      path,
      membrane: new ScriptedMembrane([]),
      strategy: new ProbeStrategy({
        compressionModel: 'same-model',
        targetChunkTokens: 100,
        recentWindowTokens: 0,
        headWindowTokens: 0,
        autoTickOnNewMessage: false,
        minChunkCharsForLLM: 0,
        mergeThreshold: 99,
      }),
    });
    try {
      assert.equal(restarted.membrane.calls.length, 0, 'restart must not resend an ambiguous fallback retry');
      const records = fallbackRecords(restarted.framework);
      const original = records.find((record) => record.requestId !== 'baseline-request' && record.dispatchKind === 'primary')!;
      const retry = records.find((record) => record.dispatchKind === 'primary_summary_fallback_retry')!;
      assert.equal(original.fallbackStatus, 'held');
      assert.equal(retry.finalStatus, 'held');
      assert.deepEqual(
        restarted.framework.healthSnapshot().primarySummaryFallback,
        { requests: 3, pendingDispatches: 0, unresolvedIntents: 0, held: 2 },
      );
    } finally {
      await restarted.framework.stop();
    }
  });

  it('holds an aborted retry as held and never resends it on restart', async () => {
    const membrane = new ScriptedMembrane([
      [refusalResponse()],
      new AbortedStream('timeout'),
    ]);
    const { path, framework, agent, strategy } = await createFrameworkFixture({ membrane });
    try {
      const a = addSourcePair(agent, 'A');
      seedSummary(strategy, 'L1-A', a);
      addLatestPrompt(agent, 'baseline');
      await persistHealthyBaseline(framework, agent);

      const b = addSourcePair(agent, 'B');
      seedSummary(strategy, 'L1-B', b);
      addLatestPrompt(agent, 'current');

      await enqueueAndDrain(framework);
      assert.equal(membrane.calls.length, 2);
      const original = latestPrimaryRecord(framework);
      assert.equal(original.fallbackHeldReason, 'stream_aborted:timeout');
    } finally {
      await framework.stop();
    }

    const restarted = await createFrameworkFixture({ path, membrane: new ScriptedMembrane([]) });
    try {
      assert.equal(restarted.membrane.calls.length, 0);
      const original = latestPrimaryRecord(restarted.framework);
      assert.equal(original.fallbackHeldReason, 'stream_aborted:timeout');
    } finally {
      await restarted.framework.stop();
    }
  });

  it('excludes successful fallback retries from the healthy baseline search', async () => {
    const membrane = new ScriptedMembrane([
      [refusalResponse()],
      [outputResponse('recovered-p2')],
      [refusalResponse()],
    ]);
    const { framework, agent, strategy } = await createFrameworkFixture({ membrane });
    try {
      const a = addSourcePair(agent, 'A');
      seedSummary(strategy, 'L1-A', a);
      addLatestPrompt(agent, 'baseline');
      await persistHealthyBaseline(framework, agent);

      const b = addSourcePair(agent, 'B');
      seedSummary(strategy, 'L1-B', b);
      addLatestPrompt(agent, 'p2');
      await enqueueAndDrain(framework);

      const c = addSourcePair(agent, 'C');
      seedSummary(strategy, 'L1-C', c);
      addLatestPrompt(agent, 'p3');
      await runPrimaryOnly(framework, agent);

      const p3 = latestPrimaryRecord(framework);
      const candidateIds = ((p3.fallbackIntent as { candidateSummaries?: Array<{ id: string }> }).candidateSummaries ?? [])
        .map((item) => item.id);
      assert.deepEqual(candidateIds, ['L1-B', 'L1-C']);
    } finally {
      await framework.stop();
    }
  });

  it('persists quarantine before tool dispatch, stores canonical output exactly once, and keeps fallback logs metadata-only', async () => {
    let frameworkRef: AgentFramework | null = null;
    const module = new EchoModule(() =>
      jsonContains(primarySummaryQuarantineState(frameworkRef!, 'assistant'), 'L1-B'),
    );
    const membrane = new ScriptedMembrane([
      [refusalResponse()],
      [toolRoundResponse(), outputResponse()],
    ]);
    const { framework, agent, strategy } = await createFrameworkFixture({ membrane, modules: [module] });
    frameworkRef = framework;
    try {
      const a = addSourcePair(agent, 'A');
      seedSummary(strategy, 'L1-A', a);
      addLatestPrompt(agent, 'baseline');
      await persistHealthyBaseline(framework, agent);

      const b = addSourcePair(agent, 'B');
      seedSummary(strategy, 'L1-B', b);
      addLatestPrompt(agent, 'tool-retry');

      await enqueueAndDrain(framework);

      assert.equal(membrane.calls.length, 2);
      assert.equal(module.calls.length, 1, 'tool executes exactly once');
      assert.deepEqual(module.quarantineObserved, [true], 'quarantine must be durable before tool dispatch');

      const messages = (agent.getContextManager() as unknown as {
        getAllMessages: () => Array<{ content: ContentBlock[] }>;
      }).getAllMessages();
      assert.equal(countMessagesContaining(messages, TOOL_ARG_SENTINEL), 1, 'tool_use assistant output is persisted exactly once');
      assert.equal(countMessagesContaining(messages, TOOL_RESULT_SENTINEL), 1, 'tool_result is persisted exactly once');
      assert.equal(countMessagesContaining(messages, RETRY_OUTPUT_SENTINEL), 1, 'trailing assistant output is persisted exactly once');

      const retryLogs = resolvedFallbackRetryLogs(framework);
      assert.ok(retryLogs.length >= 1, 'fallback retry should produce an inference log entry');
      for (const entry of retryLogs) {
        assert.equal(jsonContains(entry, RAW_PRIVATE_SENTINEL), false);
        assert.equal(jsonContains(entry, SUMMARY_PRIVATE_SENTINEL), false);
        assert.equal(jsonContains(entry, TOOL_ARG_SENTINEL), false);
        assert.equal(jsonContains(entry, TOOL_RESULT_SENTINEL), false);
      }

      const observabilityMaterial = [
        fallbackState(framework),
        primarySummaryQuarantineState(framework, 'assistant'),
        ...retryLogs,
      ];
      for (const material of observabilityMaterial) {
        assert.equal(jsonContains(material, RAW_PRIVATE_SENTINEL), false);
        assert.equal(jsonContains(material, SUMMARY_PRIVATE_SENTINEL), false);
        assert.equal(jsonContains(material, TOOL_ARG_SENTINEL), false);
        assert.equal(jsonContains(material, TOOL_RESULT_SENTINEL), false);
      }
      assert.equal(jsonContains(messages, TOOL_ARG_SENTINEL), true, 'canonical Chronicle output still carries the lived tool input');
      assert.equal(jsonContains(messages, TOOL_RESULT_SENTINEL), true, 'canonical Chronicle output still carries the lived tool result');
    } finally {
      await framework.stop();
    }
  });

  it('holds retry text + tool_use output without executing tools, preserves pairing, and keeps fallback telemetry metadata-only', async () => {
    const module = new EchoModule(() => false);
    const membrane = new ScriptedMembrane([
      [refusalResponse()],
      [refusalResponse([
        { type: 'thinking', thinking: 'reasoning carrier', signature: 'sig-1' } as ContentBlock,
        { type: 'text', text: RETRY_OUTPUT_SENTINEL } as ContentBlock,
        { type: 'tool_use', id: 'call-1', name: 'toolbox--echo', input: { message: TOOL_ARG_SENTINEL } } as ContentBlock,
      ])],
    ]);
    const { framework, agent, strategy } = await createFrameworkFixture({ membrane, modules: [module] });
    try {
      const a = addSourcePair(agent, 'A');
      seedSummary(strategy, 'L1-A', a);
      addLatestPrompt(agent, 'baseline');
      await persistHealthyBaseline(framework, agent);

      const b = addSourcePair(agent, 'B');
      seedSummary(strategy, 'L1-B', b);
      addLatestPrompt(agent, 'held-tool-use');

      await enqueueAndDrain(framework);

      assert.equal(membrane.calls.length, 2);
      assert.equal(module.calls.length, 0, 'held retry output must not execute tools');

      const messages = (agent.getContextManager() as unknown as {
        getAllMessages: () => Array<{ content: ContentBlock[] }>;
      }).getAllMessages();
      assert.equal(countMessagesContaining(messages, RETRY_OUTPUT_SENTINEL), 1);
      assert.equal(countMessagesContaining(messages, TOOL_ARG_SENTINEL), 1);
      assert.equal(countMessagesContaining(messages, NON_EXECUTED_TOOL_RESULT), 1);

      const assistantIndex = messages.findIndex((message) =>
        JSON.stringify(message.content).includes(RETRY_OUTPUT_SENTINEL));
      assert.ok(assistantIndex >= 0);
      assert.deepEqual(
        messages[assistantIndex]!.content.map((block) => block.type),
        ['thinking', 'text', 'tool_use'],
      );
      const persistedToolUse = messages[assistantIndex]!.content.find((block) => block.type === 'tool_use') as ContentBlock & {
        type: 'tool_use';
        id: string;
        input: Record<string, unknown>;
      };
      assert.equal(persistedToolUse.id, 'call-1');
      assert.equal(persistedToolUse.input.message, TOOL_ARG_SENTINEL);
      const placeholder = messages[assistantIndex + 1]!.content[0] as ContentBlock & {
        type: 'tool_result';
        toolUseId: string;
        content: string;
        isError?: boolean;
      };
      assert.equal(placeholder.type, 'tool_result');
      assert.equal(placeholder.toolUseId, 'call-1');
      assert.equal(placeholder.content, NON_EXECUTED_TOOL_RESULT);
      assert.equal(placeholder.isError, true);

      const records = fallbackRecords(framework);
      const original = records.find((record) => record.requestId !== 'baseline-request' && record.dispatchKind === 'primary')!;
      const retry = records.find((record) => record.dispatchKind === 'primary_summary_fallback_retry')!;
      assert.equal(original.fallbackHeldReason, 'primary_summary_fallback_retry_partial_output');
      assert.equal(retry.fallbackHeldReason, 'primary_summary_fallback_retry_partial_output');

      const retryLogs = resolvedFallbackRetryLogs(framework);
      const observabilityMaterial = [
        fallbackState(framework),
        ...retryLogs,
      ];
      for (const material of observabilityMaterial) {
        assert.equal(jsonContains(material, RETRY_OUTPUT_SENTINEL), false);
        assert.equal(jsonContains(material, TOOL_ARG_SENTINEL), false);
        assert.equal(jsonContains(material, NON_EXECUTED_TOOL_RESULT), false);
      }
      assert.equal(jsonContains(messages, RETRY_OUTPUT_SENTINEL), true);
      assert.equal(jsonContains(messages, TOOL_ARG_SENTINEL), true);
      assert.equal(jsonContains(messages, NON_EXECUTED_TOOL_RESULT), true);
    } finally {
      await framework.stop();
    }
  });

  it('persists an initial refusal partial text exactly once, never retries, and holds', async () => {
    const membrane = new ScriptedMembrane([[refusalResponse([{ type: 'text', text: RETRY_OUTPUT_SENTINEL } as ContentBlock])]]);
    const { framework, agent } = await createFrameworkFixture({ membrane });
    try {
      await enqueueAndDrain(framework);

      assert.equal(membrane.calls.length, 1);
      const messages = chronicleMessages(agent);
      assert.equal(countMessagesContaining(messages, RETRY_OUTPUT_SENTINEL), 1);
      assert.equal(settlementMessages(agent, String(latestPrimaryRecord(framework).requestId)).length, 1);
      const original = latestPrimaryRecord(framework);
      assert.equal(original.finalStatus, 'held');
      assert.equal(original.fallbackHeldReason, 'primary_summary_refusal_partial_output');
      assert.equal((framework as unknown as { pendingRequests: unknown[] }).pendingRequests.length, 0);
    } finally {
      await framework.stop();
    }
  });

  it('persists a retry refusal partial text exactly once, stops at two provider calls, and holds', async () => {
    const membrane = new ScriptedMembrane([
      [refusalResponse()],
      [refusalResponse([{ type: 'text', text: RETRY_OUTPUT_SENTINEL } as ContentBlock])],
    ]);
    const { framework, agent, strategy } = await createFrameworkFixture({ membrane });
    try {
      const a = addSourcePair(agent, 'A');
      seedSummary(strategy, 'L1-A', a);
      addLatestPrompt(agent, 'baseline');
      await persistHealthyBaseline(framework, agent);

      const b = addSourcePair(agent, 'B');
      seedSummary(strategy, 'L1-B', b);
      addLatestPrompt(agent, 'retry-partial');

      await enqueueAndDrain(framework);

      assert.equal(membrane.calls.length, 2);
      const messages = chronicleMessages(agent);
      assert.equal(countMessagesContaining(messages, RETRY_OUTPUT_SENTINEL), 1);
      const records = fallbackRecords(framework);
      const original = records.find((record) => record.requestId !== 'baseline-request' && record.dispatchKind === 'primary')!;
      const retry = records.find((record) => record.dispatchKind === 'primary_summary_fallback_retry')!;
      assert.equal(original.fallbackHeldReason, 'primary_summary_fallback_retry_partial_output');
      assert.equal(retry.fallbackHeldReason, 'primary_summary_fallback_retry_partial_output');
    } finally {
      await framework.stop();
    }
  });

  it('holds an initial thinking + tool_use refusal without executing tools and preserves provider block order', async () => {
    const module = new EchoModule(() => false);
    const refusalBlocks: ContentBlock[] = [
      { type: 'thinking', thinking: 'initial reasoning', signature: 'sig-initial' } as ContentBlock,
      { type: 'tool_use', id: 'call-initial', name: 'toolbox--echo', input: { message: TOOL_ARG_SENTINEL } } as ContentBlock,
    ];
    const membrane = new ScriptedMembrane([[refusalResponse(refusalBlocks)]]);
    const { framework, agent } = await createFrameworkFixture({ membrane, modules: [module] });
    try {
      await enqueueAndDrain(framework);

      assert.equal(membrane.calls.length, 1);
      assert.equal(module.calls.length, 0);
      const requestId = String(latestPrimaryRecord(framework).requestId);
      const settled = settlementMessages(agent, requestId);
      assert.equal(settled.length, 2);
      assert.deepEqual(settled[0]!.content.map((block) => block.type), ['thinking', 'tool_use']);
      const placeholder = settled[1]!.content[0] as ContentBlock & { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };
      assert.equal(placeholder.type, 'tool_result');
      assert.equal(placeholder.toolUseId, 'call-initial');
      assert.equal(placeholder.content, NON_EXECUTED_TOOL_RESULT);
      assert.equal(placeholder.isError, true);
    } finally {
      await framework.stop();
    }
  });

  it('preserves all text before, between, and after refused tool_use blocks without silently dropping lived blocks', async () => {
    const refusalBlocks: ContentBlock[] = [
      { type: 'text', text: 'before' },
      { type: 'thinking', thinking: 'reasoning', signature: 'sig-mixed' } as ContentBlock,
      { type: 'tool_use', id: 'call-a', name: 'toolbox--echo', input: { message: 'A' } } as ContentBlock,
      { type: 'text', text: 'between' },
      { type: 'tool_use', id: 'call-b', name: 'toolbox--echo', input: { message: 'B' } } as ContentBlock,
      { type: 'text', text: 'after' },
    ];
    const membrane = new ScriptedMembrane([[refusalResponse(refusalBlocks)]]);
    const { framework, agent } = await createFrameworkFixture({ membrane });
    try {
      await enqueueAndDrain(framework);

      const requestId = String(latestPrimaryRecord(framework).requestId);
      const settled = settlementMessages(agent, requestId);
      assert.equal(settled.length, 2);
      assert.deepEqual(settled[0]!.content.map((block) => block.type), refusalBlocks.map((block) => block.type));
      assert.equal(JSON.stringify(settled[0]!.content).includes('before'), true);
      assert.equal(JSON.stringify(settled[0]!.content).includes('between'), true);
      assert.equal(JSON.stringify(settled[0]!.content).includes('after'), true);
      assert.equal((settled[1]!.content[0] as ContentBlock & { toolUseId: string }).toolUseId, 'call-a');
      assert.equal((settled[1]!.content[1] as ContentBlock & { toolUseId: string }).toolUseId, 'call-b');
    } finally {
      await framework.stop();
    }
  });

  it('executes earlier retry tool rounds exactly once but never executes the final refused tool_use round', async () => {
    const module = new EchoModule(() => true);
    const membrane = new ScriptedMembrane([
      [refusalResponse()],
      [toolRoundResponse(), refusalResponse([
        { type: 'thinking', thinking: 'final reasoning', signature: 'sig-final' } as ContentBlock,
        { type: 'text', text: RETRY_OUTPUT_SENTINEL } as ContentBlock,
        { type: 'tool_use', id: 'call-final', name: 'toolbox--echo', input: { message: FINAL_TOOL_ARG_SENTINEL } } as ContentBlock,
      ])],
    ]);
    const { framework, agent, strategy } = await createFrameworkFixture({ membrane, modules: [module] });
    try {
      const a = addSourcePair(agent, 'A');
      seedSummary(strategy, 'L1-A', a);
      addLatestPrompt(agent, 'baseline');
      await persistHealthyBaseline(framework, agent);

      const b = addSourcePair(agent, 'B');
      seedSummary(strategy, 'L1-B', b);
      addLatestPrompt(agent, 'final-refusal-after-tool');

      await enqueueAndDrain(framework);

      assert.equal(membrane.calls.length, 2);
      assert.equal(module.calls.length, 1, 'only the successful earlier tool round may execute');
      const messages = chronicleMessages(agent);
      assert.equal(countMessagesContaining(messages, TOOL_RESULT_SENTINEL), 1, 'earlier tool result persists exactly once');
      assert.equal(countMessagesContaining(messages, FINAL_TOOL_ARG_SENTINEL), 1, 'final refused tool_use persists exactly once');
      const retry = fallbackRetryRecords(framework).at(-1)!;
      const settled = settlementMessages(agent, String(retry.requestId));
      assert.equal(settled.length, 2);
      assert.deepEqual(settled[0]!.content.map((block) => block.type), ['thinking', 'text', 'tool_use']);
      const placeholder = settled[1]!.content[0] as ContentBlock & { toolUseId: string; content: string };
      assert.equal(placeholder.toolUseId, 'call-final');
      assert.equal(placeholder.content, NON_EXECUTED_TOOL_RESULT);
    } finally {
      await framework.stop();
    }
  });

  it('holds a fallback retry instead of queueing a context-budget restart after a tool result', async () => {
    let frameworkRef: AgentFramework | null = null;
    const module = new EchoModule(() =>
      jsonContains(primarySummaryQuarantineState(frameworkRef!, 'assistant'), 'L1-B'),
    );
    const membrane = new ScriptedMembrane([
      [refusalResponse()],
      [toolRoundResponse()],
    ]);
    const { framework, agent, strategy } = await createFrameworkFixture({
      membrane,
      modules: [module],
      maxStreamTokens: 5,
    });
    frameworkRef = framework;
    try {
      const a = addSourcePair(agent, 'A');
      seedSummary(strategy, 'L1-A', a);
      addLatestPrompt(agent, 'baseline');
      await persistHealthyBaseline(framework, agent);

      const b = addSourcePair(agent, 'B');
      seedSummary(strategy, 'L1-B', b);
      addLatestPrompt(agent, 'budget-restart-repro');

      await enqueueAndDrain(framework);

      assert.equal(membrane.calls.length, 2, 'fallback tool-result over-budget must not trigger a third provider call');
      assert.equal(module.calls.length, 1, 'tool must execute exactly once');
      assert.deepEqual(module.quarantineObserved, [true], 'tool dispatch still runs against durable quarantine state');

      const queuedRequests = (framework as unknown as {
        pendingRequests: Array<{ reason?: string }>;
      }).pendingRequests;
      assert.equal(
        queuedRequests.filter((request) => request.reason === 'context_budget_restart').length,
        0,
        'no context_budget_restart may remain queued for the held fallback family',
      );

      const records = fallbackRecords(framework);
      const original = records.find((record) => record.requestId !== 'baseline-request' && record.dispatchKind === 'primary')!;
      const retry = records.find((record) => record.dispatchKind === 'primary_summary_fallback_retry')!;
      assert.equal(original.finalStatus, 'held');
      assert.equal(original.fallbackStatus, 'held');
      assert.equal(original.fallbackHeldReason, 'primary_summary_fallback_context_budget_restart_required');
      assert.equal(retry.finalStatus, 'held');
      assert.equal(retry.fallbackHeldReason, 'primary_summary_fallback_context_budget_restart_required');
      assert.equal(fallbackRetryRecords(framework).length, 1, 'the held retry family must remain singular');
    } finally {
      await framework.stop();
    }
  });

    it('discards a completed retry result after a branch switch mid-await', async () => {
    const membrane = new ScriptedMembrane([
      [refusalResponse()],
      new HookedCompleteStream(outputResponse(), async () => {
        const manager = agentRef!.getContextManager();
        const firstMessageId = (manager as unknown as { getAllMessages: () => Array<{ id: string }> }).getAllMessages()[0]!.id;
        const fork = manager.branchAt(firstMessageId, 'branch-switch-fork');
        await manager.switchBranch(fork);
      }),
    ]);
    let agentRef: NonNullable<ReturnType<AgentFramework['getAgent']>> | null = null;
    const { framework, agent, strategy } = await createFrameworkFixture({ membrane });
    agentRef = agent;
    try {
      const mainBranch = agent.getContextManager().currentBranch().name;
      const a = addSourcePair(agent, 'A');
      seedSummary(strategy, 'L1-A', a);
      addLatestPrompt(agent, 'baseline');
      await persistHealthyBaseline(framework, agent);

      const b = addSourcePair(agent, 'B');
      seedSummary(strategy, 'L1-B', b);
      addLatestPrompt(agent, 'current');

      await enqueueAndDrain(framework);
      assert.equal(jsonContains(primarySummaryQuarantineState(framework, 'assistant'), 'L1-B'), false);
      const messages = (agent.getContextManager() as unknown as {
        getAllMessages: () => Array<{ content: ContentBlock[] }>;
      }).getAllMessages();
      assert.equal(countMessagesContaining(messages, RETRY_OUTPUT_SENTINEL), 0);
      assert.equal(fallbackRecords(framework).length, 0, 'fork branch must not receive fallback-family state writes');
      assert.equal(membrane.calls.length, 2, 'the retry provider call may happen once, but must not be replayed');
      await agent.getContextManager().switchBranch(mainBranch);
      const mainMessages = (agent.getContextManager() as unknown as {
        getAllMessages: () => Array<{ content: ContentBlock[] }>;
      }).getAllMessages();
      assert.equal(countMessagesContaining(mainMessages, RETRY_OUTPUT_SENTINEL), 0, 'source branch must not receive stale retry output');
    } finally {
      await framework.stop();
    }
  });

  it('keeps quarantine namespace-local across agents', async () => {
    const membrane = new ScriptedMembrane([
      [refusalResponse()],
      [outputResponse('agent-a retry success')],
    ]);
    const strategyA = new ProbeStrategy({
      compressionModel: 'same-model',
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
    });
    const strategyB = new ProbeStrategy({
      compressionModel: 'same-model',
      targetChunkTokens: 100,
      recentWindowTokens: 0,
      headWindowTokens: 0,
      autoTickOnNewMessage: false,
      minChunkCharsForLLM: 0,
      mergeThreshold: 99,
    });
    const { framework, agent, strategy } = await createFrameworkFixture({
      membrane,
      strategy: strategyA,
      extraAgents: [{ name: 'observer', strategy: strategyB }],
    });
    try {
      const observer = framework.getAgent('observer')!;
      const a = addSourcePair(agent, 'A');
      seedSummary(strategy, 'L1-A', a);
      seedSummary(strategyB, 'L1-A', a);
      addLatestPrompt(agent, 'baseline');
      addLatestPrompt(observer, 'baseline');
      await persistHealthyBaseline(framework, agent);

      const b = addSourcePair(agent, 'B');
      seedSummary(strategy, 'L1-B', b);
      seedSummary(strategyB, 'L1-B', b);
      addLatestPrompt(agent, 'current');
      addLatestPrompt(observer, 'current');

      await enqueueAndDrain(framework);

      assert.ok(primarySummaryQuarantineState(framework, 'assistant'));
      assert.equal(
        primarySummaryQuarantineState(framework, 'observer'),
        null,
        'another namespace must not inherit the retry quarantine',
      );
    } finally {
      await framework.stop();
    }
  });

  it('repairs a missing held placeholder on restart from the exact stored assistant settlement', async () => {
    const requestId = 'repair-request';
    const path = freshPath();
    const first = await createFrameworkFixture({ path, membrane: new ScriptedMembrane([]) });
    try {
      const branch = first.agent.getCurrentBranchGeneration()!;
      first.framework.getStore().setStateJson(FALLBACK_STATE_ID, {
        requests: [manualPrimaryRecord({
          requestId,
          finalStatus: 'refusal',
          branchId: branch.id,
          branchName: branch.name,
          branchGeneration: branch.generation,
        })],
      });
      first.agent.getContextManager().addMessage(
        'assistant',
        [
          { type: 'thinking', thinking: 'repair reasoning', signature: 'sig-repair' } as ContentBlock,
          { type: 'tool_use', id: 'repair-call', name: 'toolbox--echo', input: { message: FINAL_TOOL_ARG_SENTINEL } } as ContentBlock,
        ],
        settlementMetadata({
          requestId,
          holdReason: 'primary_summary_refusal_partial_output',
          stopReason: 'refusal',
          providerInputTokens: 40,
          visibleAssistantOutput: true,
          executedToolCalls: 0,
          branchId: branch.id,
          branchName: branch.name,
          branchGeneration: branch.generation,
          entryIndex: 0,
          entryCount: 2,
          role: 'assistant',
          kind: 'assistant_output',
        }),
      );
    } finally {
      await first.framework.stop();
    }

    const restarted = await createFrameworkFixture({ path, membrane: new ScriptedMembrane([]) });
    try {
      assert.equal(restarted.membrane.calls.length, 0);
      const settled = settlementMessages(restarted.agent, requestId);
      assert.equal(settled.length, 2);
      assert.equal(countMessagesContaining(settled, NON_EXECUTED_TOOL_RESULT), 1);
      const record = latestPrimaryRecord(restarted.framework, ['baseline-request']);
      assert.equal(record.finalStatus, 'held');
      assert.equal(record.fallbackHeldReason, 'primary_summary_refusal_partial_output');
    } finally {
      await restarted.framework.stop();
    }
  });

  it('finalizes an already-paired held settlement on restart without duplicating writes', async () => {
    const requestId = 'paired-request';
    const path = freshPath();
    const first = await createFrameworkFixture({ path, membrane: new ScriptedMembrane([]) });
    try {
      const branch = first.agent.getCurrentBranchGeneration()!;
      first.framework.getStore().setStateJson(FALLBACK_STATE_ID, {
        requests: [manualPrimaryRecord({
          requestId,
          finalStatus: 'refusal',
          branchId: branch.id,
          branchName: branch.name,
          branchGeneration: branch.generation,
        })],
      });
      first.agent.getContextManager().addMessage(
        'assistant',
        [{ type: 'tool_use', id: 'paired-call', name: 'toolbox--echo', input: { message: FINAL_TOOL_ARG_SENTINEL } } as ContentBlock],
        settlementMetadata({
          requestId,
          holdReason: 'primary_summary_refusal_partial_output',
          stopReason: 'refusal',
          providerInputTokens: 40,
          visibleAssistantOutput: true,
          executedToolCalls: 0,
          branchId: branch.id,
          branchName: branch.name,
          branchGeneration: branch.generation,
          entryIndex: 0,
          entryCount: 2,
          role: 'assistant',
          kind: 'assistant_output',
        }),
      );
      first.agent.getContextManager().addMessage(
        'user',
        [{ type: 'tool_result', toolUseId: 'paired-call', content: NON_EXECUTED_TOOL_RESULT, isError: true } as ContentBlock],
        settlementMetadata({
          requestId,
          holdReason: 'primary_summary_refusal_partial_output',
          stopReason: 'refusal',
          providerInputTokens: 40,
          visibleAssistantOutput: true,
          executedToolCalls: 0,
          branchId: branch.id,
          branchName: branch.name,
          branchGeneration: branch.generation,
          entryIndex: 1,
          entryCount: 2,
          role: 'user',
          kind: 'generated_tool_result',
        }),
      );
    } finally {
      await first.framework.stop();
    }

    const restarted = await createFrameworkFixture({ path, membrane: new ScriptedMembrane([]) });
    try {
      assert.equal(restarted.membrane.calls.length, 0);
      const settled = settlementMessages(restarted.agent, requestId);
      assert.equal(settled.length, 2);
      assert.equal(countMessagesContaining(settled, NON_EXECUTED_TOOL_RESULT), 1);
      const record = latestPrimaryRecord(restarted.framework, ['baseline-request']);
      assert.equal(record.finalStatus, 'held');
      assert.equal(record.fallbackHeldReason, 'primary_summary_refusal_partial_output');
    } finally {
      await restarted.framework.stop();
    }
  });

  it('does not let a historical identical block sequence satisfy a different request settlement', async () => {
    const path = freshPath();
    const first = await createFrameworkFixture({ path, membrane: new ScriptedMembrane([]) });
    try {
      const branch = first.agent.getCurrentBranchGeneration()!;
      first.framework.getStore().setStateJson(FALLBACK_STATE_ID, {
        requests: [
          manualPrimaryRecord({
            requestId: 'historical-request',
            finalStatus: 'held',
            fallbackHeldReason: 'primary_summary_refusal_partial_output',
            branchId: branch.id,
            branchName: branch.name,
            branchGeneration: branch.generation,
          }),
          manualPrimaryRecord({
            requestId: 'current-request',
            finalStatus: 'refusal',
            branchId: branch.id,
            branchName: branch.name,
            branchGeneration: branch.generation,
          }),
        ],
      });
      first.agent.getContextManager().addMessage(
        'assistant',
        [{ type: 'text', text: RETRY_OUTPUT_SENTINEL }],
        settlementMetadata({
          requestId: 'historical-request',
          holdReason: 'primary_summary_refusal_partial_output',
          stopReason: 'refusal',
          branchId: branch.id,
          branchName: branch.name,
          branchGeneration: branch.generation,
          entryIndex: 0,
          entryCount: 1,
          role: 'assistant',
          kind: 'assistant_output',
        }),
      );
    } finally {
      await first.framework.stop();
    }

    const restarted = await createFrameworkFixture({ path, membrane: new ScriptedMembrane([]) });
    try {
      assert.equal(restarted.membrane.calls.length, 0);
      assert.equal(settlementMessages(restarted.agent, 'current-request').length, 0);
      const current = fallbackRecords(restarted.framework).find((record) => record.requestId === 'current-request')!;
      assert.equal(current.finalStatus, 'held');
      assert.equal(current.fallbackHeldReason, 'primary_summary_request_unresolved_on_restart');
    } finally {
      await restarted.framework.stop();
    }
  });

  it('fails closed on restart when settlement metadata branch generation mismatches the request record', async () => {
    const requestId = 'branch-mismatch-request';
    const path = freshPath();
    const first = await createFrameworkFixture({ path, membrane: new ScriptedMembrane([]) });
    try {
      first.framework.getStore().setStateJson(FALLBACK_STATE_ID, {
        requests: [manualPrimaryRecord({ requestId, finalStatus: 'refusal', branchGeneration: 2 })],
      });
      first.agent.getContextManager().addMessage(
        'assistant',
        [{ type: 'text', text: RETRY_OUTPUT_SENTINEL }],
        settlementMetadata({
          requestId,
          holdReason: 'primary_summary_refusal_partial_output',
          stopReason: 'refusal',
          branchGeneration: 1,
          entryIndex: 0,
          entryCount: 1,
          role: 'assistant',
          kind: 'assistant_output',
        }),
      );
    } finally {
      await first.framework.stop();
    }

    const restarted = await createFrameworkFixture({ path, membrane: new ScriptedMembrane([]) });
    try {
      assert.equal(restarted.membrane.calls.length, 0);
      const current = fallbackRecords(restarted.framework).find((record) => record.requestId === requestId)!;
      assert.equal(current.finalStatus, 'held');
      assert.equal(current.fallbackHeldReason, 'primary_summary_settlement_branch_mismatch_on_restart');
      assert.equal(settlementMessages(restarted.agent, requestId).length, 1, 'restart must not rewrite or finalize against the wrong branch generation');
    } finally {
      await restarted.framework.stop();
    }
  });

  it('finalizes a long partial-text held settlement written as ingress shards exactly once on restart', async () => {
    const requestId = 'sharded-partial-text-request';
    const path = freshPath();
    let assistantShardCount = 0;
    const first = await createFrameworkFixture({
      path,
      membrane: new ScriptedMembrane([]),
      strategy: shardingStrategy(),
    });
    try {
      const branch = first.agent.getCurrentBranchGeneration()!;
      first.framework.getStore().setStateJson(FALLBACK_STATE_ID, {
        requests: [manualPrimaryRecord({
          requestId,
          finalStatus: 'refusal',
          branchId: branch.id,
          branchName: branch.name,
          branchGeneration: branch.generation,
        })],
      });
      first.agent.getContextManager().addMessage(
        'assistant',
        [{ type: 'text', text: longShardText('long-held-text') }],
        settlementMetadata({
          requestId,
          holdReason: 'primary_summary_refusal_partial_output',
          stopReason: 'refusal',
          providerInputTokens: 40,
          visibleAssistantOutput: true,
          executedToolCalls: 0,
          branchId: branch.id,
          branchName: branch.name,
          branchGeneration: branch.generation,
          entryIndex: 0,
          entryCount: 1,
          role: 'assistant',
          kind: 'assistant_output',
        }),
      );
      const persisted = settlementMessages(first.agent, requestId);
      assistantShardCount = persisted.length;
      assert.ok(assistantShardCount > 1, 'assistant settlement must shard physically');
      assert.ok(persisted.every((message, index) =>
        message.bodyGroupId === persisted[0]!.bodyGroupId && message.shardIndex === index));
    } finally {
      await first.framework.stop();
    }

    const restarted = await createFrameworkFixture({
      path,
      membrane: new ScriptedMembrane([]),
      strategy: shardingStrategy(),
    });
    try {
      assert.equal(restarted.membrane.calls.length, 0);
      const settled = settlementMessages(restarted.agent, requestId);
      assert.equal(settled.length, assistantShardCount);
      assert.equal(countMessagesContaining(settled, NON_EXECUTED_TOOL_RESULT), 0);
      const record = fallbackRecords(restarted.framework).find((entry) => entry.requestId === requestId)!;
      assert.equal(record.finalStatus, 'held');
      assert.equal(record.fallbackHeldReason, 'primary_summary_refusal_partial_output');
    } finally {
      await restarted.framework.stop();
    }
  });

  it('repairs one missing placeholder after a sharded assistant settlement restart and never executes refused tools', async () => {
    const requestId = 'sharded-placeholder-repair-request';
    const path = freshPath();
    let assistantShardCount = 0;
    const first = await createFrameworkFixture({
      path,
      membrane: new ScriptedMembrane([]),
      strategy: shardingStrategy(),
    });
    try {
      const branch = first.agent.getCurrentBranchGeneration()!;
      first.framework.getStore().setStateJson(FALLBACK_STATE_ID, {
        requests: [manualPrimaryRecord({
          requestId,
          finalStatus: 'refusal',
          branchId: branch.id,
          branchName: branch.name,
          branchGeneration: branch.generation,
        })],
      });
      first.agent.getContextManager().addMessage(
        'assistant',
        [
          { type: 'thinking', thinking: 'repair reasoning', signature: 'sig-sharded-repair' } as ContentBlock,
          { type: 'tool_use', id: 'repair-call', name: 'toolbox--echo', input: { message: FINAL_TOOL_ARG_SENTINEL } } as ContentBlock,
          { type: 'text', text: longShardText('repair-placeholder') },
        ],
        settlementMetadata({
          requestId,
          holdReason: 'primary_summary_refusal_partial_output',
          stopReason: 'refusal',
          providerInputTokens: 40,
          visibleAssistantOutput: true,
          executedToolCalls: 0,
          branchId: branch.id,
          branchName: branch.name,
          branchGeneration: branch.generation,
          entryIndex: 0,
          entryCount: 2,
          role: 'assistant',
          kind: 'assistant_output',
        }),
      );
      assistantShardCount = settlementMessages(first.agent, requestId).length;
      assert.ok(assistantShardCount > 1, 'assistant settlement must shard physically');
    } finally {
      await first.framework.stop();
    }

    const module = new EchoModule(() => false);
    const restarted = await createFrameworkFixture({
      path,
      membrane: new ScriptedMembrane([]),
      modules: [module],
      strategy: shardingStrategy(),
    });
    try {
      assert.equal(restarted.membrane.calls.length, 0);
      assert.equal(module.calls.length, 0, 'restart repair must not execute refused tools');
      const settled = settlementMessages(restarted.agent, requestId);
      assert.equal(settled.length, assistantShardCount + 1);
      const placeholders = settled.filter((message) => message.participant === 'user');
      assert.equal(placeholders.length, 1);
      const placeholder = placeholders[0]!.content[0] as ContentBlock & {
        type: 'tool_result';
        toolUseId: string;
        content: string;
        isError?: boolean;
      };
      assert.equal(placeholder.type, 'tool_result');
      assert.equal(placeholder.toolUseId, 'repair-call');
      assert.equal(placeholder.content, NON_EXECUTED_TOOL_RESULT);
      assert.equal(placeholder.isError, true);
      const record = fallbackRecords(restarted.framework).find((entry) => entry.requestId === requestId)!;
      assert.equal(record.finalStatus, 'held');
      assert.equal(record.fallbackHeldReason, 'primary_summary_refusal_partial_output');
    } finally {
      await restarted.framework.stop();
    }
  });

  it('finalizes a complete sharded assistant plus placeholder settlement on restart without duplicate writes or effects', async () => {
    const requestId = 'sharded-complete-request';
    const path = freshPath();
    let persistedCount = 0;
    const first = await createFrameworkFixture({
      path,
      membrane: new ScriptedMembrane([]),
      strategy: shardingStrategy(),
    });
    try {
      const branch = first.agent.getCurrentBranchGeneration()!;
      first.framework.getStore().setStateJson(FALLBACK_STATE_ID, {
        requests: [manualPrimaryRecord({
          requestId,
          finalStatus: 'refusal',
          branchId: branch.id,
          branchName: branch.name,
          branchGeneration: branch.generation,
        })],
      });
      first.agent.getContextManager().addMessage(
        'assistant',
        [
          { type: 'thinking', thinking: 'paired reasoning', signature: 'sig-sharded-paired' } as ContentBlock,
          { type: 'tool_use', id: 'paired-call', name: 'toolbox--echo', input: { message: FINAL_TOOL_ARG_SENTINEL } } as ContentBlock,
          { type: 'text', text: longShardText('paired-placeholder') },
        ],
        settlementMetadata({
          requestId,
          holdReason: 'primary_summary_refusal_partial_output',
          stopReason: 'refusal',
          providerInputTokens: 40,
          visibleAssistantOutput: true,
          executedToolCalls: 0,
          branchId: branch.id,
          branchName: branch.name,
          branchGeneration: branch.generation,
          entryIndex: 0,
          entryCount: 2,
          role: 'assistant',
          kind: 'assistant_output',
        }),
      );
      first.agent.getContextManager().addMessage(
        'user',
        [{ type: 'tool_result', toolUseId: 'paired-call', content: NON_EXECUTED_TOOL_RESULT, isError: true } as ContentBlock],
        settlementMetadata({
          requestId,
          holdReason: 'primary_summary_refusal_partial_output',
          stopReason: 'refusal',
          providerInputTokens: 40,
          visibleAssistantOutput: true,
          executedToolCalls: 0,
          branchId: branch.id,
          branchName: branch.name,
          branchGeneration: branch.generation,
          entryIndex: 1,
          entryCount: 2,
          role: 'user',
          kind: 'generated_tool_result',
        }),
      );
      persistedCount = settlementMessages(first.agent, requestId).length;
      assert.ok(persistedCount > 2, 'assistant shards plus the placeholder must be persisted');
    } finally {
      await first.framework.stop();
    }

    const module = new EchoModule(() => false);
    const restarted = await createFrameworkFixture({
      path,
      membrane: new ScriptedMembrane([]),
      modules: [module],
      strategy: shardingStrategy(),
    });
    try {
      assert.equal(restarted.membrane.calls.length, 0);
      assert.equal(module.calls.length, 0);
      const settled = settlementMessages(restarted.agent, requestId);
      assert.equal(settled.length, persistedCount);
      assert.equal(countMessagesContaining(settled, NON_EXECUTED_TOOL_RESULT), 1);
      const record = fallbackRecords(restarted.framework).find((entry) => entry.requestId === requestId)!;
      assert.equal(record.finalStatus, 'held');
      assert.equal(record.fallbackHeldReason, 'primary_summary_refusal_partial_output');
    } finally {
      await restarted.framework.stop();
    }
  });

  it('fails closed on restart for invalid sharded settlement layouts', async () => {
    const cases: Array<{
      name: string;
      expectedReason: string;
      persist: (fixture: Awaited<ReturnType<typeof createFrameworkFixture>>, requestId: string) => void;
    }> = [
      {
        name: 'missing shard',
        expectedReason: 'primary_summary_settlement_shard_group_invalid_on_restart',
        persist: (fixture, requestId) => {
          const branch = fixture.agent.getCurrentBranchGeneration()!;
          const metadata = settlementMetadata({
            requestId,
            holdReason: 'primary_summary_refusal_partial_output',
            stopReason: 'refusal',
            branchId: branch.id,
            branchName: branch.name,
            branchGeneration: branch.generation,
            entryIndex: 0,
            entryCount: 1,
            role: 'assistant',
            kind: 'assistant_output',
          });
          const shards = shardIngressContent(fixture.strategy, 'assistant', [{ type: 'text', text: longShardText('missing-shard-case') }]);
          assert.ok(shards.shards.length > 2);
          appendPhysicalMessage(fixture.agent, 'assistant', shards.shards[0]!.content, metadata, {
            bodyGroupId: shards.bodyGroupId,
            shardIndex: 0,
          });
          appendPhysicalMessage(fixture.agent, 'assistant', shards.shards[2]!.content, metadata, {
            bodyGroupId: shards.bodyGroupId,
            shardIndex: 2,
          });
        },
      },
      {
        name: 'duplicate shard index',
        expectedReason: 'primary_summary_settlement_shard_group_invalid_on_restart',
        persist: (fixture, requestId) => {
          const branch = fixture.agent.getCurrentBranchGeneration()!;
          const metadata = settlementMetadata({
            requestId,
            holdReason: 'primary_summary_refusal_partial_output',
            stopReason: 'refusal',
            branchId: branch.id,
            branchName: branch.name,
            branchGeneration: branch.generation,
            entryIndex: 0,
            entryCount: 1,
            role: 'assistant',
            kind: 'assistant_output',
          });
          const shards = shardIngressContent(fixture.strategy, 'assistant', [{ type: 'text', text: longShardText('duplicate-shard-case') }]);
          appendPhysicalMessage(fixture.agent, 'assistant', shards.shards[0]!.content, metadata, {
            bodyGroupId: shards.bodyGroupId,
            shardIndex: 0,
          });
          appendPhysicalMessage(fixture.agent, 'assistant', shards.shards[1]!.content, metadata, {
            bodyGroupId: shards.bodyGroupId,
            shardIndex: 0,
          });
        },
      },
      {
        name: 'noncontiguous interleaved shard group',
        expectedReason: 'primary_summary_settlement_shard_group_invalid_on_restart',
        persist: (fixture, requestId) => {
          const branch = fixture.agent.getCurrentBranchGeneration()!;
          const metadata = settlementMetadata({
            requestId,
            holdReason: 'primary_summary_refusal_partial_output',
            stopReason: 'refusal',
            branchId: branch.id,
            branchName: branch.name,
            branchGeneration: branch.generation,
            entryIndex: 0,
            entryCount: 1,
            role: 'assistant',
            kind: 'assistant_output',
          });
          const shards = shardIngressContent(fixture.strategy, 'assistant', [{ type: 'text', text: longShardText('interleaved-shard-case') }]);
          appendPhysicalMessage(fixture.agent, 'assistant', shards.shards[0]!.content, metadata, {
            bodyGroupId: shards.bodyGroupId,
            shardIndex: 0,
          });
          fixture.agent.getContextManager().addMessage('User', [{ type: 'text', text: 'interleaved unrelated record' }]);
          appendPhysicalMessage(fixture.agent, 'assistant', shards.shards[1]!.content, metadata, {
            bodyGroupId: shards.bodyGroupId,
            shardIndex: 1,
          });
        },
      },
      {
        name: 'conflicting envelope',
        expectedReason: 'primary_summary_settlement_shard_group_invalid_on_restart',
        persist: (fixture, requestId) => {
          const branch = fixture.agent.getCurrentBranchGeneration()!;
          const metadata = settlementMetadata({
            requestId,
            holdReason: 'primary_summary_refusal_partial_output',
            stopReason: 'refusal',
            branchId: branch.id,
            branchName: branch.name,
            branchGeneration: branch.generation,
            entryIndex: 0,
            entryCount: 1,
            role: 'assistant',
            kind: 'assistant_output',
          });
          const conflictingMetadata = settlementMetadata({
            requestId,
            settlementId: 'conflicting:v1',
            holdReason: 'primary_summary_refusal_partial_output',
            stopReason: 'refusal',
            branchId: branch.id,
            branchName: branch.name,
            branchGeneration: branch.generation,
            entryIndex: 0,
            entryCount: 1,
            role: 'assistant',
            kind: 'assistant_output',
          });
          const shards = shardIngressContent(fixture.strategy, 'assistant', [{ type: 'text', text: longShardText('conflicting-envelope-case') }]);
          appendPhysicalMessage(fixture.agent, 'assistant', shards.shards[0]!.content, metadata, {
            bodyGroupId: shards.bodyGroupId,
            shardIndex: 0,
          });
          appendPhysicalMessage(fixture.agent, 'assistant', shards.shards[1]!.content, conflictingMetadata, {
            bodyGroupId: shards.bodyGroupId,
            shardIndex: 1,
          });
        },
      },
      {
        name: 'cross participant shard',
        expectedReason: 'primary_summary_settlement_shard_group_invalid_on_restart',
        persist: (fixture, requestId) => {
          const branch = fixture.agent.getCurrentBranchGeneration()!;
          const metadata = settlementMetadata({
            requestId,
            holdReason: 'primary_summary_refusal_partial_output',
            stopReason: 'refusal',
            branchId: branch.id,
            branchName: branch.name,
            branchGeneration: branch.generation,
            entryIndex: 0,
            entryCount: 1,
            role: 'assistant',
            kind: 'assistant_output',
          });
          const shards = shardIngressContent(fixture.strategy, 'assistant', [{ type: 'text', text: longShardText('cross-participant-case') }]);
          appendPhysicalMessage(fixture.agent, 'assistant', shards.shards[0]!.content, metadata, {
            bodyGroupId: shards.bodyGroupId,
            shardIndex: 0,
          });
          appendPhysicalMessage(fixture.agent, 'user', shards.shards[1]!.content, metadata, {
            bodyGroupId: shards.bodyGroupId,
            shardIndex: 1,
          });
        },
      },
      {
        name: 'unsharded plus sharded duplicate entry index',
        expectedReason: 'primary_summary_settlement_duplicate_entry_on_restart',
        persist: (fixture, requestId) => {
          const branch = fixture.agent.getCurrentBranchGeneration()!;
          const metadata = settlementMetadata({
            requestId,
            holdReason: 'primary_summary_refusal_partial_output',
            stopReason: 'refusal',
            branchId: branch.id,
            branchName: branch.name,
            branchGeneration: branch.generation,
            entryIndex: 0,
            entryCount: 1,
            role: 'assistant',
            kind: 'assistant_output',
          });
          fixture.agent.getContextManager().addMessage(
            'assistant',
            [{ type: 'text', text: longShardText('duplicate-entry-case') }],
            metadata,
          );
          fixture.agent.getContextManager().addMessage(
            'assistant',
            [{ type: 'text', text: 'duplicate logical entry' }],
            metadata,
          );
        },
      },
    ];

    for (const testCase of cases) {
      const requestId = `invalid-layout-${testCase.name.replace(/[^a-z]+/gi, '-')}`;
      const path = freshPath();
      const first = await createFrameworkFixture({
        path,
        membrane: new ScriptedMembrane([]),
        strategy: shardingStrategy(),
      });
      try {
        const branch = first.agent.getCurrentBranchGeneration()!;
        first.framework.getStore().setStateJson(FALLBACK_STATE_ID, {
          requests: [manualPrimaryRecord({
            requestId,
            finalStatus: 'refusal',
            branchId: branch.id,
            branchName: branch.name,
            branchGeneration: branch.generation,
          })],
        });
        testCase.persist(first, requestId);
      } finally {
        await first.framework.stop();
      }

      const restarted = await createFrameworkFixture({
        path,
        membrane: new ScriptedMembrane([]),
        strategy: shardingStrategy(),
      });
      try {
        assert.equal(restarted.membrane.calls.length, 0, `${testCase.name}: restart must not redispatch the provider`);
        const current = fallbackRecords(restarted.framework).find((record) => record.requestId === requestId)!;
        assert.equal(current.finalStatus, 'held', testCase.name);
        assert.equal(current.fallbackHeldReason, testCase.expectedReason, testCase.name);
      } finally {
        await restarted.framework.stop();
      }
    }
  });

  it('does not let historical identical sharded content under another request satisfy the current settlement', async () => {
    const path = freshPath();
    const first = await createFrameworkFixture({
      path,
      membrane: new ScriptedMembrane([]),
      strategy: shardingStrategy(),
    });
    try {
      const branch = first.agent.getCurrentBranchGeneration()!;
      first.framework.getStore().setStateJson(FALLBACK_STATE_ID, {
        requests: [
          manualPrimaryRecord({
            requestId: 'historical-sharded-request',
            finalStatus: 'held',
            fallbackHeldReason: 'primary_summary_refusal_partial_output',
            branchId: branch.id,
            branchName: branch.name,
            branchGeneration: branch.generation,
          }),
          manualPrimaryRecord({
            requestId: 'current-sharded-request',
            finalStatus: 'refusal',
            branchId: branch.id,
            branchName: branch.name,
            branchGeneration: branch.generation,
          }),
        ],
      });
      first.agent.getContextManager().addMessage(
        'assistant',
        [{ type: 'text', text: longShardText('historical-identical-content') }],
        settlementMetadata({
          requestId: 'historical-sharded-request',
          holdReason: 'primary_summary_refusal_partial_output',
          stopReason: 'refusal',
          branchId: branch.id,
          branchName: branch.name,
          branchGeneration: branch.generation,
          entryIndex: 0,
          entryCount: 1,
          role: 'assistant',
          kind: 'assistant_output',
        }),
      );
      assert.ok(settlementMessages(first.agent, 'historical-sharded-request').length > 1);
    } finally {
      await first.framework.stop();
    }

    const restarted = await createFrameworkFixture({
      path,
      membrane: new ScriptedMembrane([]),
      strategy: shardingStrategy(),
    });
    try {
      assert.equal(restarted.membrane.calls.length, 0);
      assert.equal(settlementMessages(restarted.agent, 'current-sharded-request').length, 0);
      const current = fallbackRecords(restarted.framework).find((record) => record.requestId === 'current-sharded-request')!;
      assert.equal(current.finalStatus, 'held');
      assert.equal(current.fallbackHeldReason, 'primary_summary_request_unresolved_on_restart');
    } finally {
      await restarted.framework.stop();
    }
  });

  it('repairs exactly one truthful placeholder result per tool_use on shard 0', async () => {
    const requestId = 'multi-tool-use-request';
    const path = freshPath();
    const first = await createFrameworkFixture({
      path,
      membrane: new ScriptedMembrane([]),
      strategy: shardingStrategy(),
    });
    try {
      const branch = first.agent.getCurrentBranchGeneration()!;
      first.framework.getStore().setStateJson(FALLBACK_STATE_ID, {
        requests: [manualPrimaryRecord({
          requestId,
          finalStatus: 'refusal',
          branchId: branch.id,
          branchName: branch.name,
          branchGeneration: branch.generation,
        })],
      });
      first.agent.getContextManager().addMessage(
        'assistant',
        [
          { type: 'thinking', thinking: 'multi-tool reasoning', signature: 'sig-multi-tool' } as ContentBlock,
          { type: 'tool_use', id: 'call-a', name: 'toolbox--echo', input: { message: 'a' } } as ContentBlock,
          { type: 'tool_use', id: 'call-b', name: 'toolbox--echo', input: { message: 'b' } } as ContentBlock,
          { type: 'text', text: longShardText('multi-tool-placeholder') },
        ],
        settlementMetadata({
          requestId,
          holdReason: 'primary_summary_refusal_partial_output',
          stopReason: 'refusal',
          providerInputTokens: 40,
          visibleAssistantOutput: true,
          executedToolCalls: 0,
          branchId: branch.id,
          branchName: branch.name,
          branchGeneration: branch.generation,
          entryIndex: 0,
          entryCount: 2,
          role: 'assistant',
          kind: 'assistant_output',
        }),
      );
      const shards = settlementMessages(first.agent, requestId);
      assert.ok(shards.length > 1);
      assert.equal(
        shards.filter((message) => message.content.some((block) => block.type === 'tool_use')).length,
        1,
        'all tool_use blocks must stay on shard 0',
      );
    } finally {
      await first.framework.stop();
    }

    const restarted = await createFrameworkFixture({
      path,
      membrane: new ScriptedMembrane([]),
      strategy: shardingStrategy(),
    });
    try {
      const placeholders = settlementMessages(restarted.agent, requestId)
        .filter((message) => message.participant === 'user');
      assert.equal(placeholders.length, 1);
      const results = placeholders[0]!.content.filter((block): block is ContentBlock & {
        type: 'tool_result';
        toolUseId: string;
        content: string;
        isError?: boolean;
      } => block.type === 'tool_result');
      assert.equal(results.length, 2);
      assert.deepEqual(results.map((block) => block.toolUseId), ['call-a', 'call-b']);
      assert.ok(results.every((block) => block.content === NON_EXECUTED_TOOL_RESULT && block.isError === true));
    } finally {
      await restarted.framework.stop();
    }
  });

  it('fails closed on malformed optional and numeric settlement metadata without copying bad values into durable state or logs', async () => {
    const oversizedStopReason = `OVERSIZED_STOP_REASON_SENTINEL_${'x'.repeat(320)}`;
    const cases: Array<{
      name: string;
      mutate: (metadata: Record<string, unknown>) => void;
      forbidden?: string;
    }> = [
      {
        name: 'oversized stopReason',
        mutate: (metadata) => {
          ((metadata[PRIMARY_SUMMARY_SETTLEMENT_METADATA_KEY] as Record<string, unknown>).stopReason) = oversizedStopReason;
        },
        forbidden: oversizedStopReason,
      },
      {
        name: 'missing held holdReason',
        mutate: (metadata) => {
          delete (metadata[PRIMARY_SUMMARY_SETTLEMENT_METADATA_KEY] as Record<string, unknown>).holdReason;
        },
      },
      {
        name: 'unsafe providerInputTokens',
        mutate: (metadata) => {
          ((metadata[PRIMARY_SUMMARY_SETTLEMENT_METADATA_KEY] as Record<string, unknown>).providerInputTokens) = Number.MAX_SAFE_INTEGER + 1;
        },
      },
      {
        name: 'negative executedToolCalls',
        mutate: (metadata) => {
          ((metadata[PRIMARY_SUMMARY_SETTLEMENT_METADATA_KEY] as Record<string, unknown>).executedToolCalls) = -1;
        },
      },
      {
        name: 'negative branch generation',
        mutate: (metadata) => {
          (((metadata[PRIMARY_SUMMARY_SETTLEMENT_METADATA_KEY] as Record<string, unknown>).branch as Record<string, unknown>).generation) = -1;
        },
      },
    ];

    for (const testCase of cases) {
      const requestId = `malformed-metadata-${testCase.name.replace(/[^a-z]+/gi, '-')}`;
      const path = freshPath();
      const first = await createFrameworkFixture({
        path,
        membrane: new ScriptedMembrane([]),
        strategy: shardingStrategy(),
      });
      try {
        const branch = first.agent.getCurrentBranchGeneration()!;
        first.framework.getStore().setStateJson(FALLBACK_STATE_ID, {
          requests: [manualPrimaryRecord({
            requestId,
            finalStatus: 'refusal',
            branchId: branch.id,
            branchName: branch.name,
            branchGeneration: branch.generation,
          })],
        });
        const metadata = settlementMetadata({
          requestId,
          holdReason: 'primary_summary_refusal_partial_output',
          stopReason: 'refusal',
          providerInputTokens: 40,
          visibleAssistantOutput: true,
          executedToolCalls: 0,
          branchId: branch.id,
          branchName: branch.name,
          branchGeneration: branch.generation,
          entryIndex: 0,
          entryCount: 1,
          role: 'assistant',
          kind: 'assistant_output',
        });
        testCase.mutate(metadata);
        first.agent.getContextManager().addMessage(
          'assistant',
          [{ type: 'text', text: longShardText(`malformed-${testCase.name}`) }],
          metadata,
        );
      } finally {
        await first.framework.stop();
      }

      const restarted = await createFrameworkFixture({
        path,
        membrane: new ScriptedMembrane([]),
        strategy: shardingStrategy(),
      });
      try {
        const current = fallbackRecords(restarted.framework).find((record) => record.requestId === requestId)!;
        assert.equal(current.finalStatus, 'held', testCase.name);
        assert.equal(current.fallbackHeldReason, 'primary_summary_settlement_metadata_invalid_on_restart', testCase.name);
        assert.equal(current.stopReason, 'refusal', testCase.name);
        assert.equal(current.providerInputTokens, 40, testCase.name);
        assert.equal(current.executedToolCalls, 0, testCase.name);
        if (testCase.forbidden) {
          assert.equal(jsonContains(fallbackState(restarted.framework), testCase.forbidden), false, testCase.name);
          assert.equal(jsonContains(restarted.framework.healthSnapshot(), testCase.forbidden), false, testCase.name);
          assert.equal(jsonContains(restarted.framework.queryInferenceLogs({ limit: 25 }), testCase.forbidden), false, testCase.name);
          assert.equal(jsonContains(restarted.framework.queryProcessLogs({ limit: 25 }), testCase.forbidden), false, testCase.name);
        }
      } finally {
        await restarted.framework.stop();
      }
    }
  });

  describe('crash phases', () => {
    async function setupTextRetryScenario() {
      const membrane = new ScriptedMembrane([
        [refusalResponse()],
        [outputResponse()],
      ]);
      const fixture = await createFrameworkFixture({ membrane });
      const { framework, agent, strategy } = fixture;
      const a = addSourcePair(agent, 'A');
      seedSummary(strategy, 'L1-A', a);
      addLatestPrompt(agent, 'baseline');
      await persistHealthyBaseline(framework, agent);
      const b = addSourcePair(agent, 'B');
      seedSummary(strategy, 'L1-B', b);
      addLatestPrompt(agent, 'current');
      return fixture;
    }

    async function setupToolRetryScenario() {
      const module = new EchoModule(() => true);
      const membrane = new ScriptedMembrane([
        [refusalResponse()],
        [toolRoundResponse(), outputResponse()],
      ]);
      const fixture = await createFrameworkFixture({ membrane, modules: [module] });
      const { framework, agent, strategy } = fixture;
      const a = addSourcePair(agent, 'A');
      seedSummary(strategy, 'L1-A', a);
      addLatestPrompt(agent, 'baseline');
      await persistHealthyBaseline(framework, agent);
      const b = addSourcePair(agent, 'B');
      seedSummary(strategy, 'L1-B', b);
      addLatestPrompt(agent, 'current');
      return { ...fixture, module };
    }

    it('holds on restart if the process crashes after the provider response is obtained', async () => {
      const { path, framework, agent } = await setupTextRetryScenario();
      try {
        const manager = agent.getContextManager() as unknown as {
          quarantinePrimarySummaryForPrimaryLane: (...args: unknown[]) => Promise<void>;
        };
        const original = manager.quarantinePrimarySummaryForPrimaryLane.bind(manager);
        manager.quarantinePrimarySummaryForPrimaryLane = async (...args: unknown[]) => {
          throw new Error('crash-before-quarantine');
        };
        await enqueueAndDrain(framework);
        assert.equal(countMessagesContaining((manager as unknown as {
          getAllMessages: () => Array<{ content: ContentBlock[] }>;
        }).getAllMessages(), RETRY_OUTPUT_SENTINEL), 0);
        manager.quarantinePrimarySummaryForPrimaryLane = original;
      } finally {
        await framework.stop();
      }

      const restarted = await createFrameworkFixture({ path, membrane: new ScriptedMembrane([]) });
      try {
        assert.equal(restarted.membrane.calls.length, 0);
        const original = latestPrimaryRecord(restarted.framework);
        assert.equal(original.fallbackStatus, 'held');
      } finally {
        await restarted.framework.stop();
      }
    });

    it('holds on restart if the process crashes after quarantine is persisted', async () => {
      const { path, framework, agent } = await setupTextRetryScenario();
      try {
        const manager = agent.getContextManager() as unknown as {
          quarantinePrimarySummaryForPrimaryLane: (...args: unknown[]) => Promise<void>;
        };
        const original = manager.quarantinePrimarySummaryForPrimaryLane.bind(manager);
        manager.quarantinePrimarySummaryForPrimaryLane = async (...args: unknown[]) => {
          await original(...args);
          throw new Error('crash-after-quarantine');
        };
        await enqueueAndDrain(framework);
        manager.quarantinePrimarySummaryForPrimaryLane = original;
      } finally {
        await framework.stop();
      }

      const restarted = await createFrameworkFixture({ path, membrane: new ScriptedMembrane([]) });
      try {
        assert.equal(restarted.membrane.calls.length, 0);
        assert.equal(jsonContains(primarySummaryQuarantineState(restarted.framework, 'assistant'), 'L1-B'), true);
        const messages = (restarted.agent!.getContextManager() as unknown as {
          getAllMessages: () => Array<{ content: ContentBlock[] }>;
        }).getAllMessages();
        assert.equal(countMessagesContaining(messages, RETRY_OUTPUT_SENTINEL), 0);
      } finally {
        await restarted.framework.stop();
      }
    });

    it('holds on restart if the process crashes after assistant output is persisted', async () => {
      const { path, framework, agent } = await setupTextRetryScenario();
      try {
        const manager = agent.getContextManager() as unknown as {
          addMessage: (...args: unknown[]) => string;
        };
        const original = manager.addMessage.bind(manager);
        manager.addMessage = (...args: unknown[]) => {
          const messageId = original(...args);
          if (typeof args[0] === 'string' && args[0] === agent.name && jsonContains(args[1], RETRY_OUTPUT_SENTINEL)) {
            throw new Error('crash-after-output');
          }
          return messageId;
        };
        await enqueueAndDrain(framework);
        manager.addMessage = original;
      } finally {
        await framework.stop();
      }

      const restarted = await createFrameworkFixture({ path, membrane: new ScriptedMembrane([]) });
      try {
        const messages = (restarted.agent!.getContextManager() as unknown as {
          getAllMessages: () => Array<{ content: ContentBlock[] }>;
        }).getAllMessages();
        assert.equal(countMessagesContaining(messages, RETRY_OUTPUT_SENTINEL), 1);
        const original = latestPrimaryRecord(restarted.framework);
        assert.equal(original.fallbackStatus, 'held');
      } finally {
        await restarted.framework.stop();
      }
    });

    it('preserves success after a post-success crash and never resends on restart', async () => {
      const { path, framework } = await setupTextRetryScenario();
      try {
        const registry = (framework as unknown as {
          moduleRegistry: { dispatchSpeech: (...args: unknown[]) => Promise<void> };
        }).moduleRegistry;
        const original = registry.dispatchSpeech.bind(registry);
        registry.dispatchSpeech = async (...args: unknown[]) => {
          throw new Error('crash-after-success-markers');
        };
        await enqueueAndDrain(framework);
        registry.dispatchSpeech = original;
      } finally {
        await framework.stop();
      }

      const restarted = await createFrameworkFixture({ path, membrane: new ScriptedMembrane([]) });
      try {
        assert.equal(restarted.membrane.calls.length, 0);
        const retry = fallbackRetryRecords(restarted.framework).at(-1)!;
        const original = latestPrimaryRecord(restarted.framework);
        assert.equal(retry.finalStatus, 'success');
        assert.equal(original.fallbackStatus, 'success');
      } finally {
        await restarted.framework.stop();
      }
    });

    it('holds without executing a tool if the process crashes before tool dispatch', async () => {
      const { path, framework, module } = await setupToolRetryScenario();
      try {
        const original = (framework as unknown as {
          dispatchToolCall: (agentName: string, call: ToolCall) => void;
        }).dispatchToolCall.bind(framework);
        (framework as unknown as {
          dispatchToolCall: (agentName: string, call: ToolCall) => void;
        }).dispatchToolCall = (_agentName: string, _call: ToolCall) => {
          throw new Error('crash-before-tool-dispatch');
        };
        await enqueueAndDrain(framework);
        assert.equal(module.calls.length, 0);
      } finally {
        await framework.stop();
      }

      const restarted = await createFrameworkFixture({ path, membrane: new ScriptedMembrane([]) });
      try {
        assert.equal(restarted.membrane.calls.length, 0);
        const original = latestPrimaryRecord(restarted.framework);
        assert.equal(original.fallbackStatus, 'held');
      } finally {
        await restarted.framework.stop();
      }
    });

    it('holds without executing a tool if the process crashes after the tool dispatch record is persisted', async () => {
      const { path, framework, module } = await setupToolRetryScenario();
      try {
        const original = (framework as unknown as {
          recordPrimarySummaryRetryToolDispatch: (...args: unknown[]) => Promise<void>;
        }).recordPrimarySummaryRetryToolDispatch.bind(framework);
        (framework as unknown as {
          recordPrimarySummaryRetryToolDispatch: (...args: unknown[]) => Promise<void>;
        }).recordPrimarySummaryRetryToolDispatch = async (...args: unknown[]) => {
          await original(...args);
          throw new Error('crash-after-tool-dispatch-record');
        };
        await enqueueAndDrain(framework);
        assert.equal(module.calls.length, 0);
      } finally {
        await framework.stop();
      }

      const restarted = await createFrameworkFixture({ path, membrane: new ScriptedMembrane([]) });
      try {
        const original = latestPrimaryRecord(restarted.framework);
        const retry = fallbackRetryRecords(restarted.framework).at(-1)!;
        assert.equal(restarted.membrane.calls.length, 0);
        assert.equal(original.fallbackStatus, 'held');
        assert.equal(jsonContains(retry, 'call-1'), false, 'retry record should only keep hashed dispatch metadata');
      } finally {
        await restarted.framework.stop();
      }
    });
  });
});
