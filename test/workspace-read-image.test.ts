import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework } from '../src/framework.js';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { toolResultDataToHistoryString } from '../src/tool-result-history.js';

const TINY_IMAGES = {
  png: {
    mimeType: 'image/png',
    bytes: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aY4AAAAASUVORK5CYII=',
      'base64',
    ),
  },
  jpeg: {
    mimeType: 'image/jpeg',
    bytes: Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAG+AP/EABQQAQAAAAAAAAAAAAAAAAAAADD/2gAIAQEAAQUCwf/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8Bj//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8Bj//Z',
      'base64',
    ),
  },
  gif: {
    mimeType: 'image/gif',
    bytes: Buffer.from('R0lGODdhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=', 'base64'),
  },
  webp: {
    mimeType: 'image/webp',
    bytes: Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoQABAAPpFIoUylpCMiIAgAsBIJaQAA3AA/vuUAAA==', 'base64'),
  },
} as const;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function createMockResponse(text = 'ok') {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn' as const,
    rawAssistantText: text,
    toolCalls: [],
    toolResults: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    details: {
      stop: { reason: 'end_turn' as const, wasTruncated: false },
      usage: { inputTokens: 1, outputTokens: 1 },
      timing: { totalDurationMs: 1, attempts: 1 },
      model: { requested: 'mock', actual: 'mock', provider: 'mock' },
      cache: { markersInRequest: 0, tokensCreated: 0, tokensRead: 0, hitRatio: 0 },
    },
    raw: { request: {}, response: {} },
  };
}

function createIdleMembrane() {
  return {
    async complete() {
      return createMockResponse();
    },
    streamYielding() {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'complete', response: createMockResponse() };
        },
      };
    },
  } as unknown as import('@animalabs/membrane').Membrane;
}

function setupWorkspace(
  t: TestContext,
  options?: {
    mode?: 'read-write' | 'read-only';
    followSymlinks?: boolean;
    maxFileSize?: number;
  },
) {
  const root = mkdtempSync(join(tmpdir(), 'af-read-image-'));
  const mountDir = join(root, 'mount');
  mkdirSync(mountDir, { recursive: true });
  const store = JsStore.openOrCreate({ path: join(root, 'workspace.chronicle') });
  const workspace = new WorkspaceModule({
    mounts: [
      {
        name: 'work',
        path: mountDir,
        mode: options?.mode ?? 'read-write',
        watch: 'never',
        followSymlinks: options?.followSymlinks,
        maxFileSize: options?.maxFileSize,
      },
    ],
  });
  workspace.initStore(store);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    mountDir,
    store,
    workspace,
    treeStateId: 'workspace/work/tree',
  };
}

async function callReadImage(workspace: WorkspaceModule, path: string) {
  return workspace.handleToolCall({
    id: 'call-1',
    name: 'read_image',
    input: { path },
  });
}

function expectImageResult(
  result: Awaited<ReturnType<typeof callReadImage>>,
  path: string,
  expected: { bytes: Buffer; mimeType: string },
) {
  assert.equal(result.success, true);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.data, [
    {
      type: 'text',
      text: `Path: ${path}\nMIME: ${expected.mimeType}\nBytes: ${expected.bytes.byteLength}`,
    },
    {
      type: 'image',
      data: expected.bytes.toString('base64'),
      mimeType: expected.mimeType,
    },
  ]);
}

