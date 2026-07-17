import type { Membrane, NormalizedMessage, NormalizedRequest, ContentBlock, YieldingStream } from '@animalabs/membrane';
import { isAbortedResponse } from '@animalabs/membrane';
import { createHash } from 'node:crypto';
import { toolResultDataToHistoryString } from './tool-result-history.js';

export interface ActivationCompileArtifacts {
  compileResult: CompileResult;
  contract: PrimarySummaryContract & {
    systemHash: string;
  };
}

export interface StartStreamResult {
  stream: YieldingStream;
  request: NormalizedRequest;
  artifacts: ActivationCompileArtifacts;
}
import type {
  ContextManager,
  TokenBudget,
  ContextInjection,
  CompileResult,
  HotContextSettingsStatus,
  HotContextSettingsUpdate,
  PrimarySummaryContract,
  PrimarySummaryIdentity,
  PrimarySummaryProjection,
} from '@animalabs/context-manager';
import type {
  AgentConfig,
  AgentState,
  PendingToolCall,
  CompletedToolCall,
  ToolCallId,
  ToolCall,
  ToolResult,
  ToolDefinition,
  AgentInfo,
  InferenceResult,
  InferenceOptions,
  AgentRuntimeSettingsPatch,
  AgentRuntimeSettingsSnapshot,
  AgentRuntimeSettingsOverrides,
} from './types/index.js';

type PrimarySummaryContractWithSystemHash = PrimarySummaryContract & {
  systemHash: string;
};

const DEFAULT_CONTEXT_BUDGET_TOKENS = 100_000;
const DEFAULT_TRANSITION_PACE_TOKENS = 16_000;

/**
 * An agent wraps a context manager and manages inference state.
 */
export class Agent {
  readonly name: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly allowedTools: 'all' | string[];
  readonly triggerSources: 'all' | string[];
  readonly maxTokens: number;
  /**
   * Sampling temperature. Optional — if undefined, the parameter is omitted
   * from the inference request entirely. Required for newer Anthropic models
   * (claude-opus-4-7+) that have deprecated the `temperature` parameter and
   * return HTTP 400 if it's set, even to 1.
   */
  readonly temperature: number | undefined;
  /**
   * Extended thinking config. When set with `enabled: true`, Membrane will
   * request native thinking from the provider. Signatures on response thinking
   * blocks are preserved through Chronicle.
   */
  readonly thinking: AgentConfig['thinking'];
  /** Refusal auto-rewind policy (see AgentConfig.refusalHandling). */
  readonly refusalHandling: AgentConfig['refusalHandling'];
  /** Prompt-cache TTL forwarded to the provider (see AgentConfig.cacheTtl). */
  readonly cacheTtl: NonNullable<AgentConfig['cacheTtl']>;
  /** Provider-specific request parameters forwarded unchanged by Membrane. */
  readonly providerParams?: Record<string, unknown>;

  private _state: AgentState = { status: 'idle' };
  private _inferenceStartedAt = 0;
  private _streamId = 0;
  lastStreamInputTokens = 0;
  maxStreamTokens: number;
  /** Per-agent context compile budget (input tokens). When unset, the
   * ContextManager's built-in default applies. reserveForResponse uses
   * this agent's maxTokens. */
  contextBudgetTokens?: number;
  private readonly configuredContextBudgetTokens?: number;
  private readonly configuredTailTokens?: number;
  private readonly configuredTransitionPaceTokens?: number;
  private contextBudgetTargetTokens?: number;
  private runtimeSettingsOverrides: AgentRuntimeSettingsOverrides = {};
  private contextManager: ContextManager;
  private membrane: Membrane;

  constructor(
    config: AgentConfig,
    contextManager: ContextManager,
    membrane: Membrane
  ) {
    this.name = config.name;
    this.model = config.model;
    this.systemPrompt = config.systemPrompt;
    this.allowedTools = config.allowedTools ?? 'all';
    this.triggerSources = config.triggerSources ?? 'all';
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature;
    this.thinking = config.thinking;
    this.refusalHandling = config.refusalHandling;
    this.cacheTtl = config.cacheTtl ?? '1h';
    this.providerParams = config.providerParams;
    this.maxStreamTokens = config.maxStreamTokens ?? 150_000;
    this.contextBudgetTokens = config.contextBudgetTokens;
    this.configuredContextBudgetTokens = config.contextBudgetTokens;
    this.contextManager = contextManager;
    this.membrane = membrane;
    const hot = this.getHotContextSettings();
    this.configuredTailTokens = hot?.tailTokens;
    this.configuredTransitionPaceTokens = hot?.transitionPaceTokens;
  }

