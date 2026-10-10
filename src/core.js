import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { chunks } from './wechat.js';
import { command, HELP } from './commands.js';

export const pretty = value => JSON.stringify(value, null, 2);
export function localPath(value, cwd) {
  return path.resolve(cwd, value.replace(/^~(?=\/|$)/, os.homedir()));
}
export function inputFor(text, files = []) {
  const input = [];
  if (text.length) input.push({ type: 'text', text, text_elements: [] });
  for (const file of files) {
    if (file.kind === 'image') input.push({ type: 'localImage', path: file.path });
    // CLI file mentions expose the local file without adding a prose prompt wrapper.
    else input.push({ type: 'mention', name: file.name, path: file.path });
  }
  return input;
}

const aliases = {
  h: 'help', helps: 'help', st: 'status', where: 'status', us: 'usage', lg: 'login',
  n: 'new', th: 'threads', se: 'search', nx: 'next', pv: 'prev', o: 'open', pk: 'peek', rn: 'rename',
  ms: 'models', m: 'model', sp: 'stop', al: 'allow', dn: 'deny', perm: 'permissions',
  pl: 'plan', rv: 'review', sk: 'skills', pg: 'plugins', up: 'uploads', rc: 'reconnect',
  rt: 'retry', rs: 'restart', pd: 'provider', ins: 'instructions', exp: 'experimental',
};

