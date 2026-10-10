import fs from 'node:fs';
import path from 'node:path';
import { MAX_MEDIA } from './wechat.js';
import { randomUUID } from 'node:crypto';
import { localPath, pretty } from './core.js';
import { snapshotExport, exportRoot, secureDir, mediaUsage, removeSnapshot } from './storage.js';

export const HELP = {
  en: `WeChat Codex Local
/new [directory] · /threads [archived] · /search words
/next · /prev · /open N|ID · /peek [N|ID]
/rename N|ID title · /fork [N|ID] · /archive [N|ID] · /unarchive N|ID
/models · /models show N|model · /model [N|model] [effort]
/model default · /model high · /fast on|off · /plan on|off
/status · /usage · /account · /provider · /instructions
/permissions [profile] · /approval on-request|untrusted|never
/approvals · /allow ID [session] · /deny ID · /answer ID answer
/stop [N|ID] · /retry · /reconnect · /restart
/review [base branch|commit sha|custom instructions]
/compact · /goal [set text|budget N text|pause|resume|clear]
/skills [search words|show N|on N|off N]
/plugins [search words|show N|install N|uninstall N]
/experimental [on name|off name]
/uploads [begin|send|clear] · /exports · /storage · /download filename · /outbox [retry [ID]|drop ID|clear]
/login [status|cancel] · /progress on|off · /lang en|zh
/send text (send literal text that begins with a slash)
/ (refresh WeChat reply context without starting a turn)

Send a file/image, then your task. Ordinary text goes unchanged to Codex.
Model replies and existing Codex instructions keep their original language.`,
  zh: `微信 Codex 本地控制
/new [目录] 新会话 · /threads 会话列表 · /search 关键词
/next 下一页 · /prev 上一页 · /open 序号 切换 · /peek [序号] 预览
/rename 序号 名称 · /fork [序号] 分支 · /archive [序号] 归档
/models 模型列表 · /models show 序号 模型信息
/model [模型或序号] [推理强度] · /model default
/fast on|off · /plan on|off
/status 状态 · /usage 用量 · /account 账号 · /instructions 指令来源
/permissions [配置名] · /approval on-request|untrusted|never
/approvals 待处理请求 · /allow ID [session] · /deny ID · /answer ID 回答
/stop [序号] 停止 · /retry 重试上次输入 · /reconnect 重连 · /restart 重启
/review [base 分支|commit SHA|custom 审查要求] · /compact 压缩上下文
/goal [set 目标|budget 数量 目标|pause|resume|clear]
/skills [search 关键词|show 序号|on 序号|off 序号]
/plugins [search 关键词|show 序号|install 序号|uninstall 序号]
/experimental [on 名称|off 名称]
/uploads [begin|send|clear] · /exports 导出目录 · /storage 存储 · /download 文件名 · /outbox [retry [ID]|drop ID|clear]
/login [status|cancel] · /progress on|off · /lang en|zh
/send 原始文本（用于以 / 开头的消息）
/ 仅刷新微信回复上下文

先发送文件或图片，再发送任务。普通文本原样交给 Codex。
此语言选项仅影响帮助；原生错误及模型回答保持原文。`,
};

const excluded = new Set(['as', 'log', 'todo', 'remind', 'note', 'automation', 'auto', 'weibo', 'personality']);

