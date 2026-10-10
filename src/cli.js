#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { State, readJson, saveJson, acquireLock } from './state.js';
import { WeChat, API, wechatUrl } from './wechat.js';
import { Codex } from './rpc.js';
import { serve, existingBridgeRunning } from './runtime.js';
import { secureDir, secureFile } from './storage.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  'state-dir': { type: 'string' }, cwd: { type: 'string' }, codex: { type: 'string' },
  from: { type: 'string' }, output: { type: 'string' }, wechat: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} });
const command = positionals[0] ?? 'help';
const dir = path.resolve(values['state-dir'] ?? process.env.WECHAT_CODEX_STATE ?? path.join(os.homedir(), '.wechat-codex'));
const cwd = path.resolve(values.cwd ?? process.env.WECHAT_CODEX_CWD ?? process.cwd());
const bin = values.codex ?? process.env.WECHAT_CODEX_BIN ?? 'codex';
const accountFile = path.join(dir, 'account.json');

async function main() {
  if (values.help || command === 'help') {
    console.log(`WeChat Codex Local
node src/cli.js login                 Pair WeChat by QR code
node src/cli.js import-account --from /path/to/account.json
node src/cli.js doctor                Read-only local checks
node src/cli.js doctor --wechat       Also check the WeChat credential (no messages)
node src/cli.js serve --cwd /project  Start receiving messages
node src/cli.js service --output /path/to/unit.service

Options: --state-dir DIR --cwd DIR --codex /path/to/codex
Default state: ~/.wechat-codex. Your existing Codex config and login are used.`);
    return;
  }
  if (command === 'doctor') {
    const version = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (version.status !== 0) throw new Error('Codex executable did not run. Use --codex /absolute/path/to/codex.');
    console.log(version.stdout.trim());
    console.log(`Node ${process.version}\nWorking directory: ${cwd}\nState directory: ${dir}`);
    const account = readJson(accountFile, {});
    console.log(`WeChat credentials: ${account.token && account.userId ? 'configured' : 'not configured'}\nOld CodexBridge running: ${existingBridgeRunning()}`);
    const rpc = new Codex({ bin, cwd });
    try {
      await rpc.start();
      const auth = await rpc.request('account/read', { refreshToken: false });
      const models = await rpc.request('model/list', { limit: 100 });
      const { config } = await rpc.request('config/read', { cwd });
      console.log(`Codex auth: ${auth.account?.type ?? 'not signed in'}\nNative models: ${models.data.length}\nConfigured model: ${config.model ?? '(default)'}\nConfigured provider: ${config.model_provider ?? '(default)'}`);
      console.log('App-server handshake and read-only controls passed. No inference or WeChat message sent.');
    } finally { await rpc.stop(); }
    if (values.wechat) {
      if (!account.token || !account.userId) throw new Error('No WeChat credential configured.');
      const state = new State(dir);
      await new WeChat(account).api('getconfig', { ilink_user_id: account.userId, context_token: state.chat(account.userId).contextToken });
      console.log('WeChat credential check passed. No messages received or sent.');
    }
    return;
  }
  if (command === 'service') {
    if (!values.output) throw new Error('Supply --output /path/to/wechat-codex.service.');
    const script = fileURLToPath(import.meta.url);
    const resolvedBin = bin.includes('/') ? path.resolve(bin) : spawnSync('which', [bin], { encoding: 'utf8' }).stdout?.trim();
    if (!resolvedBin) throw new Error('Codex executable was not found.');
    const quote = s => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"';
    const args = [process.execPath, script, 'serve', '--cwd', cwd, '--state-dir', dir, '--codex', resolvedBin];
    const unit = `[Unit]\nDescription=Personal WeChat controls for local Codex\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${cwd.replaceAll('%', '%%')}\nExecStart=${args.map(quote).join(' ')}\nEnvironment=${quote('PATH=' + (process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'))}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=15\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
    fs.mkdirSync(path.dirname(path.resolve(values.output)), { recursive: true });
    fs.writeFileSync(values.output, unit, { mode: 0o600 });
    console.log(`Wrote ${path.resolve(values.output)}. The service has not been installed or started.`);
    return;
  }
  if (command === 'import-account') {
    if (!values.from) throw new Error('Supply --from with the specific account JSON file.');
    const unlock = acquireLock(dir);
    try {
      if (fs.existsSync(accountFile)) throw new Error('An account is already configured. Use a new state directory to import another.');
      const from = path.resolve(values.from); const old = readJson(from);
      const account = { token: old.token, userId: old.user_id ?? old.userId, baseUrl: old.base_url ?? old.baseUrl ?? API,
        botId: path.basename(from, '.json'), importedFrom: from };
      wechatUrl(account.baseUrl);
      if (!account.token || !account.userId) throw new Error('The account file must contain token and user_id.');
      saveJson(accountFile, account);
      const base = from.slice(0, -5); const state = new State(dir);
      state.data.cursor = readJson(`${base}.sync.json`, {}).get_updates_buf ?? '';
      const contexts = readJson(`${base}.context-tokens.json`, {});
      const context = contexts[account.userId];
      if (typeof context === 'string') state.chat(account.userId).contextToken = context;
      state.save();
      console.log('Imported only the local WeChat credential, owner, reply context, and polling cursor. No Codex instructions or conversation settings were imported.');
      if (existingBridgeRunning()) console.log('The old service is still running. Stop it before starting this client with the same account.');
    } finally { unlock(); }
    return;
  }
  if (command === 'login') {
    const unlock = acquireLock(dir);
    let rl;
    try {
      const previous = readJson(accountFile, {});
      const transport = new WeChat();
      const qr = await transport.api('get_bot_qrcode?bot_type=3', { local_token_list: previous.token ? [previous.token] : [] });
      if (!qr.qrcode || !qr.qrcode_img_content) throw new Error('WeChat did not return a QR code.');
      const { default: QRCode } = await import('qrcode');
      const png = path.join(dir, 'login.png');
      await QRCode.toFile(png, qr.qrcode_img_content, { width: 420, margin: 2 });
      fs.chmodSync(png, 0o600);
      console.log(await QRCode.toString(qr.qrcode_img_content, { type: 'terminal', small: true }));
      console.log(`Scan with WeChat and confirm. QR image: ${png}`);
      let base = API; let verifyCode;
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        let result;
        try {
          const suffix = verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : '';
          result = await transport.api(`get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}${suffix}`, undefined, { base });
        } catch (e) { if (['TimeoutError', 'AbortError'].includes(e.name)) continue; throw e; }
        verifyCode = undefined;
        if (result.status === 'confirmed') {
          if (!result.bot_token || !result.ilink_user_id) throw new Error('Login response is missing the owner or token.');
          const account = { token: result.bot_token, userId: result.ilink_user_id, botId: result.ilink_bot_id, baseUrl: result.baseurl ?? base };
          wechatUrl(account.baseUrl); saveJson(accountFile, account);
          if ((previous.botId && previous.botId !== account.botId) || (previous.userId && previous.userId !== account.userId)) {
            const state = new State(dir); state.data.cursor = ''; state.data.inbox = []; state.data.outbox = []; state.data.chats = {}; state.data.seen = []; state.save();
          }
          fs.unlinkSync(png); console.log('WeChat paired. Run npm start -- --cwd /your/project.'); return;
        }
        if (result.status === 'binded_redirect' && previous.token) { console.log('Already paired. Existing account retained.'); return; }
        if (result.status === 'scaned_but_redirect') base = wechatUrl(`https://${result.redirect_host}`).origin;
        else if (result.status === 'need_verifycode') {
          rl ??= createInterface({ input: process.stdin, output: process.stdout });
          verifyCode = (await rl.question('WeChat verification code: ')).trim();
        } else if (['expired', 'verify_code_blocked', 'binded_redirect'].includes(result.status)) throw new Error(`WeChat login: ${result.status}. Run login again or import the existing account.`);
        await delay(1000);
      }
      throw new Error('QR login timed out. Run login again.');
    } finally { rl?.close(); unlock(); }
  } else if (command === 'serve') { secureDir(dir); secureFile(accountFile); await serve({ dir, cwd, bin, account: readJson(accountFile, {}) }); }
  else throw new Error(`Unknown command: ${command}`);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
