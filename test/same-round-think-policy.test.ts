import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import type { ContentBlock, NormalizedRequest, YieldingStream, StreamEvent } from '@animalabs/membrane';

const TILDE_PREFACE_80 = 'P'.repeat(80);
const TILDE_THINK_4416 = 'T'.repeat(4416);

class TestToolsModule implements Module {
  readonly name = 'tools';

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'read',
        description: 'Read from the workspace.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
      {
        name: 'ping',
        description: 'A non-silencing tool.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'send_message',
        description: 'Explicitly send a message.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return { success: true, data: { ok: true, tool: call.name, input: call.input } };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const text = String((event as { content?: unknown }).content ?? '');
    return {
      addMessages: [{ participant: 'Antra', content: [{ type: 'text', text }] }],
      requestInference: text === 'go',
    };
  }
}

function makeToolRound(preface: string): ContentBlock[] {
  return [
    { type: 'text', text: preface },
    { type: 'tool_use', id: 'think-1', name: 'think', input: { content: TILDE_THINK_4416 } },
    { type: 'tool_use', id: 'read-1', name: 'tools--read', input: { path: 'project/secret.txt' } },
  ] as ContentBlock[];
}

function makeChannelRegistry(framework: AgentFramework) {
  const routed: string[] = [];
  const explicit = {
    getChannelTools: () => [
      {
        name: 'think',
        description: 'private reasoning',
        inputSchema: {
          type: 'object' as const,
          properties: { content: { type: 'string' } },
          required: [],
        },
      },
      {
        name: 'skip_reply',
        description: 'stay silent',
        inputSchema: {
          type: 'object' as const,
          properties: { reason: { type: 'string' } },
          required: [],
        },
      },
    ],
    handleChannelToolCall: async (toolName: string) => {
      if (toolName === 'think') {
        return {
          success: true,
          data: {
            noted: true,
            note:
              'Thought recorded (private — not sent anywhere). Same-round text routing depends on your current same_round_think_text_policy; use agent_settings get to inspect it, or call skip_reply to end the turn without replying.',
          },
        };
      }
      if (toolName === 'skip_reply') {
        return {
          success: true,
          endTurn: true,
          data: { skipped: true, note: 'Turn ended; nothing sent.' },
        };
      }
      return { success: false, error: `Unknown channel tool: ${toolName}`, isError: true };
    },
    resolveLocus: () => 'chan-test',
    routeSpeech: async (_agent: string, text: string) => {
      routed.push(text);
    },
    getDefaultPublishChannel: () => null,
    isChannelOpen: () => true,
    getDescriptor: () => undefined,
  };
  (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy(explicit, {
    get: (target, prop: string) => (prop in target ? target[prop as keyof typeof target] : () => undefined),
  });
  return routed;
}

async function createFramework(opts?: {
  policy?: 'public' | 'private';
  membrane?: { asMembrane?: () => unknown } | unknown;
  agents?: Array<{ name: string; sameRoundThinkTextPolicy?: 'public' | 'private' }>;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'same-round-think-'));
  const membrane = opts?.membrane ?? new MockMembrane();
  const agents = opts?.agents ?? [{
    name: 'agent',
    ...(opts?.policy !== undefined ? { sameRoundThinkTextPolicy: opts.policy } : {}),
  }];
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: ((membrane as { asMembrane?: () => unknown }).asMembrane?.() ?? membrane) as import('@animalabs/membrane').Membrane,
    agents: agents.map((agent) => ({
      name: agent.name,
      model: 'test-model',
      systemPrompt: 'test',
      ...(agent.sameRoundThinkTextPolicy !== undefined
        ? { sameRoundThinkTextPolicy: agent.sameRoundThinkTextPolicy }
        : {}),
    })),
    modules: [new TestToolsModule()],
  });
  const routed = makeChannelRegistry(framework);
  return { dir, framework, membrane, routed };
}

function trigger(framework: AgentFramework): void {
  framework.pushEvent({
    type: 'external-message',
    source: 'test',
    content: 'go',
    metadata: {},
  } as unknown as ProcessEvent);
}

class LegacyNoRoundContentStream {
  private pendingResolve: (() => void) | null = null;
  private deliveredComplete = false;

  provideToolResults(_results: unknown[]): void {
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    resolve?.();
  }

  cancel(): void {
    this.deliveredComplete = true;
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    resolve?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield {
      type: 'tool-calls',
      calls: [
        { id: 'think-legacy', name: 'think', input: { content: TILDE_THINK_4416 } },
        { id: 'read-legacy', name: 'tools--read', input: { path: 'project/secret.txt' } },
      ],
      context: {
        rawText: '',
        preamble: TILDE_PREFACE_80,
        depth: 0,
        previousResults: [],
        accumulated: '',
      },
    } as StreamEvent;
    await new Promise<void>((resolve) => { this.pendingResolve = resolve; });
    if (this.deliveredComplete) return;
    yield {
      type: 'complete',
      response: createMockResponse(makeToolRound(TILDE_PREFACE_80)),
    } as StreamEvent;
  }
}

class LegacyNoRoundContentMembrane {
  calls: NormalizedRequest[] = [];

  streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    return new LegacyNoRoundContentStream() as unknown as YieldingStream;
  }
}