  /**
   * Get current agent state.
   */
  get state(): AgentState {
    return this._state;
  }

  /**
   * Monotonically increasing stream generation counter.
   * Used to guard stale driveStream handlers after a budget restart.
   */
  get streamId(): number {
    return this._streamId;
  }

  /**
   * Get agent info.
   */
  get info(): AgentInfo {
    return {
      name: this.name,
      model: this.model,
      status: this._state.status,
    };
  }

  /**
   * Check if agent can use a specific tool.
   */
  canUseTool(toolName: string): boolean {
    if (this.allowedTools === 'all') {
      return true;
    }
    return this.allowedTools.includes(toolName);
  }

  /**
   * Check if a source can trigger inference for this agent.
   */
  canBeTriggeredBy(source: string): boolean {
    if (this.triggerSources === 'all') {
      return true;
    }
    return this.triggerSources.includes(source);
  }

  // ==========================================================================
  // Composable Steps
  // ==========================================================================

  /**
   * Compile the context without injections.
   * Step 1 of the inference pipeline — callers can inspect/modify the result
   * before building a request.
   */
  /** Resolve the compile budget: explicit arg wins, else the per-agent
   * configured context budget (if any), else the ContextManager default. */
  private resolveBudget(budget?: TokenBudget): TokenBudget | undefined {
    if (budget) return budget;
    if (this.contextBudgetTokens === undefined) return undefined;
    return { maxTokens: this.contextBudgetTokens, reserveForResponse: this.maxTokens };
  }

  /** Structural compatibility keeps lightweight test/host ContextManager
   * doubles working while making the new capability optional at runtime. */
  private getHotContextSettings(): HotContextSettingsStatus | null {
    const manager = this.contextManager as ContextManager & {
      getHotContextSettings?: () => HotContextSettingsStatus | null;
    };
    return typeof manager.getHotContextSettings === 'function'
      ? manager.getHotContextSettings()
      : null;
  }

  private updateHotContextSettings(update: HotContextSettingsUpdate): HotContextSettingsStatus {
    const manager = this.contextManager as ContextManager & {
      updateHotContextSettings?: (value: HotContextSettingsUpdate) => HotContextSettingsStatus;
    };
    if (typeof manager.updateHotContextSettings !== 'function') {
      throw new Error('The active context strategy does not support live context settings');
    }
    return manager.updateHotContextSettings(update);
  }

  private hashJson(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
  }

  private primarySummaryFallbackEnabled(): boolean {
    return this.refusalHandling?.primarySummaryFallback?.enabled === true;
  }

  private buildPrimarySummaryContractForRequest(request: NormalizedRequest): PrimarySummaryContractWithSystemHash {
    return {
      systemHash: this.hashJson(request.system ?? ''),
      modelConfigHash: this.hashJson({
        requestConfig: request.config,
        providerParams: request.providerParams,
        promptCaching: request.promptCaching,
        cacheTtl: request.cacheTtl,
        assistantParticipant: request.assistantParticipant,
      }),
      toolContractHash: this.hashJson(request.tools ?? []),
    };
  }

  private setPrimaryLaneContract(contract: PrimarySummaryContract | undefined): void {
    const manager = this.contextManager as ContextManager & {
      setPrimaryLaneContract?: (value: PrimarySummaryContract | undefined) => void;
    };
    manager.setPrimaryLaneContract?.(contract);
  }

  private matchingPrimarySummaryQuarantine(
    projection: PrimarySummaryProjection,
    contract: PrimarySummaryContract,
  ): PrimarySummaryIdentity[] {
    const manager = this.contextManager as ContextManager & {
      matchingPrimarySummaryQuarantine?: (
        projection: PrimarySummaryProjection,
        contract?: PrimarySummaryContract,
      ) => PrimarySummaryIdentity[];
    };
    return manager.matchingPrimarySummaryQuarantine?.(projection, contract) ?? [];
  }

