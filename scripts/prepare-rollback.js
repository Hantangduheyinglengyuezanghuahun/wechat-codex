import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, saveJson, State, acquireLock } from '../src/state.js';
import { existingBridgeRunning } from '../src/runtime.js';

const dir = path.resolve(process.env.WECHAT_CODEX_STATE ?? path.join(os.homedir(), '.wechat-codex'));
if (existingBridgeRunning()) throw new Error('Stop the original CodexBridge before preparing rollback.');
const unlock = acquireLock(dir);
try {
  const account = readJson(path.join(dir, 'account.json'));
  if (!account.importedFrom?.endsWith('.json')) throw new Error('Rollback needs the original imported account path.');
  const old = readJson(account.importedFrom);
  if ((old.user_id ?? old.userId) !== account.userId || old.token !== account.token) throw new Error('Accounts no longer match. Pair the original client again instead of transferring this cursor.');
  const state = new State(dir);
  if (state.data.inbox.length) throw new Error('New client has pending input. Restart it and finish processing before rollback.');
  if (Object.values(state.data.threads).some(t => t.lastTurnStatus === 'inProgress')) throw new Error('A task is marked in progress. Finish or stop it in the new client before rollback.');
  if (!state.data.cursor) throw new Error('No new-client polling cursor is available.');
  const base = account.importedFrom.slice(0, -5);
  const syncFile = `${base}.sync.json`, contextFile = `${base}.context-tokens.json`;
  const suffix = `.before-wechat-codex-rollback-${Date.now()}`;
  const oldSync = readJson(syncFile, null), contexts = readJson(contextFile, {});
  if (oldSync !== null) saveJson(syncFile + suffix, oldSync);
  if (fs.existsSync(contextFile)) saveJson(contextFile + suffix, contexts);
  const context = state.chat(account.userId).contextToken;
  if (context) contexts[account.userId] = context;
  saveJson(contextFile, contexts);
  saveJson(syncFile, { ...(oldSync ?? {}), get_updates_buf: state.data.cursor });
  console.log('Original cursor/context backed up and updated. No service was started and no credentials or conversations were copied.');
  if (state.data.outbox.length) console.log('Unsent replies remain in the new client; they are not migrated.');
} finally { unlock(); }