export async function command(c, user, name, arg) {
  const chat = c.state.chat(user);
  const say = text => c.say(user, text);
  const rpc = (method, params) => c.rpc.request(method, params);
  const current = async () => { const id = await c.ensure(user); return [id, c.record(id)]; };
  const words = arg.split(/\s+/).filter(Boolean);
  if (name === 'help') { say(HELP[chat.locale]); return; }
  if (excluded.has(name)) throw new Error('This added workflow is not part of this client. Send a normal Codex request, or use /help for native controls.');
  if (name === 'new') {
    if (chat.uploads.length) throw new Error('Send or clear staged attachments before switching sessions.');
    const id = await c.newThread(user, arg || c.cwd); say(`New session: ${id}\n${c.record(id).cwd}`); return;
  }
  if (name === 'threads' || name === 'search') return c.listThreads(user, { searchTerm: name === 'search' ? arg : undefined, archived: name === 'threads' && arg === 'archived' });
  if (name === 'next' || name === 'prev') {
    const page = c.pages.get(user);
    if (!page) return c.listThreads(user);
    const previous = [...page.previous]; let cursor;
    if (name === 'next') { if (!page.nextCursor) { say('Last page.'); return; } previous.push(page.cursor); cursor = page.nextCursor; }
    else { if (!previous.length) { say('First page.'); return; } cursor = previous.pop(); }
    return c.listThreads(user, { ...page, cursor, previous });
  }
  if (['open', 'peek', 'fork', 'archive', 'unarchive'].includes(name)) {
    const id = c.threadId(user, arg);
    if (name === 'peek') return c.preview(user, id);
    if (c.active.has(id) && name !== 'open') throw new Error('Stop that session before this operation.');
    if (['open', 'fork'].includes(name)) {
      if (chat.uploads.length) throw new Error('Send or clear staged attachments before switching sessions.');
      const result = await rpc(name === 'open' ? 'thread/resume' : 'thread/fork', { threadId: id, excludeTurns: true });
      const selected = c.remember(result, user);
      say(`Selected ${selected}\n${result.cwd}`); return c.preview(user, selected);
    }
    await rpc(`thread/${name}`, { threadId: id });
    if (name === 'archive' && chat.threadId === id) { chat.threadId = null; c.loaded.delete(id); c.state.save(); }
    say(`${name}: ${id}`); return;
  }
  if (name === 'rename') {
    const match = /^(\S+)\s+([\s\S]+)$/.exec(arg);
    if (!match) throw new Error('Usage: /rename N|ID title');
    const id = c.threadId(user, match[1]);
    await rpc('thread/name/set', { threadId: id, name: match[2] }); say(`Renamed ${id}.`); return;
  }
  if (name === 'models') {
    const models = await c.modelList();
    if (words[0] === 'show') { const model = select(models, words[1], m => m.model); say(pretty(model)); }
    else say(models.map((m, i) => `${i + 1}. ${m.model}${m.isDefault ? ' (default)' : ''}\n${m.description}\nEffort: ${m.supportedReasoningEfforts.map(e => e.reasoningEffort).join(', ')}`).join('\n\n'));
    return;
  }
  if (name === 'model') {
    const [id, t] = await current();
    if (!arg) { say(`Model: ${t.model}\nEffort: ${t.effort ?? 'model default'}\nProvider: ${t.modelProvider}\nTier: ${t.serviceTier ?? 'default'}\n/models show ${t.model}`); return; }
    const models = c.models.length ? c.models : await c.modelList();
    const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    let model; let effort;
    if (arg === 'default') {
      const { config } = await rpc('config/read', { cwd: t.cwd });
      model = models.find(m => m.model === config.model) ?? models.find(m => m.isDefault);
      effort = config.model_reasoning_effort ?? model?.defaultReasoningEffort;
    } else if (efforts.has(words[0])) { model = models.find(m => m.model === t.model); effort = words[0]; }
    else { model = select(models, words[0], m => m.model); effort = words[1] ?? model.defaultReasoningEffort; }
    if (!model) throw new Error('Model is not in the native catalog. Use /models.');
    if (effort && !model.supportedReasoningEfforts.some(e => e.reasoningEffort === effort)) throw new Error('That reasoning effort is not listed for this model.');
    const values = { model: model.model, ...(effort ? { effort } : {}) };
    if (t.mode === 'plan') values.collaborationMode = nativeMode('plan', model.model, effort);
    await c.settings(user, values); say(`Model: ${model.model}\nEffort: ${effort}\nSession: ${id}`); return;
  }
  if (name === 'fast' || name === 'plan') {
    const [, t] = await current();
    if (!arg) { say(name === 'fast' ? `Tier: ${t.serviceTier ?? 'default'}` : `Mode: ${t.mode}`); return; }
    onOff(arg);
    if (name === 'plan') await c.settings(user, { collaborationMode: nativeMode(arg === 'on' ? 'plan' : 'default', t.model, t.effort) });
    else {
      const model = (await c.modelList()).find(m => m.model === t.model);
      if (arg === 'on' && !model?.serviceTiers?.some(s => s.id === 'fast') && !model?.additionalSpeedTiers?.includes('fast')) throw new Error('Fast tier is not advertised for this model.');
      await c.settings(user, { serviceTier: arg === 'on' ? 'fast' : null });
    }
    say(`${name}: ${arg}`); return;
  }
  if (name === 'status') {
    const id = chat.threadId; const t = id ? c.record(id) : null;
    say(pretty({ connected: !!c.rpc.child, thread: id, cwd: t?.cwd ?? c.cwd, model: t?.model, effort: t?.effort,
      tier: t?.serviceTier, mode: t?.mode, activeTurns: [...c.active].map(([thread, turn]) => ({ thread, turn })),
      lastTurnStatus: t?.lastTurnStatus, pendingRequests: c.pending.size, queuedReplies: c.state.data.outbox.length, droppedReplies: c.state.data.droppedReplies ?? 0, rejectedMessages: c.state.data.rejectedMessages ?? 0,
      stagedAttachments: chat.uploads.length, approvalPolicy: t?.approvalPolicy, approvalsReviewer: t?.approvalsReviewer, permissionProfile: t?.activePermissionProfile })); return;
  }
  if (name === 'usage') {
    const limits = await rpc('account/rateLimits/read', {});
    say(pretty({ session: c.record(chat.threadId)?.usage ?? null, account: limits })); return;
  }
  if (name === 'account') { say(pretty(await rpc('account/read', { refreshToken: false }))); return; }
  if (name === 'provider' || name === 'instructions') {
    const [, t] = await current();
    if (arg) throw new Error('This command only displays native configuration. Edit your Codex configuration locally.');
    say(name === 'provider' ? `Native Codex provider: ${t.modelProvider}` : `Native instruction sources:\n${t.instructionSources.join('\n') || '(none reported)'}\nThis client adds no prompt instructions.`); return;
  }
  if (name === 'permissions') {
    const [id, t] = await current();
    const profiles = await rpc('permissionProfile/list', { cwd: t.cwd });
    if (!arg) say(pretty({ current: t.activePermissionProfile, sandbox: t.sandboxPolicy, approvalPolicy: t.approvalPolicy, profiles: profiles.data }));
    else {
      if (!profiles.data.some(p => p.id === arg && p.allowed)) throw new Error('Select an allowed profile from /permissions.');
      await c.settings(user, { permissions: arg }); say(`Permissions: ${arg}\nSession: ${id}`);
    }
    return;
  }
  if (name === 'approval') {
    if (!['on-request', 'untrusted', 'never'].includes(arg)) throw new Error('Usage: /approval on-request|untrusted|never');
    await c.settings(user, { approvalPolicy: arg }); say(`Approval policy: ${arg}`); return;
  }
  if (name === 'approvals') {
    say([...c.pending].map(([id, m]) => `${id}: ${m.method}\nSession ${m.params.threadId}`).join('\n\n') || 'No pending requests.'); return;
  }
  if (['allow', 'deny', 'answer'].includes(name)) return c.answer(user, name, arg);
  if (name === 'stop') {
    const threadId = c.threadId(user, arg); const turnId = c.active.get(threadId);
    if (!turnId) { say('No active turn in that session.'); return; }
    await rpc('turn/interrupt', { threadId, turnId }); say('Interrupt requested.'); return;
  }
  if (name === 'retry') {
    const last = chat.lastInput;
    if (!last) throw new Error('No previous input to retry.');
    if (last.threadId !== chat.threadId) throw new Error('Select the session containing the previous input before retrying.');
    if (c.active.has(chat.threadId)) throw new Error('The previous turn is still running.');
    if (chat.uploads.length) throw new Error('Send or clear staged attachments first.');
    return c.submit(user, last.text, last.files, randomUUID());
  }
  if (name === 'reconnect' || name === 'restart') {
    if (c.active.size || c.pending.size) throw new Error('Stop active turns and resolve requests before restarting the local Codex process.');
    await c.rpc.stop(); c.loaded.clear(); await c.rpc.start();
    if (chat.threadId) await c.ensure(user);
    say('Local Codex process reconnected.'); return;
  }
  if (name === 'review') {
    const [threadId] = await current();
    if (c.active.has(threadId)) throw new Error('Wait for the active turn or use /stop.');
    let target = { type: 'uncommittedChanges' };
    const rest = words.slice(1).join(' ');
    if (words[0] === 'base' && rest) target = { type: 'baseBranch', branch: rest };
    else if (words[0] === 'commit' && rest) target = { type: 'commit', sha: rest, title: null };
    else if (arg) target = { type: 'custom', instructions: words[0] === 'custom' ? rest : arg };
    await rpc('review/start', { threadId, target, delivery: 'inline' }); return;
  }
  if (name === 'compact') {
    const [threadId] = await current();
    if (c.active.has(threadId)) throw new Error('Stop the active turn first.');
    await rpc('thread/compact/start', { threadId }); say('Native context compaction requested.'); return;
  }
  if (name === 'goal') {
    const [threadId] = await current(); let result;
    if (!arg) result = await rpc('thread/goal/get', { threadId });
    else if (arg === 'clear') result = await rpc('thread/goal/clear', { threadId });
    else if (arg === 'pause' || arg === 'resume') result = await rpc('thread/goal/set', { threadId, status: arg === 'pause' ? 'paused' : 'active' });
    else if (words[0] === 'budget') {
      const tokenBudget = Number(words[1]); const objective = words.slice(2).join(' ');
      if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0 || !objective) throw new Error('Usage: /goal budget N objective');
      result = await rpc('thread/goal/set', { threadId, objective, tokenBudget });
    } else if (words[0] === 'set' && words.length > 1) result = await rpc('thread/goal/set', { threadId, objective: arg.slice(4) });
    else throw new Error('Usage: /goal [set objective|budget N objective|pause|resume|clear]');
    say(pretty(result)); return;
  }
  if (name === 'skills') {
    const [, t] = await current();
    if (['show', 'on', 'off'].includes(words[0])) {
      const skill = select(c.skillLists.get(user) ?? [], words[1], s => s.name);
      if (words[0] === 'show') say(pretty(skill));
      else { await rpc('skills/config/write', { path: skill.path, enabled: words[0] === 'on' }); say(`Skill ${skill.name}: ${words[0]}`); }
    } else {
      const result = await rpc('skills/list', { cwds: [t.cwd], forceReload: true });
      const term = words[0] === 'search' ? arg.slice(7).toLowerCase() : '';
      const list = result.data.flatMap(x => x.skills).filter(s => !term || `${s.name} ${s.description}`.toLowerCase().includes(term));
      c.skillLists.set(user, list);
      say(list.map((s, i) => `${i + 1}. ${s.name} (${s.enabled ? 'on' : 'off'})\n${s.description}`).join('\n\n') || 'No matching skills.');
    }
    return;
  }
  if (name === 'plugins') {
    const [, t] = await current();
    if (['show', 'install', 'uninstall'].includes(words[0])) {
      const p = select(c.pluginLists.get(user) ?? [], words[1], p => p.name);
      const selector = { pluginName: p.name, ...(p.marketplacePath ? { marketplacePath: p.marketplacePath } : { remoteMarketplaceName: p.marketplaceName }) };
      if (words[0] === 'show') say(pretty(await rpc('plugin/read', selector)));
      else if (words[0] === 'uninstall') { await rpc('plugin/uninstall', { pluginId: p.id }); say(`Uninstalled ${p.name}.`); }
      else {
        if (p.mustShowInstallationInterstitial) throw new Error('This plugin requires its native installation disclosure. Install it in the local Codex UI.');
        say(pretty(await rpc('plugin/install', { ...selector, installAttemptId: randomUUID() })));
      }
    } else {
      const result = await rpc('plugin/list', { cwds: [t.cwd] });
      const term = words[0] === 'search' ? arg.slice(7).toLowerCase() : '';
      const list = result.marketplaces.flatMap(m => m.plugins.map(p => ({ ...p, marketplacePath: m.path, marketplaceName: m.name })))
        .filter(p => !term || `${p.name} ${pretty(p.interface)}`.toLowerCase().includes(term));
      c.pluginLists.set(user, list);
      say(list.map((p, i) => `${i + 1}. ${p.name} (${p.installed ? 'installed' : 'available'})\n${p.interface?.shortDescription ?? ''}`).join('\n\n') || 'No plugins.');
    }
    return;
  }
  if (name === 'experimental') {
    if (!arg || arg === 'list') say(pretty(await rpc('experimentalFeature/list', { limit: 100 })));
    else {
      onOff(words[0]); if (!words[1] || words.length !== 2) throw new Error('Usage: /experimental on|off feature');
      say(pretty(await rpc('experimentalFeature/enablement/set', { enablement: { [words[1]]: words[0] === 'on' } })));
    }
    return;
  }
  if (name === 'uploads') {
    if (arg === 'begin') { chat.staging = true; c.state.save(); say('Batch attachment staging enabled. Finish with /uploads send [task].'); }
    else if (arg === 'clear') { chat.uploads = []; chat.staging = false; chat.stagedText = []; c.state.save(); say('Staging cleared. Downloaded files remain on disk.'); }
    else if (words[0] === 'send') {
      const text = [...(chat.stagedText ?? []), ...(words.length > 1 ? [arg.slice(5)] : [])].join('\n');
      return c.submit(user, text, chat.uploads, randomUUID());
    } else if (!arg) say(`Batch: ${chat.staging ? 'on' : 'off'}\n` + (chat.uploads.map((f, i) => `${i + 1}. ${f.name}\n${f.path}`).join('\n') || 'No staged attachments.'));
    else throw new Error('Usage: /uploads [begin|send [task]|clear]');
    return;
  }
  if (name === 'exports') { say(`Export folder: ${secureDir(exportRoot(c.state.dir))}\nPlace files here locally, then use /download filename. Hidden, credential, and linked files are refused.`); return; }
  if (name === 'storage') { say(pretty({ ...mediaUsage(c.state.dir), queuedReplies: c.state.data.outbox.length, failedReplies: c.state.data.outbox.filter(m => m.failed).length, droppedReplies: c.state.data.droppedReplies ?? 0 })); return; }
  if (name === 'download') {
    if (!arg) throw new Error('Usage: /download filename (inside /exports folder)');
    const snapshot = snapshotExport(c.state.dir, arg, MAX_MEDIA);
    c.state.enqueue(user, '', snapshot); say(`Queued file: ${path.basename(snapshot)}`); return;
  }
  if (name === 'outbox') {
    if (arg === 'clear') { const count = c.state.data.outbox.length; for (const m of c.state.data.outbox) removeSnapshot(c.state.dir, m.file); c.state.data.outbox = []; c.state.save(); say(`Cleared ${count} queued replies. Session history is still available with /peek.`); }
    else if (words[0] === 'retry' || words[0] === 'drop') {
      const selected = words[1] ? c.state.data.outbox.filter(m => m.id === words[1]) : words[0] === 'retry' ? c.state.data.outbox : [];
      if (!selected.length) throw new Error('Select a delivery ID from /outbox.');
      if (words[0] === 'retry' && selected.some(m => m.file && m.exportPolicyVersion !== 1)) throw new Error('Legacy exports cannot be retried. Drop the delivery and copy the intended file into /exports before requesting it again.');
      if (words[0] === 'drop') { for (const m of selected) removeSnapshot(c.state.dir, m.file); c.state.data.outbox = c.state.data.outbox.filter(m => !selected.includes(m)); }
      else for (const m of selected) { m.failed = false; m.attempts = 0; m.nextAt = 0; }
      c.state.save(); say(`Delivery ${words[0]} completed. No Codex task was repeated.`);
    }
    else if (!arg) say(pretty(c.state.data.outbox.map(m => ({ id: m.id, file: m.file, attempts: m.attempts, failed: !!m.failed, lastError: m.lastError }))));
    else throw new Error('Usage: /outbox [retry [ID]|drop ID|clear]');
    return;
  }
  if (name === 'login') {
    if (arg === 'status') { say(pretty(await rpc('account/read', { refreshToken: false }))); return; }
    if (arg === 'cancel') {
      if (!c.loginId) throw new Error('No login pending.');
      await rpc('account/login/cancel', { loginId: c.loginId }); c.loginId = null; say('Login canceled.'); return;
    }
    if (arg) throw new Error('Usage: /login [status|cancel]. Account pools are not supported.');
    const result = await rpc('account/login/start', { type: 'chatgptDeviceCode' }); c.loginId = result.loginId;
    say(`Native Codex device login:\n${result.verificationUrl}\nCode: ${result.userCode}\nIf device login is disabled on your account, run codex login locally.`); return;
  }
  if (name === 'lang') {
    if (!['en', 'zh'].includes(arg)) throw new Error('Usage: /lang en|zh');
    chat.locale = arg; c.state.save(); say(HELP[arg]); return;
  }
  if (name === 'progress') { onOff(arg); chat.progress = arg === 'on'; c.state.save(); say(`Progress messages: ${arg}`); return; }
  throw new Error(`Unknown command /${name}. Use /help, or /send ${'/' + name + (arg ? ' ' + arg : '')} to send it literally.`);
}

function select(list, value, key) {
  const entry = /^\d+$/.test(value ?? '') ? list[Number(value) - 1] : list.find(x => key(x) === value);
  if (!entry) throw new Error('No matching entry. List entries first, then use its index or exact name.');
  return entry;
}
function onOff(arg) { if (!['on', 'off'].includes(arg)) throw new Error('Choose on or off.'); }
function nativeMode(mode, model, effort) {
  // null selects Codex's built-in mode instructions. No application prompt is supplied.
  return { mode, settings: { model, reasoning_effort: effort ?? null, developer_instructions: null } };
}