  private expandPrimarySummaryProjectionRaw(
    compiled: CompileResult,
    summaries: ReadonlyArray<PrimarySummaryIdentity>,
  ): CompileResult {
    const manager = this.contextManager as ContextManager & {
      expandPrimarySummaryProjectionRaw?: (
        compiled: CompileResult,
        summaries: ReadonlyArray<PrimarySummaryIdentity>,
      ) => CompileResult;
    };
    if (typeof manager.expandPrimarySummaryProjectionRaw !== 'function') return compiled;
    return manager.expandPrimarySummaryProjectionRaw(compiled, summaries);
  }

  private primarySummaryIdentityKey(identity: PrimarySummaryIdentity): string {
    return [
      identity.id,
      identity.contentHash,
      identity.carrierHash,
      identity.sourceLeafHash,
    ].join('\u0000');
  }

  private buildRequestFromCompileResult(
    compileResult: CompileResult,
    availableTools: ToolDefinition[],
  ): NormalizedRequest {
    let { messages, systemInjections } = compileResult;

    messages = messages
      .map((m) => ({
        ...m,
        content: m.content.filter(
          (b: ContentBlock) => !(b.type === "text" && (typeof b.text !== "string" || b.text.trim() === "")),
        ),
      }))
      .filter((m) => m.content.length > 0);

    if (messages.length > 0 && messages[messages.length - 1]!.participant === this.name) {
      messages = [...messages, {
        participant: 'user',
        content: [{ type: 'text', text: '[Continue]' }],
      }];
    }

    return {
      messages,
      system: this.buildSystemPrompt(systemInjections),
      config: {
        model: this.model,
        maxTokens: this.maxTokens,
        ...(this.temperature !== undefined && { temperature: this.temperature }),
        ...(this.thinking !== undefined && { thinking: this.thinking }),
      },
      tools: availableTools.length > 0 ? availableTools : undefined,
      promptCaching: true,
      cacheTtl: this.cacheTtl,
      ...(this.providerParams && { providerParams: this.providerParams }),
      assistantParticipant: this.name,
    };
  }

  async prepareActivationRequest(
    availableTools: ToolDefinition[],
    injections?: ContextInjection[],
    budget?: TokenBudget,
  ): Promise<{ request: NormalizedRequest; artifacts: ActivationCompileArtifacts }> {
    (this.contextManager as unknown as { setToolDefinitions?: (t: ToolDefinition[]) => void })
      .setToolDefinitions?.(availableTools);

    let compileResult = await this.compileWithInjections(budget, injections);
    let request = this.buildRequestFromCompileResult(compileResult, availableTools);
    const contract = this.buildPrimarySummaryContractForRequest(request);
    this.setPrimaryLaneContract(contract);

    const projection = compileResult.primarySummaryProjection;
    if (this.primarySummaryFallbackEnabled() && projection) {
      const quarantined = this.matchingPrimarySummaryQuarantine(projection, contract);
      if (quarantined.length > 0) {
        compileResult = this.expandPrimarySummaryProjectionRaw(compileResult, quarantined);
        request = this.buildRequestFromCompileResult(compileResult, availableTools);
      }
    }

    return {
      request,
      artifacts: {
        compileResult,
        contract,
      },
    };
  }

  getRuntimeSettings(): AgentRuntimeSettingsSnapshot {
    const hot = this.getHotContextSettings();
    return {
      contextBudgetTokens:
        this.contextBudgetTargetTokens ??
        this.contextBudgetTokens ??
        DEFAULT_CONTEXT_BUDGET_TOKENS,
      ...(hot ? { tailTokens: hot.tailTokens } : {}),
      ...(hot?.transitionPaceTokens !== undefined
        ? { transitionPaceTokens: hot.transitionPaceTokens }
        : {}),
      transition: this.contextBudgetTargetTokens === undefined
        ? 'stable'
        : hot?.blocked
          ? 'blocked'
          : 'converging',
      ...(hot?.blocked === 'transition-pace-floor'
        ? { transitionReason: 'transition_pace_too_small' as const }
        : hot?.blocked === 'prepared-window-floor'
          ? { transitionReason: 'protected_context_exceeds_target' as const }
          : {}),
    };
  }

