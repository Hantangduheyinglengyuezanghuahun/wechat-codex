import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { secureDir, secureFile, removeSnapshot } from './storage.js';
export const MAX_REPLIES = 1000;
export const MAX_REPLY_BYTES = 4 * 1024 * 1024;

export function saveJson(file, value) {
  secureDir(path.dirname(file));
  secureFile(file);
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

export class State {
  constructor(dir) {
    this.dir = secureDir(dir);
    secureFile(path.join(dir, 'state.json'));
    secureFile(path.join(dir, 'account.json'));
    this.file = path.join(dir, 'state.json');
    this.data = readJson(this.file, {
      version: 1, cursor: '', chats: {}, threads: {}, inbox: [], outbox: [], seen: [],
    });
    if (this.data.version !== 1) throw new Error('Unsupported state version.');
    for (const item of this.data.outbox) if (item.file && item.exportPolicyVersion !== 1) { item.failed = true; item.lastError = 'legacy_export_requeue_from_exports'; }

  }
  save() { saveJson(this.file, this.data); }
  chat(id) {
    return this.data.chats[id] ??= { threadId: null, uploads: [], staging: false, locale: 'en' };
  }
  enqueue(user, text, file = null) {
    while (this.data.outbox.length && (this.data.outbox.length >= MAX_REPLIES || Buffer.byteLength(JSON.stringify(this.data.outbox)) + Buffer.byteLength(String(text)) > MAX_REPLY_BYTES)) {
      const removed = this.data.outbox.shift(); removeSnapshot(this.dir, removed.file);
      this.data.droppedReplies = (this.data.droppedReplies ?? 0) + 1;
    }
    text = String(text);
    if (Buffer.byteLength(text) > MAX_REPLY_BYTES / 2) text = 'Reply exceeds delivery storage limit. Retrieve the result locally.';
    this.data.outbox.push({ id: randomUUID(), user, text, file, createdAt: Date.now(), attempts: 0, ...(file ? { exportPolicyVersion: 1 } : {}) });
    this.save();
  }
  ingest(messages, cursor, owner) {
    for (const message of messages) {
      if (message.from_user_id !== owner || message.group_id || message.message_type !== 1) continue;
      if (message.message_state !== undefined && message.message_state !== 2) continue;
      const key = message.message_id ?? message.client_id ?? message.seq;
      if (key === undefined) continue;
      const id = `${owner}:${key}`;
      if (message.context_token) this.chat(owner).contextToken = message.context_token;
      if (this.data.seen.includes(id) || this.data.inbox.some(m => m.id === id)) continue;
      if (Buffer.byteLength(JSON.stringify(message)) > 64 * 1024) {
        this.data.rejectedMessages = (this.data.rejectedMessages ?? 0) + 1;
        continue;
      }
      if (this.data.inbox.length >= 1000 || Buffer.byteLength(JSON.stringify(this.data.inbox)) + Buffer.byteLength(JSON.stringify(message)) > 4 * 1024 * 1024) throw new Error('Incoming queue full; polling will retry after queued messages are processed.');
      this.data.inbox.push({ id, clientId: randomUUID(), message, status: 'queued' });
    }
    if (typeof cursor === 'string') this.data.cursor = cursor;
    this.save();
  }
  finish(entry) {
    this.data.inbox = this.data.inbox.filter(m => m.id !== entry.id);
    this.data.seen.push(entry.id);
    this.data.seen = this.data.seen.slice(-10000);
    this.save();
  }
}

export function acquireLock(dir) {
  secureDir(dir);
  const file = path.join(dir, 'serve.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
      return () => { if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === String(process.pid)) fs.unlinkSync(file); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Unrecognized serve.lock; inspect it before removing it.');
      try { process.kill(pid, 0); }
      catch (e) { if (e.code === 'ESRCH') { fs.unlinkSync(file); continue; } throw e; }
      throw new Error(`Already running (PID ${pid}).`);
    }
  }
  throw new Error('Could not acquire the service lock.');
}