test('tool inventory/schema includes workspace--read_image', async (t) => {
  const frameworkRoot = mkdtempSync(join(tmpdir(), 'af-read-image-fw-'));
  const workspace = new WorkspaceModule({
    mounts: [
      {
        name: 'work',
        path: join(frameworkRoot, 'mount'),
        mode: 'read-write',
        watch: 'never',
      },
    ],
  });
  const framework = await AgentFramework.create({
    storePath: join(frameworkRoot, 'framework.chronicle'),
    membrane: createIdleMembrane(),
    agents: [{ name: 'assistant', model: 'mock', systemPrompt: 'test' }],
    modules: [workspace],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
  t.after(async () => {
    await framework.stop();
    rmSync(frameworkRoot, { recursive: true, force: true });
  });

  const tool = framework.getAllTools().find((entry) => entry.name === 'workspace--read_image');
  assert.ok(tool);
  assert.equal(tool.description, 'Read an image file from the workspace and return native image content.');
  assert.deepEqual(tool.inputSchema, {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Image file path (mount-prefixed, e.g., "project/assets/logo.png")' },
    },
    required: ['path'],
  });
});

test('valid tiny PNG, JPEG, GIF, and WebP return native image content with exact bytes and MIME', async (t) => {
  const { mountDir, workspace } = setupWorkspace(t);

  for (const [ext, image] of Object.entries(TINY_IMAGES)) {
    const path = `work/tiny.${ext}`;
    writeFileSync(join(mountDir, `tiny.${ext}`), image.bytes);
    const result = await callReadImage(workspace, path);
    expectImageResult(result, path, image);
  }
});

test('pre-existing Chronicle binary blob is preferred even when the filesystem file is absent', async (t) => {
  const { mountDir, store, workspace, treeStateId } = setupWorkspace(t);
  const image = TINY_IMAGES.png;
  const blobHash = store.storeBlob(image.bytes, image.mimeType);
  store.treeSet(treeStateId, 'chronicle-only.png', {
    blobHash,
    size: image.bytes.byteLength,
    mode: 0o644,
  });

  const result = await callReadImage(workspace, 'work/chronicle-only.png');
  expectImageResult(result, 'work/chronicle-only.png', image);
  assert.equal(existsSync(join(mountDir, 'chronicle-only.png')), false);
});

test('materialized binary file works without syncing the image through the text workspace path', async (t) => {
  const { mountDir, store, workspace, treeStateId } = setupWorkspace(t);
  const image = TINY_IMAGES.png;
  writeFileSync(join(mountDir, 'fs-only.png'), image.bytes);

  const before = store.treeGet(treeStateId, 'fs-only.png');
  assert.equal(before, null);

  const result = await callReadImage(workspace, 'work/fs-only.png');
  expectImageResult(result, 'work/fs-only.png', image);

  const after = store.treeGet(treeStateId, 'fs-only.png');
  assert.equal(after, null, 'read_image must not route binary data through ensureSynced/text blob storage');
});

test('extension and user-visible name do not override magic-byte MIME detection', async (t) => {
  const { mountDir, workspace } = setupWorkspace(t);
  writeFileSync(join(mountDir, 'mismatch.jpg'), TINY_IMAGES.png.bytes);

  const result = await callReadImage(workspace, 'work/mismatch.jpg');
  expectImageResult(result, 'work/mismatch.jpg', TINY_IMAGES.png);
});

test('unknown mount, mount root, directory, unknown/truncated/empty/oversize files fail closed', async (t) => {
  const { mountDir, workspace } = setupWorkspace(t, { maxFileSize: 16 });
  mkdirSync(join(mountDir, 'folder'));
  writeFileSync(join(mountDir, 'unknown.bin'), Buffer.from('not-an-image'));
  writeFileSync(join(mountDir, 'truncated.png'), PNG_SIGNATURE.subarray(0, 4));
  writeFileSync(join(mountDir, 'empty.png'), Buffer.alloc(0));
  writeFileSync(join(mountDir, 'too-large.png'), Buffer.alloc(17, 0xff));

  const cases = [
    { path: 'missing/file.png', error: 'Unknown mount: "missing". Available: work' },
    { path: 'work', error: 'Path is a directory: work' },
    { path: 'work/folder', error: 'Path is a directory: work/folder' },
    { path: 'work/unknown.bin', error: 'Unsupported image format: work/unknown.bin' },
    { path: 'work/truncated.png', error: 'Truncated image signature: work/truncated.png' },
    { path: 'work/empty.png', error: 'Image file is empty: work/empty.png' },
    { path: 'work/too-large.png', error: 'Image file exceeds max size (16 bytes): work/too-large.png' },
  ];

  for (const check of cases) {
    const result = await callReadImage(workspace, check.path);
    assert.equal(result.success, false);
    assert.equal(result.isError, true);
    assert.equal(result.error, check.error);
    assert.equal(result.data, undefined);
  }
});

test('lexical traversal and symlink escape fail without leaking absolute paths', async (t) => {
  const { root, mountDir, workspace } = setupWorkspace(t, { followSymlinks: true });
  const outsideDir = join(root, 'outside');
  mkdirSync(outsideDir);
  const outsideFile = join(outsideDir, 'outside.png');
  writeFileSync(outsideFile, TINY_IMAGES.png.bytes);
  symlinkSync(outsideFile, join(mountDir, 'escape.png'));

  const traversal = await callReadImage(workspace, 'work/../outside/outside.png');
  assert.equal(traversal.success, false);
  assert.equal(traversal.isError, true);
  assert.equal(traversal.error, 'Path traversal detected: "work/../outside/outside.png" resolves outside mount "work"');
  assert.ok(!traversal.error?.includes(root));

  const escape = await callReadImage(workspace, 'work/escape.png');
  assert.equal(escape.success, false);
  assert.equal(escape.isError, true);
  assert.equal(escape.error, 'Symlink escape detected: work/escape.png');
  assert.ok(!escape.error?.includes(root));
  assert.ok(!escape.error?.includes(outsideFile));
});

test('read-only mounts can still read images', async (t) => {
  const { mountDir, workspace } = setupWorkspace(t, { mode: 'read-only' });
  writeFileSync(join(mountDir, 'readonly.png'), TINY_IMAGES.png.bytes);

  const result = await callReadImage(workspace, 'work/readonly.png');
  expectImageResult(result, 'work/readonly.png', TINY_IMAGES.png);
});

test('framework native conversion emits an image block for the live round and history stays placeholder-only', async (t) => {
  const { mountDir, workspace } = setupWorkspace(t);
  writeFileSync(join(mountDir, 'native.png'), TINY_IMAGES.png.bytes);

  const result = await callReadImage(workspace, 'work/native.png');
  expectImageResult(result, 'work/native.png', TINY_IMAGES.png);

  const framework = Object.create(AgentFramework.prototype) as any;
  const live = framework.toMembraneToolResult('call-1', result as { success: true; data: unknown });
  assert.deepEqual(live, {
    toolUseId: 'call-1',
    isError: false,
    content: [
      {
        type: 'text',
        text: `Path: work/native.png\nMIME: image/png\nBytes: ${TINY_IMAGES.png.bytes.byteLength}`,
      },
      {
        type: 'image',
        source: {
          type: 'base64',
          data: TINY_IMAGES.png.bytes.toString('base64'),
          mediaType: 'image/png',
        },
      },
    ],
  });

  const history = toolResultDataToHistoryString(result.data);
  assert.ok(history.includes('Path: work/native.png'));
  assert.ok(history.includes('[image: image/png,'));
  assert.ok(!history.includes(TINY_IMAGES.png.bytes.toString('base64')));
});