export class Controller {
  constructor({ rpc, state, cwd, owner }) {
    this.rpc = rpc; this.state = state; this.cwd = cwd; this.owner = owner;
    this.loaded = new Set(); this.active = new Map(); this.pending = new Map(); this.items = new Map();
    this.models = []; this.pages = new Map(); this.skillLists = new Map(); this.pluginLists = new Map();
    rpc.on('notification', message => { try { this.notification(message); } catch (e) { this.say(owner, `Event error: ${e.message}`); } });
    rpc.on('request', message => { try { this.serverRequest(message); } catch (e) { this.say(owner, `Request error: ${e.message}`); } });
    rpc.on('disconnected', () => {
      const hadWork = this.active.size > 0 || this.pending.size > 0;
      this.loaded.clear(); this.active.clear(); this.pending.clear();
      if (hadWork) this.say(owner, 'Codex disconnected. Pending approval IDs expired. Use /reconnect, then /peek to check work before /retry.');
    });
  }
  say(user, text) { for (const part of chunks(String(text))) this.state.enqueue(user, part); }
  record(id) { return this.state.data.threads[id]; }
  remember(result, user) {
    const t = result.thread;
    const previous = this.record(t.id) ?? {};
    this.state.data.threads[t.id] = {
      ...previous, owner: user, cwd: result.cwd ?? t.cwd, model: result.model ?? t.model,
      modelProvider: result.modelProvider ?? t.modelProvider, effort: result.reasoningEffort ?? t.reasoningEffort,
      serviceTier: result.serviceTier, approvalPolicy: result.approvalPolicy, approvalsReviewer: result.approvalsReviewer,
      sandboxPolicy: result.sandbox, activePermissionProfile: result.activePermissionProfile,
      mode: result.collaborationMode?.mode ?? previous.mode ?? 'default',
      instructionSources: result.instructionSources ?? [],
    };
    this.loaded.add(t.id); this.state.chat(user).threadId = t.id; this.state.save();
    return t.id;
  }
  async ensure(user) {
    const chat = this.state.chat(user);
    if (!chat.threadId) return this.newThread(user);
    if (!this.loaded.has(chat.threadId)) this.remember(await this.rpc.request('thread/resume', { threadId: chat.threadId, excludeTurns: true }), user);
    return chat.threadId;
  }
  async newThread(user, directory = this.cwd) {
    directory = localPath(directory, this.cwd);
    if (!fs.statSync(directory).isDirectory()) throw new Error('Working directory is not a directory.');
    const result = await this.rpc.request('thread/start', { cwd: directory });
    return this.remember(result, user);
  }
  async settings(user, values) {
    const threadId = await this.ensure(user);
    if (this.active.has(threadId)) throw new Error('Wait for this turn or use /stop before changing settings.');
    await this.rpc.request('thread/settings/update', { threadId, ...values });
    const record = this.record(threadId);
    Object.assign(record, values);
    if (values.collaborationMode) record.mode = values.collaborationMode.mode;
    delete record.threadId; delete record.collaborationMode;
    this.state.save();
  }
  async handle(user, text, files = [], clientId = randomUUID()) {
    if (user !== this.owner) return;
    const chat = this.state.chat(user);
    const parsed = /^\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (text.trim() === '/') return;
    if (parsed && !files.length) {
      const name = aliases[parsed[1].toLowerCase()] ?? parsed[1].toLowerCase();
      const arg = parsed[1].toLowerCase() === 'up' && !parsed[2] ? 'begin' : parsed[2] ?? '';
      if (name === 'send') return this.submit(user, arg, chat.uploads, clientId);
      if (/^(?:-h|--help|-help|-helps)$/.test(arg)) { this.say(user, HELP[chat.locale]); return; }
      return command(this, user, name, arg);
    }
    if (files.length) {
      chat.uploads.push(...files); this.state.save();
      if (!text.length || chat.staging) {
        if (text.length) chat.stagedText = [...(chat.stagedText ?? []), text];
        this.state.save();
        this.say(user, `Saved ${files.length} attachment(s). Send your task, or /uploads send. /uploads lists paths.`);
        return;
      }
    }
    if (!text.length) return;
    const combined = [...(chat.stagedText ?? []), text].join('\n');
    return this.submit(user, combined, chat.uploads, clientId);
  }
  async submit(user, text, files, clientId) {
    const chat = this.state.chat(user);
    const threadId = await this.ensure(user);
    const input = inputFor(text, files);
    if (!input.length) throw new Error('Nothing to send.');
    const params = { threadId, input, clientUserMessageId: clientId };
    const active = this.active.get(threadId);
    chat.lastInput = { text, files: structuredClone(files), threadId };
    this.state.save();
    const result = active
      ? await this.rpc.request('turn/steer', { ...params, expectedTurnId: active })
      : await this.rpc.request('turn/start', params);
    // turn/started is authoritative: a very short turn can complete before this response arrives.
    chat.uploads = []; chat.staging = false; chat.stagedText = []; this.state.save();
    return result;
  }
  threadId(user, value) {
    if (!value) {
      const id = this.state.chat(user).threadId;
      if (!id) throw new Error('No session selected. Use /new or /threads.');
      return id;
    }
    if (/^\d+$/.test(value)) {
      const t = this.pages.get(user)?.data[Number(value) - 1];
      if (!t) throw new Error('No session at that index. Use /threads first.');
      return t.id;
    }
    if (!/^[a-f\d-]{36}$/i.test(value)) throw new Error('Use a session index or full Codex thread ID.');
    return value;
  }
  async listThreads(user, { searchTerm, cursor = null, previous = [], archived = false } = {}) {
    const searching = typeof searchTerm === 'string' && searchTerm.length > 0;
    const result = await this.rpc.request(searching ? 'thread/search' : 'thread/list', {
      limit: 10, sortKey: 'updated_at', cursor, archived,
      ...(searching ? { searchTerm } : { modelProviders: [] }),
    });
    if (searching) result.data = result.data.map(hit => ({ ...hit.thread, searchSnippet: hit.snippet }));
    this.pages.set(user, { ...result, cursor, previous, searchTerm, archived });
    const lines = result.data.map((t, i) => `${i + 1}. ${t.id === this.state.chat(user).threadId ? '* ' : ''}${t.name || t.preview?.slice(0, 100) || '(untitled)'}\n${t.id}\n${t.cwd}`);
    this.say(user, (lines.join('\n\n') || 'No sessions.') + '\n\n/open N · /peek N · /next · /prev');
  }
  async preview(user, id) {
    const r = await this.rpc.request('thread/turns/list', { threadId: id, limit: 3, sortDirection: 'desc', itemsView: 'full' });
    const lines = [];
    for (const turn of [...r.data].reverse()) {
      for (const item of turn.items ?? []) {
        if (item.type === 'userMessage') lines.push('You: ' + item.content.map(x => x.text ?? x.path ?? '').join('\n'));
        if (item.type === 'agentMessage') lines.push('Codex: ' + item.text);
      }
    }
    this.say(user, lines.join('\n\n').slice(-16000) || `Session ${id}: no messages yet.`);
  }
  async modelList() {
    const all = []; let cursor;
    do { const r = await this.rpc.request('model/list', { limit: 100, cursor }); all.push(...r.data); cursor = r.nextCursor; } while (cursor);
    this.models = all; return all;
  }
  notification({ method, params: p = {} }) {
    if (method === 'thread/started' && p.thread?.parentThreadId) {
      const parent = this.record(p.thread.parentThreadId);
      if (parent) {
        this.state.data.threads[p.thread.id] = { ...parent, parentThreadId: p.thread.parentThreadId, sentItems: [], cwd: p.thread.cwd };
        this.state.save();
      }
      return;
    }
    const t = this.record(p.threadId);
    if (method === 'account/login/completed') { this.say(this.owner, p.success ? 'Codex login completed.' : `Codex login failed: ${p.error ?? 'unknown error'}`); return; }
    if (method === 'serverRequest/resolved') {
      for (const [key, value] of this.pending) if (value.id === p.requestId) this.pending.delete(key);
      return;
    }
    if (!t) return;
    if (method === 'thread/settings/updated') {
      Object.assign(t, p.threadSettings);
      t.mode = p.threadSettings.collaborationMode?.mode ?? t.mode;
      delete t.collaborationMode;
    } else if (method === 'turn/started') {
      this.active.set(p.threadId, p.turn.id); t.lastTurnStatus = 'inProgress';
    } else if (method === 'thread/tokenUsage/updated') t.usage = p.tokenUsage;
    else if (method === 'item/started') this.items.set(p.item.id, p.item);
    else if (method === 'item/completed') this.completedItem(p.threadId, p.item);
    else if (method === 'turn/completed') {
      for (const item of p.turn.items ?? []) this.completedItem(p.threadId, item);
      if (this.active.get(p.threadId) === p.turn.id) this.active.delete(p.threadId);
      t.lastTurnStatus = p.turn.status;
      for (const [key, request] of this.pending) if (request.params.threadId === p.threadId && request.params.turnId === p.turn.id) this.pending.delete(key);
      if (p.turn.status === 'failed') this.say(t.owner, `Codex turn failed: ${p.turn.error?.message ?? 'unknown error'}`);
      else if (p.turn.status === 'interrupted') this.say(t.owner, 'Turn stopped.');
    } else if (method === 'error' && !p.willRetry) this.say(t.owner, `Codex: ${p.error?.message ?? 'turn error'}`);
    this.state.save();
  }
  completedItem(threadId, item) {
    const t = this.record(threadId);
    this.items.delete(item.id);
    if (t.parentThreadId) return; // Root Codex summarizes its agents; approvals are still routed.
    if (!['agentMessage', 'plan', 'exitedReviewMode'].includes(item.type) || (t.sentItems ?? []).includes(item.id)) return;
    if (item.type === 'agentMessage' || item.type === 'plan' || item.type === 'exitedReviewMode') {
      const text = item.text ?? item.review;
      const chat = this.state.chat(t.owner);
      const commentary = item.type === 'agentMessage' && item.phase === 'commentary';
      if (text && (!commentary || (chat.progress !== false && Date.now() - (t.lastProgress ?? 0) > 20000))) {
        const prefix = chat.threadId !== threadId ? `[Session ${threadId.slice(0, 8)}]\n` : '';
        this.say(t.owner, prefix + text);
        if (commentary) t.lastProgress = Date.now();
      }
      if (item.questions?.length) {
        this.say(t.owner, item.questions.map(q => q.title + (q.options?.length ? '\n' + q.options.map((o, i) => `${i + 1}. ${o}`).join('\n') : '')).join('\n\n'));
      }
    }
    t.sentItems = [...(t.sentItems ?? []), item.id].slice(-300);
  }
  serverRequest(message) {
    if (message.method === 'currentTime/read') { this.rpc.respond(message.id, { currentTimeAt: Math.floor(Date.now() / 1000) }); return; }
    const t = this.record(message.params?.threadId);
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request'];
    if (!t || !supported.includes(message.method)) { this.rpc.reject(message.id); return; }
    const key = randomUUID().slice(0, 8);
    this.pending.set(key, message);
    const p = message.params;
    const details = { reason: p.reason, command: p.command, cwd: p.cwd, permissions: p.permissions, network: p.networkApprovalContext, changes: this.items.get(p.itemId)?.changes };
    let text = `Request ${key} · session ${p.threadId.slice(0, 8)}\n`;
    if (message.method === 'item/tool/requestUserInput') {
      text += p.questions.map(q => `${q.id}: ${q.question}${q.isSecret ? '\n(Enter sensitive answers locally.)' : ''}\n${(q.options ?? []).map(o => `${o.label}: ${o.description}`).join('\n')}`).join('\n\n');
      text += `\n/answer ${key} ${p.questions.length === 1 ? '<your answer>' : '{"question_id":"answer",...}'}`;
    } else if (message.method === 'mcpServer/elicitation/request') {
      text += `${p.message ?? p.description ?? ''}\n${p.url ?? pretty(p.requestedSchema ?? {})}\n/answer ${key} <JSON form> · /deny ${key}`;
    } else text += `${pretty(details)}\n/allow ${key} · /allow ${key} session · /deny ${key}`;
    this.say(t.owner, text);
  }
  answer(user, name, arg) {
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(arg);
    const first = match?.[1];
    const own = [...this.pending].filter(([, m]) => this.record(m.params.threadId)?.owner === user);
    const key = first || (own.length === 1 ? own[0][0] : null);
    const m = key && this.pending.get(key);
    if (!m || this.record(m.params.threadId)?.owner !== user) throw new Error('Specify a current request ID from /approvals.');
    const p = m.params; const tail = match?.[2] ?? ''; let result;
    if (['allow', 'deny'].includes(name) && tail && !(name === 'allow' && tail === 'session')) throw new Error('Usage: /allow ID [session] or /deny ID');
    if (m.method === 'item/tool/requestUserInput') {
      if (name === 'allow') throw new Error('Use /answer with your answer; this is a question.');
      const answers = {};
      if (name !== 'deny') {
        if (p.questions.some(q => q.isSecret)) throw new Error('Answer secret questions in a local Codex client.');
        const values = p.questions.length === 1 ? { [p.questions[0].id]: tail } : JSON.parse(tail);
        for (const q of p.questions) {
          if (typeof values[q.id] !== 'string' || !values[q.id].length) throw new Error(`Missing answer for ${q.id}.`);
          answers[q.id] = { answers: [values[q.id]] };
        }
      }
      result = { answers };
    } else if (m.method === 'mcpServer/elicitation/request') {
      if (p.mode === 'openai/userVerification') throw new Error('Complete identity verification in the local Codex client.');
      if (name === 'allow' && p.mode !== 'url') throw new Error('Use /answer ID <JSON form>.');
      result = { action: name === 'deny' ? 'decline' : 'accept', content: name === 'deny' || p.mode === 'url' ? null : JSON.parse(tail), _meta: null };
    } else if (m.method === 'item/permissions/requestApproval') {
      if (!['allow', 'deny'].includes(name)) throw new Error('Use /allow or /deny.');
      result = { permissions: name === 'deny' ? {} : Object.fromEntries(Object.entries(p.permissions).filter(([, v]) => v != null)), scope: tail === 'session' ? 'session' : 'turn' };
    } else {
      if (!['allow', 'deny'].includes(name)) throw new Error('Use /allow or /deny.');
      const decision = name === 'deny' ? 'decline' : tail === 'session' ? 'acceptForSession' : 'accept';
      if (p.availableDecisions && !p.availableDecisions.includes(decision)) throw new Error('That decision is not offered by Codex for this request.');
      result = { decision };
    }
    this.rpc.respond(m.id, result); this.pending.delete(key); this.say(user, `Answered ${key}.`);
  }
}
