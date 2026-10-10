import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Codex } from '../src/rpc.js';

test('real child-process framing, truthful initialization, server requests and process death', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-rpc-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'fake-codex');
  fs.writeFileSync(bin, `#!${process.execPath}
const rl = require('node:readline').createInterface({input:process.stdin});
const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
rl.on('line', line => { const m = JSON.parse(line);
if (m.method === 'initialize') send({id:m.id,result:{client:m.params,argv:process.argv.slice(2)}});
else if (m.method === 'echo') { send({method:'item/test',params:{value:1}}); send({id:500,method:'item/tool/requestUserInput',params:{}}); send({id:m.id,result:m.params}); }
else if (m.method === 'exit') process.exit(7);
});\n`, { mode: 0o700 });
  const rpc = new Codex({ bin, cwd: dir, timeout: 1000 }); t.after(() => rpc.stop());
  const info = await rpc.start();
  assert.deepEqual(info.argv, ['app-server', '--listen', 'stdio://']);
  assert.equal(info.client.clientInfo.name, 'wechat_codex_local');
  assert.deepEqual(Object.keys(info.client).sort(), ['capabilities', 'clientInfo']);
  const notices = []; const requests = [];
  rpc.on('notification', n => notices.push(n)); rpc.on('request', r => requests.push(r));
  assert.deepEqual(await rpc.request('echo', { text: 'hello\n中文' }), { text: 'hello\n中文' });
  assert.equal(notices.length, 1); assert.equal(requests[0].id, 500);
  await assert.rejects(rpc.request('exit'), /exited/);
  assert.equal(rpc.pending.size, 0);
});
