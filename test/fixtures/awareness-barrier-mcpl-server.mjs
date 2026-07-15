import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const statusPath = process.env.STATUS_PATH;
const ledgerPath = process.env.LEDGER_PATH;
const releasePath = process.env.RELEASE_PATH;
const crashPath = process.env.CRASH_PATH;
const generationPath = process.env.GENERATION_PATH;
const listChangePath = process.env.LIST_CHANGE_PATH;
const failReaction = process.env.FAIL_REACTION === '1';

let generation = 1;
if (generationPath) {
  try {
    generation = Number(readFileSync(generationPath, 'utf8')) + 1;
  } catch {
    // First process for this test.
  }
  writeFileSync(generationPath, String(generation));
}

const log = (event, extra = {}) => {
  if (!statusPath) return;
  appendFileSync(statusPath, JSON.stringify({ event, generation, ...extra }) + '\n');
};
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const request = (id, method, params) => send({ jsonrpc: '2.0', id, method, params });
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const channel = (suffix) => ({
  id: `discord:guild:${suffix}`,
  type: 'discord',
  label: suffix,
  direction: 'bidirectional',
});

let initialized = false;
let registered = false;
let pendingToolRequest = null;
let pendingControl = false;
let listChangeTriggered = false;
let buf = '';

function ledgerDeliveryStatus() {
  if (!ledgerPath) return 'missing';
  try {
    const document = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    return document.batches?.[0]?.refs?.[0]?.deliveryStatus ?? 'missing';
  } catch {
    return 'unreadable';
  }
}

function maybeReplyToReaction() {
  if (!pendingToolRequest || pendingControl || failReaction) return;
  if (releasePath && !existsSync(releasePath)) return;
  const requestId = pendingToolRequest.id;
  pendingToolRequest = null;
  log('reaction-response');
  reply(requestId, { content: [{ type: 'text', text: 'Reaction applied' }] });
}

function serviceReaction(message) {
  if (!registered) {
    pendingToolRequest = message;
    log('reaction-queued-before-registration');
    return;
  }
  pendingToolRequest = message;
  pendingControl = true;
  log('reaction-call', { name: message.params?.name });
  request(201, 'channels/register', { channels: [channel('control-during-barrier')] });
}

function beginServerTraffic() {
  if (initialized) return;
  initialized = true;
  log('initialized');
  request(200, 'channels/register', { channels: [channel('startup')] });
  // The reconnect generation carries an inference-bearing event in the same
  // registration window. Initial-start tests use generation 1 as well.
  request(202, 'push/event', {
    featureSet: 'chat',
    eventId: `barrier-push-${generation}`,
    timestamp: new Date().toISOString(),
    payload: { content: [{ type: 'text', text: 'must wait for awareness' }] },
  });
}

function handle(message) {
  if (message.method === 'initialize') {
    reply(message.id, {
      capabilities: {
        experimental: {
          mcpl: {
            version: '0.4',
            pushEvents: true,
            featureSets: {
              chat: { description: 'chat', uses: ['pushEvents'] },
            },
          },
        },
      },
    });
    return;
  }
  if (message.method === 'notifications/initialized') {
    beginServerTraffic();
    return;
  }
  if (message.method === 'tools/list') {
    log('tools-list');
    reply(message.id, {
      tools: [
        { name: 'add_reaction', description: 'add', inputSchema: { type: 'object' } },
        { name: 'remove_reaction', description: 'remove', inputSchema: { type: 'object' } },
      ],
    });
    return;
  }
  if (message.method === 'tools/call') {
    serviceReaction(message);
    return;
  }
  if (message.id === 200) {
    registered = true;
    log('registration-response');
    const queued = pendingToolRequest;
    pendingToolRequest = null;
    if (queued) serviceReaction(queued);
    return;
  }
  if (message.id === 201) {
    pendingControl = false;
    log('control-response-during-barrier');
    maybeReplyToReaction();
    return;
  }
  if (message.id === 202 || message.id === 302) {
    log(message.id === 202 ? 'push-response' : 'list-change-push-response', {
      accepted: message.result?.accepted,
      ledgerStatus: ledgerDeliveryStatus(),
    });
  }
}

process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let newline;
  while ((newline = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, newline);
    buf = buf.slice(newline + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      log('server-error', { message: error instanceof Error ? error.message : String(error) });
    }
  }
});

const timer = setInterval(() => {
  maybeReplyToReaction();
  if (listChangePath && existsSync(listChangePath) && !listChangeTriggered) {
    listChangeTriggered = true;
    log('tools-list-changed-notification');
    send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} });
    request(302, 'push/event', {
      featureSet: 'chat',
      eventId: `list-change-push-${generation}`,
      timestamp: new Date().toISOString(),
      payload: { content: [{ type: 'text', text: 'must wait for list-change awareness' }] },
    });
  }
  if (crashPath && existsSync(crashPath) && generation === 1) {
    log('crashing');
    process.exit(7);
  }
}, 5);
timer.unref();