describe('same-round think text policy', () => {
  it('compatibility default/public routes the exact Tilde-shaped same-round preface', async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse(makeToolRound(TILDE_PREFACE_80), 'tool_use'));
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));
    const { dir, framework, routed } = await createFramework({ membrane });
    try {
      trigger(framework);
      await framework.runUntilIdle();
      assert.deepEqual(routed, [TILDE_PREFACE_80]);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recipe private routes zero same-round prose for the exact Tilde shape', async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse(makeToolRound(TILDE_PREFACE_80), 'tool_use'));
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));
    const { dir, framework, routed } = await createFramework({ policy: 'private', membrane });
    try {
      trigger(framework);
      await framework.runUntilIdle();
      assert.deepEqual(routed, []);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('private is non-sticky: later non-think rounds and trailing prose route normally', async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse(makeToolRound(TILDE_PREFACE_80), 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'visible same turn after a non-think tool round' },
      { type: 'tool_use', id: 'ping-1', name: 'tools--ping', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'visible trailing prose after tool results' },
    ] as ContentBlock[]));
    const { dir, framework, routed } = await createFramework({ policy: 'private', membrane });
    try {
      trigger(framework);
      await framework.runUntilIdle();
      assert.deepEqual(routed, [
        'visible same turn after a non-think tool round',
        'visible trailing prose after tool results',
      ]);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('public remains non-silencing across later rounds and trailing prose', async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse(makeToolRound(TILDE_PREFACE_80), 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'still public in the next tool round' },
      { type: 'tool_use', id: 'ping-2', name: 'tools--ping', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'still public in trailing prose' },
    ] as ContentBlock[]));
    const { dir, framework, routed } = await createFramework({ policy: 'public', membrane });
    try {
      trigger(framework);
      await framework.runUntilIdle();
      assert.deepEqual(routed, [
        TILDE_PREFACE_80,
        'still public in the next tool round',
        'still public in trailing prose',
      ]);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('think plus skip_reply remains silent under both policies', async () => {
    for (const policy of ['public', 'private'] as const) {
      const membrane = new MockMembrane();
      membrane.pushResponse(createMockResponse([
        { type: 'text', text: TILDE_PREFACE_80 },
        { type: 'tool_use', id: `think-${policy}`, name: 'think', input: { content: TILDE_THINK_4416 } },
        { type: 'tool_use', id: `skip-${policy}`, name: 'skip_reply', input: { reason: 'no reply' } },
      ] as ContentBlock[], 'tool_use'));
      membrane.pushResponse(createMockResponse([] as ContentBlock[]));
      const { dir, framework, routed } = await createFramework({ policy, membrane });
      try {
        trigger(framework);
        await framework.runUntilIdle();
        assert.deepEqual(routed, [], `${policy} should stay silent`);
      } finally {
        await framework.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('explicit-send behavior is unchanged', async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'sending directly' },
      { type: 'tool_use', id: 'send-1', name: 'tools--send_message', input: { text: 'hi' } },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'this later tool round should still stay silent' },
      { type: 'tool_use', id: 'ping-3', name: 'tools--ping', input: {} },
    ] as ContentBlock[], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'and trailing prose should stay silent too' },
    ] as ContentBlock[]));
    const { dir, framework, routed } = await createFramework({ policy: 'private', membrane });
    try {
      trigger(framework);
      await framework.runUntilIdle();
      assert.deepEqual(routed, []);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('private keeps the preface in Chronicle while withholding it from channel routing', async () => {
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse(makeToolRound(TILDE_PREFACE_80), 'tool_use'));
    membrane.pushResponse(createMockResponse([] as ContentBlock[]));
    const { dir, framework, routed } = await createFramework({ policy: 'private', membrane });
    try {
      trigger(framework);
      await framework.runUntilIdle();
      assert.deepEqual(routed, []);
      const compiled = await framework.getAgent('agent')!.getContextManager().compile();
      assert.ok(
        compiled.messages.some((message) => JSON.stringify(message.content).includes(TILDE_PREFACE_80)),
        'the same-round preface should remain in Chronicle/context',
      );
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds different provider-bound think descriptions per agent, and preview matches activation', async () => {
    const { dir, framework } = await createFramework({
      agents: [
        { name: 'public-agent', sameRoundThinkTextPolicy: 'public' },
        { name: 'private-agent', sameRoundThinkTextPolicy: 'private' },
      ],
    });
    try {
      const previewPublic = await framework.previewActivation('public-agent');
      const previewPrivate = await framework.previewActivation('private-agent');
      const publicThink = previewPublic.tools?.find((tool) => tool.name === 'think');
      const privateThink = previewPrivate.tools?.find((tool) => tool.name === 'think');
      assert.ok(publicThink);
      assert.ok(privateThink);
      assert.match(publicThink!.description, /may still be routed publicly as your speech/);
      assert.match(privateThink!.description, /withheld from channel routing/);

      const publicActivationTools = (framework as unknown as {
        getToolsForAgent: (agentName: string) => Array<{ name: string; description: string }>;
      }).getToolsForAgent('public-agent');
      const privateActivationTools = (framework as unknown as {
        getToolsForAgent: (agentName: string) => Array<{ name: string; description: string }>;
      }).getToolsForAgent('private-agent');
      assert.equal(
        publicActivationTools.find((tool) => tool.name === 'think')?.description,
        publicThink?.description,
      );
      assert.equal(
        privateActivationTools.find((tool) => tool.name === 'think')?.description,
        privateThink?.description,
      );
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('legacy/no-roundContent behavior remains unchanged', async () => {
    const membrane = new LegacyNoRoundContentMembrane();
    const { dir, framework, routed } = await createFramework({ policy: 'private', membrane });
    try {
      trigger(framework);
      await framework.runUntilIdle();
      assert.deepEqual(routed, [TILDE_PREFACE_80]);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
