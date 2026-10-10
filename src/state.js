import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
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
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.data = readJson(this.file, {
      version: 1, cursor: '', chats: {}, threads: {}, inbox: [], outbox: [], seen: [],
    });
    if (this.data.version !== 1) throw new Error('Unsupported state version.');
  }
  save() { saveJson(this.file, this.data); }
  chat(id) {
    return this.data.chats[id] ??= { threadId: null, uploads: [], staging: false, locale: 'en' };
  }
  enqueue(user, text, file = null) {
    this.data.outbox.push({ id: randomUUID(), user, text, file, createdAt: Date.now(), attempts: 0 });
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
      this.data.inbox.push({ id, message, status: 'queued' });
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
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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