  getRuntimeSettingsOverrides(): AgentRuntimeSettingsOverrides {
    return { ...this.runtimeSettingsOverrides };
  }

  getCurrentBranchGeneration():
    | { id: string; name: string; head: number; generation: number; parentId?: string; branchPoint?: number; created: Date }
    | null {
    const manager = this.contextManager as ContextManager & {
      currentBranchGeneration?: () => {
        id: string;
        name: string;
        head: number;
        generation: number;
        parentId?: string;
        branchPoint?: number;
        created: Date;
      };
    };
    return manager.currentBranchGeneration?.() ?? null;
  }

  buildPrimarySummaryRawExpansionRequest(
    artifacts: ActivationCompileArtifacts,
    summaries: ReadonlyArray<PrimarySummaryIdentity>,
    availableTools: ToolDefinition[],
  ): { request: NormalizedRequest; artifacts: ActivationCompileArtifacts } {
    this.setPrimaryLaneContract(artifacts.contract);
    const alreadyExpanded = new Set(
      artifacts.compileResult.primarySummaryProjection?.selectedSummaries
        .filter((selection) => selection.renderedAs === 'raw_expansion')
        .map((selection) => this.primarySummaryIdentityKey(selection.identity)) ?? [],
    );
    const expandable = summaries.filter((summary) =>
      !alreadyExpanded.has(this.primarySummaryIdentityKey(summary)),
    );
    const compileResult = expandable.length > 0
      ? this.expandPrimarySummaryProjectionRaw(
          artifacts.compileResult,
          expandable,
        )
      : artifacts.compileResult;
    return {
      request: this.buildRequestFromCompileResult(compileResult, availableTools),
      artifacts: {
        compileResult,
        contract: artifacts.contract,
      },
    };
  }

  updateRuntimeSettings(patch: AgentRuntimeSettingsPatch): AgentRuntimeSettingsSnapshot {
    this.validateRuntimeSettingsPatch(patch);
    let nextContextBudget = this.contextBudgetTokens;
    let nextContextTarget = this.contextBudgetTargetTokens;
    let appliedDefaultPace = false;
    const hotPatch: {
      tailTokens?: number;
      transitionPaceTokens?: number | null;
      preparedWindowTokens?: number | null;
    } = {};
    if (patch.tailTokens !== undefined) hotPatch.tailTokens = patch.tailTokens;
    if (patch.transitionPaceTokens !== undefined) {
      hotPatch.transitionPaceTokens = patch.transitionPaceTokens;
    }

    if (patch.contextBudgetTokens !== undefined) {
      const live = this.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
      if (patch.contextBudgetTokens >= live) {
        nextContextBudget = patch.contextBudgetTokens;
        nextContextTarget = undefined;
        if (this.getHotContextSettings()) hotPatch.preparedWindowTokens = null;
      } else {
        const hot = this.getHotContextSettings();
        if (!hot) {
          throw new Error('The active context strategy cannot prepare a smaller window live');
        }
        if (patch.transitionPaceTokens === undefined && hot.transitionPaceTokens === undefined) {
          hotPatch.transitionPaceTokens = DEFAULT_TRANSITION_PACE_TOKENS;
          appliedDefaultPace = true;
        }
        hotPatch.preparedWindowTokens = patch.contextBudgetTokens - this.maxTokens;
        nextContextTarget = patch.contextBudgetTokens;
      }
    }

    if (Object.keys(hotPatch).length > 0) {
      this.updateHotContextSettings(hotPatch);
    }
    this.contextBudgetTokens = nextContextBudget;
    this.contextBudgetTargetTokens = nextContextTarget;
    if (appliedDefaultPace) {
      this.runtimeSettingsOverrides.transitionPaceTokens = DEFAULT_TRANSITION_PACE_TOKENS;
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (this.runtimeSettingsOverrides as Record<string, number>)[key] = value;
    }
    return this.getRuntimeSettings();
  }

