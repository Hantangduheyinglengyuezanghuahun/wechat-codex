import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { State } from '../src/state.js';
import { Controller } from '../src/core.js';
import { drainInbox, deliverNext } from '../src/runtime.js';

const ID = '01234567-0123-4123-8123-012345678901';
const OTHER = '01234567-0123-4123-8123-012345678902';
class FakeCodex extends EventEmitter {
  constructor(cwd) { super(); this.cwd = cwd; this.calls = []; this.responses = []; this.child = {}; this.next = 0; }
  async request(method, params) {
    this.calls.push({ method, params: structuredClone(params) });
    if (['thread/start', 'thread/resume', 'thread/fork'].includes(method)) return {
      thread: { id: params.threadId ?? ID, cwd: this.cwd, turns: [] }, cwd: this.cwd, model: 'example-model',
      modelProvider: 'openai', reasoningEffort: 'medium', approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' },
      serviceTier: null, instructionSources: [],
    };
    if (method === 'turn/start') {
      this.emit('notification', { method: 'turn/started', params: { threadId: params.threadId, turn: { id: 'turn-1' } } });
      return { turn: { id: 'turn-1' } };
    }
    if (method === 'model/list') return { data: [{ model: 'example-model', isDefault: true, description: 'test', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }], serviceTiers: [{ id: 'fast' }] }] };
    if (method === 'config/read') return { config: { model: 'example-model', model_reasoning_effort: 'medium' } };
    if (method === 'thread/search') return { data: [{ thread: { id: ID, name: 'Match', cwd: this.cwd }, snippet: 'matching words' }], nextCursor: null };
    if (method === 'thread/list') return { data: [{ id: params.cursor ? OTHER : ID, name: 'Sample', cwd: this.cwd }], nextCursor: params.cursor ? null : 'page-2' };
    if (method === 'thread/turns/list') return { data: [], nextCursor: null };
    if (method === 'permissionProfile/list') return { data: [{ id: 'workspace', allowed: true }] };
    return {};
  }
  respond(id, result) { this.responses.push({ id, result }); }
  reject(id) { this.responses.push({ id, rejected: true }); }
  async start() { this.child = {}; }
  async stop() { this.child = null; this.emit('disconnected'); }
}
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-codex-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = new State(dir); const rpc = new FakeCodex(dir);
  const controller = new Controller({ rpc, state, cwd: dir, owner: 'owner' });
  return { dir, state, rpc, controller };
}
const incoming = (id, text, user = 'owner') => ({ message_id: id, message_type: 1, message_state: 2, from_user_id: user, context_token: 'context', item_list: [{ type: 1, text_item: { text } }] });

