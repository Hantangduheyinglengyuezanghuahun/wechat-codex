import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export class Codex extends EventEmitter {
  constructor({ bin = 'codex', cwd = process.cwd(), timeout = 90000 } = {}) {
    super(); this.bin = bin; this.cwd = cwd; this.timeout = timeout;
    this.pending = new Map(); this.sequence = 0; this.child = null;
  }
  async start() {
    if (this.child) throw new Error('Codex is already started.');
    const child = spawn(this.bin, ['app-server', '--listen', 'stdio://'], {
      cwd: this.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    this.child = child;
    // Never print raw stderr: native processes may include conversation text or tokens.
    child.stderr.on('data', () => {});
    child.stdin.on('error', error => this.fail(error));
    child.on('error', error => this.fail(error));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this.fail(new Error(`Codex exited (${signal ?? code}). Use /reconnect.`));
      this.emit('disconnected');
    });
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.emit('protocolError', new Error('Invalid JSON from Codex.')); return; }
      if (message.method) {
        this.emit(message.id !== undefined ? 'request' : 'notification', message);
      } else if (this.pending.has(message.id)) {
        const pending = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
        else pending.resolve(message.result);
      }
    });
    try {
      this.info = await this.request('initialize', {
        clientInfo: { name: 'wechat_codex_local', title: 'WeChat Codex Local', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      this.write({ method: 'initialized', params: {} });
      return this.info;
    } catch (error) { await this.stop(); throw error; }
  }
  write(message) {
    if (!this.child || this.child.stdin.destroyed) throw new Error('Codex is disconnected. Use /reconnect.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out; its outcome may be unknown. Check /status or /peek before retrying.`));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  respond(id, result) { this.write({ id, result }); }
  reject(id, message = 'This client does not implement that request.') {
    this.write({ id, error: { code: -32601, message } });
  }
  fail(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  async stop() {
    const child = this.child;
    if (!child) return;
    await new Promise(resolve => {
      const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
      child.kill('SIGTERM');
    });
    this.lines?.close();
  }
}