  resetRuntimeSettings(keys?: Array<keyof AgentRuntimeSettingsPatch>): AgentRuntimeSettingsSnapshot {
    const reset = new Set(keys ?? ['contextBudgetTokens', 'tailTokens', 'transitionPaceTokens']);
    let nextContextBudget = this.contextBudgetTokens;
    let nextContextTarget = this.contextBudgetTargetTokens;
    const hotPatch: {
      tailTokens?: number;
      transitionPaceTokens?: number | null;
      preparedWindowTokens?: number | null;
    } = {};

    if (reset.has('contextBudgetTokens')) {
      const configured = this.configuredContextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
      const live = this.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
      if (configured < live) {
        const hot = this.getHotContextSettings();
        if (!hot) throw new Error('The active context strategy cannot prepare a smaller window live');
        hotPatch.preparedWindowTokens = configured - this.maxTokens;
        if (hot.transitionPaceTokens === undefined) {
          hotPatch.transitionPaceTokens = DEFAULT_TRANSITION_PACE_TOKENS;
        }
        nextContextTarget = configured;
      } else {
        nextContextBudget = this.configuredContextBudgetTokens;
        nextContextTarget = undefined;
        if (this.getHotContextSettings()) hotPatch.preparedWindowTokens = null;
      }
    }
    if (reset.has('tailTokens')) {
      if (this.configuredTailTokens !== undefined) hotPatch.tailTokens = this.configuredTailTokens;
    }
    if (reset.has('transitionPaceTokens') && this.getHotContextSettings()) {
      hotPatch.transitionPaceTokens =
        nextContextTarget !== undefined && this.configuredTransitionPaceTokens === undefined
          ? DEFAULT_TRANSITION_PACE_TOKENS
          : this.configuredTransitionPaceTokens ?? null;
    }
    if (Object.keys(hotPatch).length > 0) this.updateHotContextSettings(hotPatch);
    this.contextBudgetTokens = nextContextBudget;
    this.contextBudgetTargetTokens = nextContextTarget;
    if (reset.has('contextBudgetTokens')) delete this.runtimeSettingsOverrides.contextBudgetTokens;
    if (reset.has('tailTokens')) delete this.runtimeSettingsOverrides.tailTokens;
    if (reset.has('transitionPaceTokens')) {
      delete this.runtimeSettingsOverrides.transitionPaceTokens;
    }
    return this.getRuntimeSettings();
  }

  cancelRuntimeSettingsTransition(): AgentRuntimeSettingsSnapshot {
    if (this.contextBudgetTargetTokens !== undefined) {
      this.updateHotContextSettings({ preparedWindowTokens: null });
      this.contextBudgetTargetTokens = undefined;
      const live = this.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
      if (live === (this.configuredContextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS)) {
        delete this.runtimeSettingsOverrides.contextBudgetTokens;
      } else {
        this.runtimeSettingsOverrides.contextBudgetTokens = live;
      }
    }
    return this.getRuntimeSettings();
  }

  restoreRuntimeSettings(overrides: AgentRuntimeSettingsOverrides): AgentRuntimeSettingsSnapshot {
    return this.updateRuntimeSettings(overrides);
  }

  private validateRuntimeSettingsPatch(patch: AgentRuntimeSettingsPatch): void {
    if (Object.keys(patch).length === 0) throw new Error('At least one setting is required');
    if (patch.contextBudgetTokens !== undefined) {
      if (!Number.isSafeInteger(patch.contextBudgetTokens) || patch.contextBudgetTokens <= this.maxTokens) {
        throw new Error(`contextBudgetTokens must be a safe integer greater than max response tokens (${this.maxTokens})`);
      }
    }
    if (patch.tailTokens !== undefined &&
        (!Number.isSafeInteger(patch.tailTokens) || patch.tailTokens < 0)) {
      throw new Error('tailTokens must be a non-negative safe integer');
    }
    if (patch.transitionPaceTokens !== undefined &&
        (!Number.isSafeInteger(patch.transitionPaceTokens) || patch.transitionPaceTokens <= 0)) {
      throw new Error('transitionPaceTokens must be a positive safe integer');
    }
    if ((patch.tailTokens !== undefined || patch.transitionPaceTokens !== undefined) &&
        !this.getHotContextSettings()) {
      throw new Error('The active context strategy does not support live tail/transition settings');
    }
  }