test('WeChat → native turn → WeChat preserves text, instructions and replies', async t => {
  const { controller: c, state, rpc } = setup(t);
  const text = '  中文 👋\nKeep $HOME, `code`, and whitespace.\n';
  state.ingest([incoming('100', text)], 'cursor-1', 'owner');
  await drainInbox(c, {});
  assert.deepEqual(rpc.calls.find(x => x.method === 'thread/start').params, { cwd: c.cwd });
  const start = rpc.calls.find(x => x.method === 'turn/start');
  assert.deepEqual(start.params, { threadId: ID, input: [{ type: 'text', text, text_elements: [] }], clientUserMessageId: 'owner:100' });
  c.notification({ method: 'item/completed', params: { threadId: ID, item: { type: 'agentMessage', id: 'reply-1', text: ' 原样 reply\n', phase: 'final_answer' } } });
  c.notification({ method: 'turn/completed', params: { threadId: ID, turn: { id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', id: 'reply-1', text: ' 原样 reply\n' }] } } });
  assert.equal(state.data.outbox.length, 1);
  const sent = [];
  await deliverNext(state, { text: (...args) => sent.push(args) });
  assert.equal(sent[0][2], ' 原样 reply\n');
  assert.equal(c.active.size, 0);
  assert.equal(state.data.cursor, 'cursor-1');
});

test('duplicate delivery, unauthorized senders and group messages never start extra turns', async t => {
  const { controller: c, state, rpc } = setup(t);
  state.ingest([incoming('1', 'hello'), incoming('1', 'hello'), incoming('2', 'bad', 'outsider'), { ...incoming('3', 'group'), group_id: 'g' }], 'c', 'owner');
  await drainInbox(c, {});
  const reloaded = new State(state.dir);
  reloaded.ingest([incoming('1', 'hello')], 'd', 'owner');
  assert.equal(reloaded.data.inbox.length, 0);
  await c.handle('outsider', '/new');
  assert.equal(rpc.calls.filter(x => x.method === 'turn/start').length, 1);
});

test('delivery failures retry stable reply ID without retrying Codex', async t => {
  const { state, controller: c, rpc } = setup(t);
  state.chat('owner').contextToken = 'ctx'; c.say('owner', 'result');
  const id = state.data.outbox[0].id;
  await deliverNext(state, { text: async () => { throw new Error('offline'); } }, 100);
  assert.equal(state.data.outbox[0].id, id);
  const reboot = new State(state.dir); const sent = [];
  await deliverNext(reboot, { text: (...args) => sent.push(args) }, 100000);
  assert.equal(sent[0][3], id); assert.equal(rpc.calls.length, 0); assert.equal(reboot.data.outbox.length, 0);
});

test('processing inbox entry is not silently rerun after restart', async t => {
  const { state, controller: c, rpc } = setup(t);
  state.ingest([incoming('1', 'do work')], 'c', 'owner'); state.data.inbox[0].status = 'processing'; state.save();
  c.state = new State(state.dir);
  assert.equal(await drainInbox(c, {}), false); assert.equal(rpc.calls.length, 0);
});

test('model controls use native settings and validate effort; plan uses built-in instructions', async t => {
  const { controller: c, rpc } = setup(t);
  await c.handle('owner', '/model example-model high');
  await c.handle('owner', '/plan on');
  await assert.rejects(c.handle('owner', '/model ultra'), /reasoning effort/);
  await c.handle('owner', '/fast on');
  const calls = rpc.calls.filter(x => x.method === 'thread/settings/update');
  assert.deepEqual(calls[0].params, { threadId: ID, model: 'example-model', effort: 'high' });
  assert.deepEqual(calls[1].params.collaborationMode, { mode: 'plan', settings: { model: 'example-model', reasoning_effort: 'high', developer_instructions: null } });
  assert.equal(calls[2].params.serviceTier, 'fast');
  assert.equal(rpc.calls.some(x => x.method === 'turn/start'), false);
});

test('session paging selects from the displayed page, resumes without injected history', async t => {
  const { controller: c, rpc, state } = setup(t);
  await c.handle('owner', '/threads'); await c.handle('owner', '/next'); await c.handle('owner', '/open 1');
  assert.equal(state.chat('owner').threadId, OTHER);
  assert.deepEqual(rpc.calls.find(x => x.method === 'thread/resume').params, { threadId: OTHER, excludeTurns: true });
  await c.handle('owner', '/prev'); await c.handle('owner', '/open 1');
  assert.equal(state.chat('owner').threadId, ID);
});

test('new text during a turn steers it with the native turn precondition', async t => {
  const { controller: c, rpc } = setup(t);
  await c.handle('owner', 'first'); await c.handle('owner', 'Correction: use Python.');
  const call = rpc.calls.at(-1);
  assert.equal(call.method, 'turn/steer'); assert.equal(call.params.expectedTurnId, 'turn-1');
  assert.equal(call.params.input[0].text, 'Correction: use Python.');
  await assert.rejects(c.handle('owner', '/retry'), /still running/);
});

test('approvals keep server IDs and permission grants limited to the requested scope', async t => {
  const { controller: c, rpc } = setup(t); await c.ensure('owner');
  c.serverRequest({ id: 31, method: 'item/permissions/requestApproval', params: { threadId: ID, turnId: 't', permissions: { network: { enabled: true }, fileSystem: null } } });
  const key = [...c.pending.keys()][0];
  assert.equal(rpc.responses.length, 0);
  await c.handle('owner', `/allow ${key}`);
  assert.deepEqual(rpc.responses[0], { id: 31, result: { permissions: { network: { enabled: true } }, scope: 'turn' } });
  await assert.rejects(c.handle('owner', `/allow ${key}`), /current request ID/);
});

test('blocking user questions accept the owner response and clear resolved IDs', async t => {
  const { controller: c, rpc } = setup(t); await c.ensure('owner');
  c.serverRequest({ id: 'q1', method: 'item/tool/requestUserInput', params: { threadId: ID, turnId: 't', questions: [{ id: 'language', question: 'Language?', options: [] }] } });
  const key = [...c.pending.keys()][0]; await c.handle('owner', `/answer ${key} Python please`);
  assert.deepEqual(rpc.responses[0], { id: 'q1', result: { answers: { language: { answers: ['Python please'] } } } });
  c.serverRequest({ id: 'q2', method: 'item/commandExecution/requestApproval', params: { threadId: ID } });
  c.notification({ method: 'serverRequest/resolved', params: { threadId: ID, requestId: 'q2' } });
  assert.equal(c.pending.size, 0);
});

test('attachments use native typed input and survive failed submissions', async t => {
  const { controller: c, rpc, state } = setup(t);
  const files = [{ path: '/tmp/picture.png', name: 'picture.png', kind: 'image' }, { path: '/tmp/a.txt', name: 'a.txt', kind: 'file' }];
  await c.handle('owner', '', files); assert.equal(rpc.calls.length, 0);
  await assert.rejects(c.handle('owner', '/new'), /staged attachments/);
  await c.handle('owner', 'Read these.');
  assert.deepEqual(rpc.calls.find(x => x.method === 'turn/start').params.input, [
    { type: 'text', text: 'Read these.', text_elements: [] }, { type: 'localImage', path: '/tmp/picture.png' }, { type: 'mention', name: 'a.txt', path: '/tmp/a.txt' },
  ]);
  assert.equal(state.chat('owner').uploads.length, 0);
  await c.handle('owner', '', files);
  const original = rpc.request.bind(rpc);
  rpc.request = (method, params) => method === 'turn/steer' ? Promise.reject(new Error('disconnected')) : original(method, params);
  await assert.rejects(c.handle('owner', 'try again'), /disconnected/);
  assert.equal(state.chat('owner').uploads.length, 2);
});

test('unknown slash commands cannot become implicit prompts; /send is explicit', async t => {
  const { controller: c, rpc } = setup(t);
  await assert.rejects(c.handle('owner', '/unknown instructions'), /Unknown command/);
  assert.equal(rpc.calls.length, 0);
  await c.handle('owner', '/send /unknown instructions');
  assert.equal(rpc.calls.find(x => x.method === 'turn/start').params.input[0].text, '/unknown instructions');
});

test('short completed turns do not become active again when start response resolves', async t => {
  const { controller: c, rpc } = setup(t); const original = rpc.request.bind(rpc);
  rpc.request = async (method, params) => {
    const result = await original(method, params);
    if (method === 'turn/start') c.notification({ method: 'turn/completed', params: { threadId: ID, turn: { id: 'turn-1', status: 'completed', items: [] } } });
    return result;
  };
  await c.handle('owner', 'hi'); assert.equal(c.active.size, 0);
});


test('native full-text search uses results as session indices', async t => {
  const { controller: c, rpc } = setup(t);
  await c.handle('owner', '/search previous problem');
  assert.equal(rpc.calls[0].method, 'thread/search');
  assert.equal(rpc.calls[0].params.searchTerm, 'previous problem');
  await c.handle('owner', '/open 1');
  assert.equal(c.state.chat('owner').threadId, ID);
});

test('batch staging preserves attachment captions when the final task arrives', async t => {
  const { controller: c, rpc } = setup(t);
  await c.handle('owner', '/up');
  await c.handle('owner', 'Caption  with spaces.', [{ path: '/tmp/a.png', name: 'a.png', kind: 'image' }]);
  await c.handle('owner', 'Describe it.');
  const input = rpc.calls.find(x => x.method === 'turn/start').params.input;
  assert.equal(input[0].text, 'Caption  with spaces.\nDescribe it.');
});

test('native child-agent approvals retain owner routing without duplicate agent replies', async t => {
  const { controller: c, rpc, state } = setup(t); await c.ensure('owner');
  c.notification({ method: 'thread/started', params: { thread: { id: OTHER, parentThreadId: ID, cwd: c.cwd } } });
  c.serverRequest({ id: 42, method: 'item/commandExecution/requestApproval', params: { threadId: OTHER, turnId: 'child-turn', command: 'echo hi' } });
  const key = [...c.pending.keys()][0];
  await c.handle('owner', `/deny ${key}`);
  assert.deepEqual(rpc.responses[0], { id: 42, result: { decision: 'decline' } });
  state.data.outbox = [];
  c.notification({ method: 'item/completed', params: { threadId: OTHER, item: { id: 'a', type: 'agentMessage', text: 'child output' } } });
  assert.equal(state.data.outbox.length, 0);
});

test('answer formatting is preserved and misspelled approval scopes are rejected', async t => {
  const { controller: c, rpc } = setup(t); await c.ensure('owner');
  c.serverRequest({ id: 40, method: 'item/tool/requestUserInput', params: { threadId: ID, questions: [{ id: 'q', question: 'Details?' }] } });
  let key = [...c.pending.keys()][0];
  await c.handle('owner', `/answer ${key} a  b\nc`);
  assert.equal(rpc.responses[0].result.answers.q.answers[0], 'a  b\nc');
  c.serverRequest({ id: 41, method: 'item/commandExecution/requestApproval', params: { threadId: ID } });
  key = [...c.pending.keys()][0];
  await assert.rejects(c.handle('owner', `/allow ${key} typo`), /Usage/);
  assert.equal(rpc.responses.length, 1);
});

test('delivery clear leaves native history and never starts another turn', async t => {
  const { controller: c, state, rpc } = setup(t);
  c.say('owner', 'undeliverable reply');
  await c.handle('owner', '/outbox clear');
  assert.equal(state.data.outbox.length, 1);
  assert.match(state.data.outbox[0].text, /Cleared 1/);
  assert.equal(rpc.calls.length, 0);
});


test('explicit downloads snapshot bytes before later workspace changes', async t => {
  const { controller: c, state, dir } = setup(t);
  const file = path.join(dir, 'report.txt'); fs.writeFileSync(file, 'first version');
  await c.handle('owner', '/download report.txt');
  const delivery = state.data.outbox.find(m => m.file);
  fs.writeFileSync(file, 'changed later');
  assert.equal(fs.readFileSync(delivery.file, 'utf8'), 'first version');
  assert.equal(path.basename(delivery.file), 'report.txt');
  assert.equal(fs.statSync(delivery.file).mode & 0o777, 0o600);
});

test('a replayed message may refresh reply context without creating another task', t => {
  const { state } = setup(t);
  state.ingest([incoming('1', 'hello')], 'c1', 'owner');
  state.finish(state.data.inbox[0]);
  state.ingest([{ ...incoming('1', 'hello'), context_token: 'fresh-context' }], 'c2', 'owner');
  assert.equal(state.data.inbox.length, 0);
  assert.equal(state.chat('owner').contextToken, 'fresh-context');
});
