# Agent Framework Requirements

## Overview

A framework for running multi-agent systems with pluggable modules, persistent state, and concurrent tool execution. Built on top of Chronicle (storage), Membrane (LLM abstraction), and Context Manager.

## Core Concepts

### Event Loop

Single loop for the entire system. Processes events from a queue, dispatches to modules, manages agent inference, and executes tools concurrently.

```
Queue → Dispatch to Modules → Apply Changes → Check Inference → Execute Tools → Queue
```

The loop never blocks on a single operation. Tool execution is concurrent - if one agent is waiting for a slow tool, other agents continue working.

### Agents

Agents are "LLM personalities" - separate from modules. Each agent has:
- **Identity**: name, model, system prompt
- **Context Manager**: namespaced, with its own strategy
- **State**: idle, inferring, waiting_for_tools, ready

```typescript
type AgentState =
  | { status: 'idle' }
  | { status: 'inferring', promise: Promise<Response> }
  | { status: 'waiting_for_tools', pending: Set<ToolCallId> }
  | { status: 'ready', toolResults: ToolResult[] }
```

Multiple agents share the message store but have independent context logs and strategies.

### Modules

Modules are capability providers. They:
- Declare and undeclare tools dynamically
- Handle tool calls
- React to events (external messages, tool results, timers)
- Have external components (Discord listener, HTTP server) that push to the queue
- Request message additions, edits, removals
- Request inference (but don't control it directly)

Multiple instances of the same module type can run (e.g., two Discord bots).

### Tools

Tools are namespaced by module: `discord:main:send_message`, `web:fetch`, `timer:schedule`.

Tool handlers are async. The framework handles:
- **Instant tools**: Return immediately, result goes to queue
- **Slow tools**: Agent waits, others continue, result arrives later
- **Fire-and-forget**: Return ack immediately, side effects happen async

```typescript
// Instant
async handleReadFile(input: { path: string }) {
  return { content: await fs.readFile(input.path) };
}

// Slow - agent waits
async handleWebSearch(input: { query: string }) {
  const results = await searchAPI.search(input.query);
  return { results };
}

// Fire-and-forget
async handleDiscordSend(input: { channel: string, message: string }) {
  this.discord.send(input.channel, input.message);  // don't await
  return { sent: true };
}
```

### Persistent State

Everything persists in Chronicle store:

```
messages                      # shared conversation log
agents/{name}/context         # per-agent context log
modules/{name}/state          # per-module persistent state
framework/state               # framework-level state (agent configs, etc.)
```

Module state includes things like:
- Discord: channels to monitor, last message IDs, mention triggers
- Timer: scheduled wakeups, sleep-until timestamp
- Not connection status (ephemeral), but resumable state

## Event Types

```typescript
type QueueEvent =
  | { type: 'external-message', source: string, content: unknown, metadata: unknown, triggerInference?: boolean }
  | { type: 'tool-result', callId: ToolCallId, agentName: string, result: ToolResult }
  | { type: 'timer-fired', timerId: string, reason: string }
  | { type: 'inference-request', agentName: string, reason: string }
  | { type: 'message-edited', source: string, messageId: MessageId, newContent: ContentBlock[] }
  | { type: 'message-removed', source: string, messageId: MessageId }
  | { type: 'module-event', source: string, event: unknown }  // module-specific
```

## Module Interface

```typescript
interface Module {
  /** Unique name, used for tool namespacing and state storage */
  readonly name: string;

  // Lifecycle
  start(ctx: ModuleContext): Promise<void>;
  stop(): Promise<void>;

  // Tools - can change over time
  getTools(): ToolDefinition[];
  handleToolCall(call: ToolCall): Promise<ToolResult>;

  // Events
  onEvent(event: QueueEvent): Promise<EventResponse>;
}

interface EventResponse {
  /** Messages to add to the conversation */
  addMessages?: Array<{
    participant: string;
    content: ContentBlock[];
    metadata?: MessageMetadata;
  }>;

  /** Messages to edit */
  editMessages?: Array<{
    messageId: MessageId;
    content: ContentBlock[];
  }>;

  /** Messages to remove */
  removeMessages?: MessageId[];

  /** Request inference for specific agents (or all if not specified) */
  requestInference?: boolean | string[];

  /** Signal that available tools have changed */
  toolsChanged?: boolean;
}
```

## Module Context

What modules receive to interact with the framework:

```typescript
interface ModuleContext {
  // Persistent state (namespaced to this module)
  getState<T>(): T | null;
  setState<T>(state: T): void;

  // Event queue for external components
  readonly queue: EventQueue;

  // Inter-module communication
  getModule<T extends Module>(name: string): T | null;

  // Direct message operations (bypass event response)
  addMessage(participant: string, content: ContentBlock[]): MessageId;
  editMessage(id: MessageId, content: ContentBlock[]): void;
  removeMessage(id: MessageId): void;

  // Framework info
  getAgents(): AgentInfo[];
  getActiveTools(): ToolDefinition[];
}

interface EventQueue {
  push(event: QueueEvent): void;
  // Modules don't pop - only the loop does
}
```

## Inference Policy

Modules request inference, but something decides whether/when to actually run it:

```typescript
interface InferencePolicy {
  shouldInfer(
    agent: AgentInfo,
    requests: InferenceRequest[],
    state: FrameworkState
  ): boolean;
}
```

Default policy: infer if any module requested it for this agent.

Custom policies can implement things like:
- Rate limiting
- Sleep/wake schedules (timer module sets sleep-until, policy respects it)
- Priority between agents
- Batching multiple requests

## Agent Configuration

```typescript
interface AgentConfig {
  name: string;
  model: string;
  systemPrompt: string;

  /** Context management strategy */
  strategy?: ContextStrategy;

  /** Which tools this agent can use (default: all) */
  allowedTools?: string[] | 'all';

  /** Which modules can trigger inference for this agent */
  triggerSources?: string[] | 'all';
}
```

## Framework Configuration

```typescript
interface FrameworkConfig {
  /** Path to Chronicle store */
  storePath: string;

  /** Or existing store (app-owned) */
  store?: JsStore;

  /** Membrane instance for LLM calls */
  membrane: Membrane;

  /** Agent configurations */
  agents: AgentConfig[];

  /** Modules to load */
  modules: Module[];

  /** Custom inference policy */
  inferencePolicy?: InferencePolicy;
}
```

## Example: Discord Integration

```typescript
interface DiscordModuleState {
  guildId: string;
  channels: string[];
  lastMessageIds: Record<string, string>;
  mentionUserId: string;  // bot's user ID for detecting mentions
}

class DiscordModule implements Module {
  readonly name: string;
  private client: DiscordClient;
  private ctx: ModuleContext;
  private state: DiscordModuleState;

  constructor(config: { name: string, token: string }) {
    this.name = config.name;
    this.client = new DiscordClient(config.token);
  }

  async start(ctx: ModuleContext) {
    this.ctx = ctx;
    this.state = ctx.getState() ?? DEFAULT_STATE;

    // External listener pushes to queue
    this.client.on('message', (msg) => {
      // Update resume point
      this.state.lastMessageIds[msg.channelId] = msg.id;
      ctx.setState(this.state);

      // Push event
      ctx.queue.push({
        type: 'external-message',
        source: this.name,
        content: msg.content,
        metadata: {
          channelId: msg.channelId,
          authorId: msg.authorId,
          messageId: msg.id,
        },
        triggerInference: msg.mentions.includes(this.state.mentionUserId),
      });
    });

    this.client.on('messageUpdate', (oldMsg, newMsg) => {
      ctx.queue.push({
        type: 'message-edited',
        source: this.name,
        messageId: oldMsg.id,  // need mapping to our MessageId
        newContent: [{ type: 'text', text: newMsg.content }],
      });
    });

    await this.client.login();
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'send_message',
        description: 'Send a message to a Discord channel',
        inputSchema: { /* ... */ },
      },
      {
        name: 'add_reaction',
        description: 'Add a reaction to a message',
        inputSchema: { /* ... */ },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    switch (call.name) {
      case 'send_message':
        await this.client.send(call.input.channelId, call.input.content);
        return { success: true };
      // ...
    }
  }

  async onEvent(event: QueueEvent): Promise<EventResponse> {
    if (event.type === 'external-message' && event.source === this.name) {
      // Add to conversation log
      return {
        addMessages: [{
          participant: `Discord:${event.metadata.authorId}`,
          content: [{ type: 'text', text: event.content }],
          metadata: { discord: event.metadata },
        }],
        requestInference: event.triggerInference,
      };
    }
    return {};
  }
}
```

## Example: Timer Module

```typescript
interface TimerModuleState {
  scheduledWakeups: Array<{ id: string, at: number, reason: string, agentName?: string }>;
  sleepUntil: number | null;
}

class TimerModule implements Module {
  readonly name = 'timer';
  private ctx: ModuleContext;
  private state: TimerModuleState;
  private timers: Map<string, NodeJS.Timeout> = new Map();

  async start(ctx: ModuleContext) {
    this.ctx = ctx;
    this.state = ctx.getState() ?? { scheduledWakeups: [], sleepUntil: null };

    // Restore scheduled wakeups from persistent state
    for (const wakeup of this.state.scheduledWakeups) {
      if (wakeup.at > Date.now()) {
        this.scheduleTimer(wakeup);
      }
    }
  }

  private scheduleTimer(wakeup: { id: string, at: number, reason: string, agentName?: string }) {
    const delay = Math.max(0, wakeup.at - Date.now());
    const timeout = setTimeout(() => {
      this.ctx.queue.push({
        type: 'timer-fired',
        timerId: wakeup.id,
        reason: wakeup.reason,
      });
      // Remove from state
      this.state.scheduledWakeups = this.state.scheduledWakeups.filter(w => w.id !== wakeup.id);
      this.ctx.setState(this.state);
    }, delay);
    this.timers.set(wakeup.id, timeout);
  }

  getTools(): ToolDefinition[] {
    return [
      { name: 'schedule_wakeup', description: 'Schedule a future wakeup', inputSchema: { /* ... */ } },
      { name: 'sleep_until', description: 'Suppress inference until time', inputSchema: { /* ... */ } },
      { name: 'cancel_sleep', description: 'Resume normal operation', inputSchema: { /* ... */ } },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    switch (call.name) {
      case 'schedule_wakeup': {
        const wakeup = {
          id: crypto.randomUUID(),
          at: call.input.at,
          reason: call.input.reason,
          agentName: call.input.agentName,
        };
        this.state.scheduledWakeups.push(wakeup);
        this.ctx.setState(this.state);
        this.scheduleTimer(wakeup);
        return { scheduled: true, id: wakeup.id };
      }
      case 'sleep_until': {
        this.state.sleepUntil = call.input.until;
        this.ctx.setState(this.state);
        return { sleeping: true, until: call.input.until };
      }
      case 'cancel_sleep': {
        this.state.sleepUntil = null;
        this.ctx.setState(this.state);
        return { awake: true };
      }
    }
  }

  async onEvent(event: QueueEvent): Promise<EventResponse> {
    if (event.type === 'timer-fired') {
      // Timer module might request inference when timer fires
      const wakeup = this.state.scheduledWakeups.find(w => w.id === event.timerId);
      return {
        requestInference: wakeup?.agentName ? [wakeup.agentName] : true,
      };
    }
    return {};
  }

  // Expose for InferencePolicy to check
  isSleeping(): boolean {
    return this.state.sleepUntil !== null && this.state.sleepUntil > Date.now();
  }
}
```

## Store Layout

```
messages                          # shared message log (append_log)
agents/alpha/context              # agent context log (append_log)
agents/beta/context               # agent context log (append_log)
modules/discord:main/state        # module state (snapshot)
modules/timer/state               # module state (snapshot)
framework/agents                  # agent configs (snapshot)
framework/state                   # framework state (snapshot)
framework/inference-log           # raw LLM request/response log (append_log)
```

## Design Decisions

### 1. Message ID Mapping

External systems have their own IDs (Discord message ID). Store in metadata, provide lookup:

```typescript
// When adding from external source
const msgId = ctx.addMessage('User', content, {
  external: { source: 'discord:main', id: discordMessageId }
});

// Framework provides lookup
ctx.findMessageByExternalId('discord:main', discordMessageId): MessageId | null

// Index stored in module state
// modules/discord:main/state.externalIdMap: Record<string, MessageId>
```

### 2. Agent-to-agent Communication

Through shared messages - agents share the message store:

```typescript
// Agent Alpha posts
addMessage('Alpha', [{ type: 'text', text: '@Beta can you handle this?' }]);

// Agent Beta sees it (shared message store)
// Inference triggered if Beta is configured to respond to mentions
```

Natural conversation flow. No special mechanism needed.

### 3. Error Handling

**Tool errors** become error results - LLM sees and decides:

```typescript
{
  type: 'tool_result',
  tool_use_id: '...',
  is_error: true,
  content: 'ConnectionError: Discord API unreachable'
}
```

**Inference errors** - configurable retry policy:

```typescript
interface ErrorPolicy {
  onInferenceError(error: Error, agent: Agent, attempt: number):
    | { retry: true, delayMs: number }
    | { retry: false, emit?: QueueEvent }

  maxRetries: number;  // default 3
}
```

### 4. Hot Reload

- **Add module**: `framework.addModule(module)` → registers, starts, tools available
- **Remove module**: `framework.removeModule(name)` → stops, unregisters tools, pending calls fail
- **Update**: Remove + Add (module handles state migration in `start()`)

```typescript
framework.addModule(new DiscordModule({ name: 'discord:new', ... }));
framework.removeModule('discord:old');
```

### 5. Observability

**Event emitter for hooks:**

```typescript
framework.on('message:added', (msg, source) => { });
framework.on('inference:start', (agent) => { });
framework.on('inference:complete', (agent, response, durationMs) => { });
framework.on('inference:error', (agent, error) => { });
framework.on('tool:start', (module, call) => { });
framework.on('tool:complete', (module, call, result, durationMs) => { });
framework.on('tool:error', (module, call, error) => { });
framework.on('module:start', (module) => { });
framework.on('module:stop', (module) => { });

// Built-in logging adapter
framework.useLogger(console);  // or pino, winston, etc.
```

**Raw LLM request/response logging:**

Store in Chronicle for debugging, replay, and time-travel:

```typescript
// Stored in framework/inference-log (append_log)
interface InferenceLogEntry {
  timestamp: number;
  agentName: string;
  requestId: string;
  request: NormalizedRequest;   // or blobId if large
  response: NormalizedResponse; // or blobId if large
  durationMs: number;
  tokenUsage: { input: number, output: number };
}

// Large payloads stored as blobs
{
  timestamp: 1234567890,
  agentName: 'alpha',
  requestId: 'req-123',
  requestBlobId: 'blob:abc123',
  responseBlobId: 'blob:def456',
  durationMs: 2340,
}
```

Benefits:
- Branches with conversation (see exactly what was sent on each branch)
- Time travel (what did we send at sequence 47?)
- Debugging and replay

Future cleanup options:
- `framework.compactInferenceLogs({ keepLast: 1000 })`
- TTL-based: keep last N days
- Size-based: keep last N MB

### 6. Testing

**Unit testing modules:**

```typescript
const ctx = createMockModuleContext({
  initialState: { channels: ['general'] },
});

const module = new DiscordModule({ name: 'discord:test', token: 'fake' });
await module.start(ctx);

const response = await module.onEvent({
  type: 'external-message',
  source: 'discord:test',
  content: 'hello',
  metadata: { channelId: '123' },
});

expect(response.addMessages).toHaveLength(1);
expect(response.requestInference).toBe(false);
expect(ctx.getState().lastMessageIds['123']).toBeDefined();
```

**Integration testing:**

```typescript
const framework = createTestFramework({
  membrane: createMockMembrane(predefinedResponses),
  store: createInMemoryStore(),
  agents: [{ name: 'test', model: 'mock', systemPrompt: '...' }],
  modules: [new MockDiscordModule()],
});

await framework.pushEvent({ type: 'external-message', ... });
await framework.runUntilIdle();

expect(framework.getMessages()).toHaveLength(2);  // user + assistant
```

## Package Structure

```
/agent-framework/
  package.json
  src/
    index.ts
    framework.ts           # Main AgentFramework class
    loop.ts                # Event loop implementation
    agent.ts               # Agent class
    module.ts              # Module interface and base class
    queue.ts               # Event queue
    tool-executor.ts       # Concurrent tool execution
    inference-policy.ts    # Default and custom policies
    types/
      index.ts
      events.ts
      module.ts
      agent.ts
  test/
    framework.test.ts
    mock-module.ts
```

## Dependencies

```json
{
  "dependencies": {
    "chronicle": "file:../record-store",
    "membrane": "file:../membrane",
    "@connectome/context-manager": "file:../context-manager"
  }
}
```