  private settleRuntimeSettingsTransition(): void {
    if (this.contextBudgetTargetTokens === undefined) return;
    const hot = this.getHotContextSettings();
    if (!hot?.prepared) return;
    this.contextBudgetTokens = this.contextBudgetTargetTokens;
    this.contextBudgetTargetTokens = undefined;
    this.updateHotContextSettings({ preparedWindowTokens: null });
  }

  async compileContext(budget?: TokenBudget): Promise<CompileResult> {
    const result = await this.contextManager.compile(this.resolveBudget(budget));
    if (!budget) this.settleRuntimeSettingsTransition();
    return result;
  }

  /**
   * Compile the context with injections.
   * Same as compileContext but forwards injections (e.g. from MCPL servers)
   * to the context manager so they are merged into the compiled messages.
   */
  async compileWithInjections(
    budget?: TokenBudget,
    injections?: ContextInjection[]
  ): Promise<CompileResult> {
    const result = await this.contextManager.compile(this.resolveBudget(budget), injections);
    if (!budget) this.settleRuntimeSettingsTransition();
    return result;
  }

  // ==========================================================================
  // Inference (backward-compatible)
  // ==========================================================================

  /**
   * Run inference and return result with tool calls and speech content.
   * Updates agent state during execution.
   */
  async runInference(
    availableTools: ToolDefinition[],
    budget?: TokenBudget,
    options: InferenceOptions = {}
  ): Promise<InferenceResult> {
    return this.runInferenceWithInjections(availableTools, undefined, budget, options);
  }

