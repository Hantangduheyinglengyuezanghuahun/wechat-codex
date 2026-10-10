import path from 'node:path';
import os from 'node:os';
import { readJson, State, acquireLock } from '../src/state.js';
import { existingBridgeRunning } from '../src/runtime.js';

const dir = path.resolve(process.env.WECHAT_CODEX_STATE ?? path.join(os.homedir(), '.wechat-codex'));
if (existingBridgeRunning()) throw new Error('Stop the old CodexBridge before synchronizing its cursor.');
const unlock = acquireLock(dir);
try {
  const account = readJson(path.join(dir, 'account.json'));
  if (!account.importedFrom) throw new Error('The configured account was not imported.');
  const base = account.importedFrom.slice(0, -5);
  const state = new State(dir);
  if (state.data.inbox.length) throw new Error('The new client has pending inbox messages; inspect them before cursor migration.');
  const sync = readJson(`${base}.sync.json`);
  if (typeof sync.get_updates_buf !== 'string') throw new Error('The old cursor is missing.');
  state.data.cursor = sync.get_updates_buf;
  const context = readJson(`${base}.context-tokens.json`, {})[account.userId];
  if (typeof context === 'string') state.chat(account.userId).contextToken = context;
  state.save();
  console.log('Updated only the imported WeChat polling cursor and reply context.');
} finally { unlock(); }
