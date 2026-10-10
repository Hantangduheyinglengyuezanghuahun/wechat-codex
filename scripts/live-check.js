import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Codex } from '../src/rpc.js';
import { Controller } from '../src/core.js';
import { State } from '../src/state.js';

// This script never connects to WeChat. --inference opts into a small real Codex turn.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-codex-live-'));
const rpc = new Codex({ bin: process.env.WECHAT_CODEX_BIN ?? 'codex', cwd: dir });
const state = new State(path.join(dir, 'state'));
const controller = new Controller({ rpc, state, cwd: dir, owner: 'local-test' });
let threadId;
try {
  await rpc.start();
  const models = await controller.modelList(); assert.ok(models.length);
  console.log(`Handshake passed; ${models.length} native model entries.`);
  threadId = await controller.newThread('local-test');
  await controller.handle('local-test', '/model');
  await controller.handle('local-test', '/permissions');
  await controller.handle('local-test', '/plan on');
  await controller.handle('local-test', '/plan off');
  await controller.handle('local-test', '/skills');
  await controller.handle('local-test', '/goal');
  await controller.handle('local-test', '/model default');
  console.log('Native new thread, model, permissions, plan toggles, skills, and goal read passed.');
  if (process.argv.includes('--inference')) {
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Inference timed out.')), 180000);
      rpc.on('notification', message => {
        if (message.method === 'turn/completed' && message.params.threadId === threadId) {
          clearTimeout(timer); resolve(message.params.turn);
        }
      });
    });
    const prompt = 'Reply with exactly WECHAT_CODEX_LOCAL_OK. Do not use any tools.';
    await controller.handle('local-test', prompt);
    const turn = await done;
    assert.equal(turn.status, 'completed', turn.error?.message);
    const history = await rpc.request('thread/turns/list', { threadId, limit: 2, itemsView: 'full' });
    const userItem = history.data.flatMap(t => t.items).find(i => i.type === 'userMessage');
    assert.equal(userItem.content.find(i => i.type === 'text').text, prompt);
    assert.ok(state.data.outbox.some(m => m.text.trim() === 'WECHAT_CODEX_LOCAL_OK'));
    const response = await rpc.request('thread/resume', { threadId, excludeTurns: true });
    assert.equal(response.thread.id, threadId);
    console.log('Real inference, reply capture, exact stored user text, history, and session resume passed.');
  }
} finally {
  if (threadId) await rpc.request('thread/archive', { threadId }).catch(() => {});
  await rpc.stop(); fs.rmSync(dir, { recursive: true, force: true });
}
