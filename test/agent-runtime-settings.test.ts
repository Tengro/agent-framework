import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AutobiographicalStrategy } from '@animalabs/context-manager';
import { AgentFramework } from '../src/index.js';

const membrane = {} as any;

function strategy(): AutobiographicalStrategy {
  return new AutobiographicalStrategy({
    adaptiveResolution: true,
    foldingStrategy: 'kv-stable',
    recentWindowTokens: 30_000,
    kvStableReachTokens: 8_000,
  });
}

describe('agent runtime settings', () => {
it('agent_settings is one typed tool for the hot runtime surface', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane,
    agents: [{
      name: 'agent',
      model: 'test-model',
      systemPrompt: 'test',
      strategy: strategy(),
      contextBudgetTokens: 100_000,
      maxTokens: 10_000,
    }],
    modules: [],
  });
  try {
    const tool = framework.getAllTools().find((candidate) => candidate.name === 'agent_settings');
    assert.ok(tool, 'general-purpose settings tool is exposed');
    assert.deepEqual(
      (tool!.inputSchema as { properties: Record<string, unknown> }).properties.same_round_think_text_policy,
      {
        type: 'string',
        enum: ['public', 'private'],
        description:
          'Routing policy for ordinary text emitted in the same native assistant round as think(). ' +
          "Omitted in the recipe preserves the compatibility carry-forward: public.",
      },
    );
    assert.deepEqual(framework.getAgentRuntimeSettings('agent'), {
      contextBudgetTokens: 100_000,
      tailTokens: 30_000,
      transitionPaceTokens: 8_000,
      sameRoundThinkTextPolicy: 'public',
      sameRoundThinkTextPolicySource: 'compatibility_default',
      transition: 'stable',
    });

    assert.deepEqual(
      framework.updateAgentRuntimeSettings('agent', {
        contextBudgetTokens: 60_000,
        tailTokens: 20_000,
        transitionPaceTokens: 4_000,
        sameRoundThinkTextPolicy: 'private',
      }),
      {
        contextBudgetTokens: 60_000,
        tailTokens: 20_000,
        transitionPaceTokens: 4_000,
        sameRoundThinkTextPolicy: 'private',
        sameRoundThinkTextPolicySource: 'runtime_override',
        transition: 'converging',
      },
    );
    assert.equal(
      framework.cancelAgentRuntimeSettingsTransition('agent').transition,
      'stable',
    );
    assert.deepEqual(framework.resetAgentRuntimeSettings('agent'), {
      contextBudgetTokens: 100_000,
      tailTokens: 30_000,
      transitionPaceTokens: 8_000,
      sameRoundThinkTextPolicy: 'public',
      sameRoundThinkTextPolicySource: 'compatibility_default',
      transition: 'stable',
    });
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('runtime overrides persist across framework restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-persist-'));
  const storePath = join(dir, 'store');
  const config = () => ({
    storePath,
    membrane,
    agents: [{
      name: 'agent',
      model: 'test-model',
      systemPrompt: 'test',
      strategy: strategy(),
      contextBudgetTokens: 100_000,
      maxTokens: 10_000,
      sameRoundThinkTextPolicy: 'public' as const,
    }],
    modules: [],
  });

  let framework = await AgentFramework.create(config());
  framework.updateAgentRuntimeSettings('agent', {
    contextBudgetTokens: 70_000,
    tailTokens: 18_000,
    transitionPaceTokens: 5_000,
    sameRoundThinkTextPolicy: 'private',
  });
  await framework.stop();

  try {
    framework = await AgentFramework.create(config());
    assert.deepEqual(framework.getAgentRuntimeSettings('agent'), {
      contextBudgetTokens: 70_000,
      tailTokens: 18_000,
      transitionPaceTokens: 5_000,
      sameRoundThinkTextPolicy: 'private',
      sameRoundThinkTextPolicySource: 'runtime_override',
      transition: 'converging',
    });
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('reset-all skips tail controls unsupported by the active strategy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-basic-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane,
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  try {
    assert.deepEqual(framework.resetAgentRuntimeSettings('agent'), {
      contextBudgetTokens: 100_000,
      sameRoundThinkTextPolicy: 'public',
      sameRoundThinkTextPolicySource: 'compatibility_default',
      transition: 'stable',
    });
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('same_round_think_text_policy reports recipe/runtime/default sources and rejects invalid values', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-settings-think-policy-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane,
    agents: [{
      name: 'agent',
      model: 'test-model',
      systemPrompt: 'test',
      sameRoundThinkTextPolicy: 'private',
    }],
    modules: [],
  });
  try {
    assert.deepEqual(framework.getAgentRuntimeSettings('agent'), {
      contextBudgetTokens: 100_000,
      sameRoundThinkTextPolicy: 'private',
      sameRoundThinkTextPolicySource: 'recipe',
      transition: 'stable',
    });

    assert.deepEqual(
      framework.updateAgentRuntimeSettings('agent', { sameRoundThinkTextPolicy: 'public' }),
      {
        contextBudgetTokens: 100_000,
        sameRoundThinkTextPolicy: 'public',
        sameRoundThinkTextPolicySource: 'runtime_override',
        transition: 'stable',
      },
    );

    assert.deepEqual(
      framework.resetAgentRuntimeSettings('agent', ['sameRoundThinkTextPolicy']),
      {
        contextBudgetTokens: 100_000,
        sameRoundThinkTextPolicy: 'private',
        sameRoundThinkTextPolicySource: 'recipe',
        transition: 'stable',
      },
    );

    assert.throws(
      () => framework.updateAgentRuntimeSettings('agent', { sameRoundThinkTextPolicy: 'bogus' as 'public' }),
      /sameRoundThinkTextPolicy must be 'public' or 'private'/,
    );
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
});