  /**
   * Run inference with context injections.
   * Same as runInference but passes injections through to compile.
   */
  async runInferenceWithInjections(
    availableTools: ToolDefinition[],
    injections?: ContextInjection[],
    budget?: TokenBudget,
    options?: InferenceOptions
  ): Promise<InferenceResult> {
    if (this._state.status === 'inferring') {
      throw new Error(`Agent ${this.name} is already inferring`);
    }

    if (this._state.status === 'waiting_for_tools') {
      throw new Error(`Agent ${this.name} is waiting for tool results`);
    }

    // Filter tools to only allowed ones
    const tools = availableTools.filter((t) => this.canUseTool(t.name));

    // Compile context (with optional injections)
    const { messages, systemInjections } = await this.compileWithInjections(budget, injections);

    // If we have pending tool results, add them
    if (this._state.status === 'ready') {
      const toolResultMessages = this.buildToolResultMessages(this._state.toolResults);
      messages.push(...toolResultMessages);
    }

    const request: NormalizedRequest = {
      messages,
      system: this.buildSystemPrompt(systemInjections),
      config: {
        model: this.model,
        maxTokens: this.maxTokens,
        ...(this.temperature !== undefined && { temperature: this.temperature }),
        ...(this.thinking !== undefined && { thinking: this.thinking }),
      },
      tools: tools.length > 0 ? tools : undefined,
      ...(this.providerParams && { providerParams: this.providerParams }),
      assistantParticipant: this.name,
    };

    const abortController = new AbortController();
    if (options?.signal) {
      if (options.signal.aborted) {
        abortController.abort();
      } else {
        options.signal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    // Set state to inferring
    this._inferenceStartedAt = Date.now();
    const inferencePromise = this.doInference(request, abortController.signal);
    this._state = { status: 'inferring', promise: inferencePromise, abortController };

    try {
      const result = await inferencePromise;

      if (result.aborted) {
        this._state = { status: 'idle' };
        return result;
      }

      if (result.toolCalls.length > 0) {
        // Waiting for tool results
        const pending = new Map<ToolCallId, PendingToolCall>();
        for (const call of result.toolCalls) {
          pending.set(call.id, {
            id: call.id,
            name: call.name,
            input: call.input,
            startedAt: Date.now(),
          });
        }
        this._state = { status: 'waiting_for_tools', pending, completed: [] };
      } else {
        // Done, back to idle
        this._state = { status: 'idle' };
      }

      return result;
    } catch (error) {
      // On error, go back to idle
      this._state = { status: 'idle' };
      throw error;
    }
  }

  /**
   * Provide a tool result.
   */
  provideToolResult(callId: ToolCallId, result: ToolResult): void {
    if (this._state.status !== 'waiting_for_tools') {
      throw new Error(`Agent ${this.name} is not waiting for tools`);
    }

    const pending = this._state.pending.get(callId);
    if (!pending) {
      throw new Error(`Unknown tool call: ${callId}`);
    }

    // Move from pending to completed
    const completed: CompletedToolCall = {
      id: pending.id,
      name: pending.name,
      input: pending.input,
      result,
      durationMs: Date.now() - pending.startedAt,
    };

    this._state.pending.delete(callId);
    this._state.completed.push(completed);

    // If all tools done, transition to ready
    if (this._state.pending.size === 0) {
      this._state = { status: 'ready', toolResults: this._state.completed, stream: this._state.stream };
    }
  }

  /**
   * Start a yielding stream for inference.
   * Returns the stream — the caller (framework) iterates it.
   */
  async startStream(
    availableTools: ToolDefinition[],
    budget?: TokenBudget
  ): Promise<StartStreamResult> {
    return this.startStreamWithInjections(availableTools, undefined, budget);
  }

  /**
   * Build the membrane-normalized request that WOULD be emitted for this
   * agent's next activation, given the supplied tools and injections.
   *
   * This is the single source of truth for request assembly, shared by the
   * real activation path (`startStreamWithInjections`) and debug/preview
   * tooling (`Framework.previewActivation`). It is pure and non-mutating:
   * it does not touch agent state and does not call the membrane, and
   * `ContextManager.compile` is itself side-effect-free (compression runs in
   * the background). Safe to call regardless of the agent's current status.
   */
  async buildActivationRequest(
    availableTools: ToolDefinition[],
    injections?: ContextInjection[],
    budget?: TokenBudget
  ): Promise<NormalizedRequest> {
    const { request } = await this.prepareActivationRequest(availableTools, injections, budget);
    return request;
  }

  /**
   * Start a yielding stream with context injections.
   * Same as startStream but passes injections through to compile.
   */
  async startStreamWithInjections(
    availableTools: ToolDefinition[],
    injections?: ContextInjection[],
    budget?: TokenBudget
  ): Promise<StartStreamResult> {
    if (this._state.status !== 'idle') {
      throw new Error(`Agent ${this.name} cannot start stream in state ${this._state.status}`);
    }

    this._streamId++;
    this._inferenceStartedAt = Date.now();
    this.lastStreamInputTokens = 0;

    const { request, artifacts } = await this.prepareActivationRequest(
      availableTools,
      injections,
      budget,
    );

    const stream = this.membrane.streamYielding(request, {
      emitTokens: true,
      emitBlocks: false,
      emitUsage: true,
    });

    this._state = { status: 'streaming', stream };
    return { stream, request, artifacts };
  }

  startStreamFromRequest(
    request: NormalizedRequest,
    artifacts: ActivationCompileArtifacts,
  ): StartStreamResult {
    if (this._state.status !== 'streaming' && this._state.status !== 'idle') {
      throw new Error(`Agent ${this.name} cannot replace stream in state ${this._state.status}`);
    }
    this._streamId++;
    this._inferenceStartedAt = Date.now();
    this.lastStreamInputTokens = 0;
    this.setPrimaryLaneContract(artifacts.contract);
    const stream = this.membrane.streamYielding(request, {
      emitTokens: true,
      emitBlocks: false,
      emitUsage: true,
    });
    this._state = { status: 'streaming', stream };
    return { stream, request, artifacts };
  }

  /**
   * Transition to waiting_for_tools when stream yields tool calls.
   * Called by framework's driveStream.
   */
  enterWaitingForTools(calls: ToolCall[], stream: YieldingStream): void {
    const pending = new Map<ToolCallId, PendingToolCall>();
    for (const call of calls) {
      pending.set(call.id, {
        id: call.id,
        name: call.name,
        input: call.input,
        startedAt: Date.now(),
      });
    }
    this._state = { status: 'waiting_for_tools', pending, completed: [], stream };
  }

  /**
   * Add an assistant response to context.
   * Called by framework when stream completes.
   */
  addAssistantResponse(content: ContentBlock[]): void {
    this.contextManager.addMessage(this.name, content);
  }

  /**
   * Transition back to streaming state after tool results are provided.
   */
  setStreaming(stream: YieldingStream): void {
    this._state = { status: 'streaming', stream };
  }

  /**
   * Cancel any active stream and reset to idle.
   */
  cancelStream(): void {
    if (this._state.status === 'streaming') {
      this._state.stream.cancel();
    } else if (this._state.status === 'waiting_for_tools' && this._state.stream) {
      this._state.stream.cancel();
    }
    this._state = { status: 'idle' };
  }

  /**
   * Check if agent has pending tool calls.
   */
  hasPendingTools(): boolean {
    return this._state.status === 'waiting_for_tools' && this._state.pending.size > 0;
  }

  /**
   * Get pending tool call IDs.
   */
  getPendingToolIds(): ToolCallId[] {
    if (this._state.status !== 'waiting_for_tools') {
      return [];
    }
    return Array.from(this._state.pending.keys());
  }

  /**
   * Reset agent to idle state.
   */
  reset(): void {
    this._state = { status: 'idle' };
  }

  /**
   * Get the context manager.
   */
  getContextManager(): ContextManager {
    return this.contextManager;
  }

  /**
   * Build the effective system prompt, appending any system-position injections.
   */
  private buildSystemPrompt(systemInjections: ContentBlock[]): string {
    if (systemInjections.length === 0) {
      return this.systemPrompt;
    }

    const injectedText = systemInjections
      .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
      .map((block) => block.text);

    if (injectedText.length === 0) {
      return this.systemPrompt;
    }

    return this.systemPrompt + '\n' + injectedText.join('\n');
  }

  abortInference(reason?: string): { aborted: true; durationMs: number } | false {
    if (this._state.status === 'inferring') {
      const durationMs = Date.now() - this._inferenceStartedAt;
      this._state.abortController.abort(reason);
      return { aborted: true, durationMs };
    }

    if (this._state.status === 'streaming' ||
        (this._state.status === 'waiting_for_tools' && this._state.stream)) {
      const durationMs = Date.now() - this._inferenceStartedAt;
      this.cancelStream();
      return { aborted: true, durationMs };
    }

    return false;
  }

  private async doInference(
    request: NormalizedRequest,
    signal?: AbortSignal
  ): Promise<InferenceResult> {
    const response = await this.membrane.stream(request, { signal });

    if (isAbortedResponse(response)) {
      const partialContent = response.partialContent ?? [];
      const { toolCalls, speechContent } = this.extractToolCallsAndSpeech(partialContent);
      return {
        toolCalls,
        speechContent,
        usage: response.partialUsage,
        stopReason: 'abort',
        aborted: true,
        abortReason: response.reason,
      };
    }

    const { toolCalls, speechContent } = this.extractToolCallsAndSpeech(response.content);

    // Add assistant response to context
    this.contextManager.addMessage(this.name, response.content);

    return {
      toolCalls,
      speechContent,
      raw: response.raw,
      usage: response.usage,
      stopReason: response.stopReason,
    };
  }

  private extractToolCallsAndSpeech(content: ContentBlock[]): {
    toolCalls: ToolCall[];
    speechContent: ContentBlock[];
  } {
    const toolCalls: ToolCall[] = [];
    const speechContent: ContentBlock[] = [];

    for (const block of content) {
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input,
        });
      } else if (block.type === 'text') {
        speechContent.push(block);
      }
    }

    return { toolCalls, speechContent };
  }

  private buildToolResultMessages(results: CompletedToolCall[]): NormalizedMessage[] {
    // Tool results go as a user message with tool_result blocks. The history
    // serializer turns MCP image blocks into `[image: type, size]` so the
    // persisted transcript stays small and survives truncation.
    const content = results.map((r) => ({
      type: 'tool_result' as const,
      toolUseId: r.id,
      content: r.result.isError
        ? r.result.error ?? 'Unknown error'
        : toolResultDataToHistoryString(r.result.data),
      isError: r.result.isError,
    }));

    return [{
      participant: 'user',
      content,
    }];
  }
}
