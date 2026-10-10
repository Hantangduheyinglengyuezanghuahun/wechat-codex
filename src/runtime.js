import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { State, acquireLock } from './state.js';
import { Codex } from './rpc.js';
import { WeChat } from './wechat.js';
import { Controller } from './core.js';

export function existingBridgeRunning() {
  if (process.platform !== 'linux') return false;
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const dir = `/proc/${name}`;
      if (fs.statSync(dir).uid !== process.getuid()) continue;
      const args = fs.readFileSync(`${dir}/cmdline`, 'utf8').split('\0');
      if (args.some(a => /CodexBridge\/src\/cli\.(?:ts|js)$/.test(a)) && args.includes('weixin') && args.includes('serve')) return true;
    } catch { /* A process may exit while /proc is being inspected. */ }
  }
  return false;
}

export async function receive(controller, transport, entry) {
  const message = entry.message;
  const text = []; const files = [];
  for (const item of message.item_list ?? []) {
    if (item.type === 1 && typeof item.text_item?.text === 'string') text.push(item.text_item.text);
    else if (item.type === 3 && item.voice_item?.text) text.push(item.voice_item.text);
    else if ([2, 3, 4, 5].includes(item.type)) {
      const file = await transport.download(item, path.join(controller.state.dir, 'inbound'));
      if (file) files.push(file);
    }
    // Quoted content is deliberately not promoted to instructions or a new user message.
  }
  await controller.handle(message.from_user_id, text.join('\n'), files, entry.id);
}

export async function drainInbox(controller, transport) {
  const state = controller.state;
  const entry = state.data.inbox.find(e => e.status === 'queued');
  if (!entry) return false;
  entry.status = 'processing'; state.save();
  try { await receive(controller, transport, entry); }
  catch (error) { controller.say(entry.message.from_user_id, `Error: ${error.message}`); }
  state.finish(entry);
  return true;
}

export async function deliverNext(state, transport, now = Date.now()) {
  const item = state.data.outbox[0];
  if (!item || (item.nextAt ?? 0) > now) return false;
  const context = state.chat(item.user).contextToken;
  if (!context) return false;
  try {
    if (item.file && !item.media) { item.media = await transport.upload(item.file, item.user); state.save(); }
    if (item.media) await transport.sendItems(item.user, context, [item.media], item.id);
    else await transport.text(item.user, context, item.text, item.id);
    state.data.outbox.shift(); state.save(); return true;
  } catch (error) {
    item.attempts++;
    item.nextAt = now + Math.min(60000, 1000 * 2 ** Math.min(item.attempts, 6));
    item.lastError = error.code ?? 'delivery_failed'; state.save();
    if (error.code === -14) throw error;
    return false;
  }
}

export async function serve({ dir, cwd, bin, account }) {
  if (!account.token || !account.userId) throw new Error('Run login or import-account first. A paired owner is required.');
  if (account.importedFrom && existingBridgeRunning()) throw new Error('The old CodexBridge is still polling this account. Stop it before starting this service.');
  const unlock = acquireLock(dir);
  const state = new State(dir);
  const rpc = new Codex({ bin, cwd });
  const controller = new Controller({ rpc, state, cwd, owner: account.userId });
  const transport = new WeChat(account);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const sleep = ms => delay(ms, undefined, { signal: abort.signal }).catch(() => {});
  try {
    await rpc.start();
    for (const entry of [...state.data.inbox]) {
      if (entry.status === 'processing') {
        controller.say(account.userId, 'A message was in progress when the service stopped. It was not replayed. Check /peek and /status before resending.');
        state.finish(entry);
      }
    }
    console.log('WeChat Codex Local is running. Send /help from the paired WeChat account.');
    const polling = async () => {
      let failures = 0;
      while (!abort.signal.aborted) {
        try {
          const batch = await transport.updates(state.data.cursor, abort.signal);
          state.ingest(batch.msgs ?? [], batch.get_updates_buf, account.userId);
          if ((batch.msgs ?? []).some(m => m.from_user_id === account.userId && m.context_token)) {
            for (const reply of state.data.outbox) reply.nextAt = 0;
            state.save();
          }
          failures = 0;
          if (!batch.msgs?.length) await sleep(250);
        } catch (error) {
          if (abort.signal.aborted) break;
          if (error.code === -14) throw error;
          // Long-poll expiration is normal; keep the durable cursor and reconnect.
          if (error.name !== 'TimeoutError' && error.name !== 'AbortError') console.error('WeChat polling unavailable; retrying.');
          await sleep(Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)));
        }
      }
    };
    const receiving = async () => {
      while (!abort.signal.aborted) { if (!await drainInbox(controller, transport)) await sleep(200); }
    };
    const sending = async () => {
      while (!abort.signal.aborted) { await deliverNext(state, transport); await sleep(700); }
    };
    const typing = async () => {
      while (!abort.signal.aborted) {
        if (controller.active.size && state.chat(account.userId).contextToken) {
          await transport.typing(account.userId, state.chat(account.userId).contextToken).catch(() => {});
        }
        await sleep(15000);
      }
    };
    const workers = [polling, receiving, sending, typing].map(fn => fn().catch(error => { stop(); throw error; }));
    const results = await Promise.allSettled(workers);
    const failed = results.find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
  } finally {
    stop();
    await rpc.stop(); unlock();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
