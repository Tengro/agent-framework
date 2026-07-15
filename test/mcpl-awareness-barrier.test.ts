import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { AgentFramework } from '../src/framework.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { DiscordAwarenessOutbox } from '../src/recovery/discord-awareness-outbox.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/awareness-barrier-mcpl-server.mjs', import.meta.url));
const TEST_ROOT = join(process.cwd(), '.test-tmp');

interface StatusRecord {
  event: string;
  generation: number;
  accepted?: boolean;
  ledgerStatus?: string;
}

function records(path: string): StatusRecord[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StatusRecord);
  } catch {
    return [];
  }
}

async function waitFor(
  description: string,
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${description}`);
}

function preparePending(outboxPath: string): DiscordAwarenessOutbox {
  const outbox = new DiscordAwarenessOutbox(outboxPath);
  const batch = outbox.prepare({
    agentName: 'assistant',
    sourceBranch: 'source',
    targetBranch: 'main',
    activationPolicy: 'explicit',
    refs: [{ serverId: 'discord', channelId: 'discord:guild:startup', messageId: 'message-1' }],
  });
  assert.ok(batch);
  outbox.activate(batch.id);
  return outbox;
}

function frameworkConfig(
  dir: string,
  extraEnv: Record<string, string> = {},
  requestTimeoutMs = 1_000,
  serverOverrides: Partial<McplServerConfig> = {},
) {
  const outboxPath = join(dir, 'awareness.json');
  return {
    outboxPath,
    config: {
      storePath: join(dir, 'store'),
      discordAwarenessOutboxPath: outboxPath,
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test' }],
      modules: [],
      mcplServers: [{
        id: 'discord',
        command: process.execPath,
        args: [FIXTURE],
        requestTimeoutMs,
        env: extraEnv,
        enabledFeatureSets: ['chat'],
        ...serverOverrides,
      }],
    },
  };
}

test('startup keeps registration/control live while awareness gates inference and readiness', async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_ROOT, 'awareness-startup-'));
  const statusPath = join(dir, 'status.jsonl');
  const releasePath = join(dir, 'release');
  const { outboxPath, config } = frameworkConfig(dir, {
    STATUS_PATH: statusPath,
    LEDGER_PATH: join(dir, 'awareness.json'),
    RELEASE_PATH: releasePath,
  });
  const outbox = preparePending(outboxPath);
  let framework: AgentFramework | undefined;
  let createSettled = false;
  const creating = AgentFramework.create(config).then((created) => {
    framework = created;
    createSettled = true;
    return created;
  });

  try {
    await waitFor('registration and a second control response', () => {
      const events = records(statusPath).map((record) => record.event);
      return events.includes('registration-response')
        && events.includes('control-response-during-barrier');
    });

    assert.equal(createSettled, false, 'framework readiness must wait for the marker outcome');
    assert.equal(
      records(statusPath).some((record) => record.event === 'push-response'),
      false,
      'inference-bearing push must remain held while the marker is pending',
    );
    assert.equal(outbox.pending('discord').length, 1);

    writeFileSync(releasePath, 'release');
    await creating;
    await waitFor('gated push response', () =>
      records(statusPath).some((record) => record.event === 'push-response'));

    const status = records(statusPath);
    const push = status.find((record) => record.event === 'push-response');
    assert.equal(push?.accepted, true);
    assert.equal(push?.ledgerStatus, 'applied', 'push released only after durable success');
    assert.equal(outbox.pending('discord').length, 0);
    assert.equal(status.filter((record) => record.event === 'reaction-call').length, 1);
  } finally {
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('marker timeout is durably recorded and releases startup without a duplicate call', async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_ROOT, 'awareness-timeout-'));
  const statusPath = join(dir, 'status.jsonl');
  const { outboxPath, config } = frameworkConfig(dir, {
    STATUS_PATH: statusPath,
    LEDGER_PATH: join(dir, 'awareness.json'),
    FAIL_REACTION: '1',
  }, 60);
  const outbox = preparePending(outboxPath);
  let framework: AgentFramework | undefined;

  try {
    framework = await AgentFramework.create(config);
    await waitFor('push response after timeout accounting', () =>
      records(statusPath).some((record) => record.event === 'push-response'));

    const entry = outbox.batches()[0]!.refs[0]!;
    assert.equal(entry.deliveryStatus, 'pending');
    assert.equal(entry.attempts, 1);
    assert.match(entry.lastError ?? '', /did not respond to tools\/call/);
    assert.equal(records(statusPath).filter((record) => record.event === 'reaction-call').length, 1);
    const push = records(statusPath).find((record) => record.event === 'push-response');
    assert.equal(push?.ledgerStatus, 'pending', 'failure was durable before inference release');
  } finally {
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools/list_changed installs the data gate before a following push', async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_ROOT, 'awareness-list-change-'));
  const statusPath = join(dir, 'status.jsonl');
  const releasePath = join(dir, 'release');
  const listChangePath = join(dir, 'list-change');
  const { outboxPath, config } = frameworkConfig(dir, {
    STATUS_PATH: statusPath,
    LEDGER_PATH: join(dir, 'awareness.json'),
    RELEASE_PATH: releasePath,
    LIST_CHANGE_PATH: listChangePath,
  });
  const outbox = new DiscordAwarenessOutbox(outboxPath);
  let framework: AgentFramework | undefined;

  try {
    framework = await AgentFramework.create(config);
    await waitFor('initial zero-pending push response', () =>
      records(statusPath).some((record) => record.event === 'push-response'));

    const batch = outbox.prepare({
      agentName: 'assistant',
      sourceBranch: 'source',
      targetBranch: 'main',
      activationPolicy: 'explicit',
      refs: [{ serverId: 'discord', channelId: 'discord:guild:startup', messageId: 'message-list' }],
    });
    assert.ok(batch);
    outbox.activate(batch.id);
    writeFileSync(listChangePath, 'change');

    await waitFor('control response while list-change barrier is pending', () => {
      const status = records(statusPath);
      return status.some((record) => record.event === 'tools-list-changed-notification')
        && status.some((record) => record.event === 'control-response-during-barrier');
    });
    assert.equal(
      records(statusPath).some((record) => record.event === 'list-change-push-response'),
      false,
    );

    writeFileSync(releasePath, 'release');
    await waitFor('list-change gated push response', () =>
      records(statusPath).some((record) => record.event === 'list-change-push-response'));
    const push = records(statusPath).find((record) => record.event === 'list-change-push-response');
    assert.equal(push?.ledgerStatus, 'applied');
    assert.equal(outbox.pending('discord').length, 0);
  } finally {
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconnect pauses fresh inbound data but permits registration and awareness tool service', async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_ROOT, 'awareness-reconnect-'));
  const statusPath = join(dir, 'status.jsonl');
  const releasePath = join(dir, 'release');
  const crashPath = join(dir, 'crash');
  const generationPath = join(dir, 'generation');
  const { outboxPath, config } = frameworkConfig(dir, {
    STATUS_PATH: statusPath,
    LEDGER_PATH: join(dir, 'awareness.json'),
    RELEASE_PATH: releasePath,
    CRASH_PATH: crashPath,
    GENERATION_PATH: generationPath,
  }, 1_000, {
    reconnect: true,
    reconnectIntervalMs: 20,
    reconnectMaxIntervalMs: 20,
  });
  const outbox = new DiscordAwarenessOutbox(outboxPath);
  let framework: AgentFramework | undefined;

  try {
    // No startup marker: this path must release push responders synchronously.
    framework = await AgentFramework.create(config);
    await waitFor('initial synchronous push response', () =>
      records(statusPath).some((record) => record.generation === 1 && record.event === 'push-response'));

    const batch = outbox.prepare({
      agentName: 'assistant',
      sourceBranch: 'source',
      targetBranch: 'main',
      activationPolicy: 'explicit',
      refs: [{ serverId: 'discord', channelId: 'discord:guild:startup', messageId: 'message-2' }],
    });
    assert.ok(batch);
    outbox.activate(batch.id);
    writeFileSync(crashPath, 'crash');

    await waitFor('reconnect control plane during pending barrier', () => {
      const second = records(statusPath).filter((record) => record.generation === 2);
      return second.some((record) => record.event === 'registration-response')
        && second.some((record) => record.event === 'control-response-during-barrier');
    });
    assert.equal(
      records(statusPath).some((record) => record.generation === 2 && record.event === 'push-response'),
      false,
      'fresh reconnect data must not pass the new gate',
    );

    writeFileSync(releasePath, 'release');
    await waitFor('reconnect gated push response', () =>
      records(statusPath).some((record) => record.generation === 2 && record.event === 'push-response'));
    const push = records(statusPath).find(
      (record) => record.generation === 2 && record.event === 'push-response',
    );
    assert.equal(push?.ledgerStatus, 'applied');
    assert.equal(outbox.pending('discord').length, 0);
  } finally {
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
