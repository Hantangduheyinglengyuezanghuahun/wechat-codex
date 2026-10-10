import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secureDir, reserveMedia, MEDIA_BUDGET } from '../src/storage.js';
import { State, MAX_REPLIES } from '../src/state.js';
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-storage-')); t.after(() => fs.rmSync(dir, { recursive:true, force:true })); return dir; }
test('existing private directories are tightened and symlink directories and state files refused', t => {
  const dir = temp(t); fs.chmodSync(dir, 0o777); secureDir(dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const target = temp(t); fs.symlinkSync(target, path.join(dir, 'link'));
  assert.throws(() => secureDir(path.join(dir, 'link', 'nested')), /symlink/);
  fs.writeFileSync(path.join(target, 'state'), '{}'); fs.symlinkSync(path.join(target, 'state'), path.join(dir, 'state.json'));
  assert.throws(() => new State(dir), /regular/);
});
test('media budget rejects further storage without deleting existing inputs', t => {
  const dir = temp(t); fs.mkdirSync(path.join(dir, 'inbound'));
  const file = path.join(dir, 'inbound', 'large'); fs.writeFileSync(file, ''); fs.truncateSync(file, MEDIA_BUDGET);
  assert.throws(() => reserveMedia(dir, 1), /storage is full/);
  assert.equal(fs.statSync(file).size, MEDIA_BUDGET);
});
test('reply storage stays bounded and reports dropped replies', t => {
  const state = new State(temp(t));
  state.data.outbox = Array.from({ length: MAX_REPLIES }, (_, n) => ({ id: String(n), text: 'old' }));
  state.enqueue('owner', 'latest');
  assert.equal(state.data.outbox.length, MAX_REPLIES); assert.equal(state.data.outbox.at(-1).text, 'latest'); assert.equal(state.data.droppedReplies, 1);
});
