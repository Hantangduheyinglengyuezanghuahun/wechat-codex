import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { WeChat, aesKey, chunks, parseWire, wechatUrl, boundedBytes } from '../src/wechat.js';
import { State, acquireLock } from '../src/state.js';

test('UTF-8 chunks reassemble exactly without splitting emoji', () => {
  const source = '中文🙂\n'.repeat(3000); const result = chunks(source);
  assert.equal(result.join(''), source);
  assert.ok(result.every(part => Buffer.byteLength(part) <= 3500 && !part.includes('\uFFFD')));
});
test('Tencent uint64 IDs remain distinct', () => {
  const result = parseWire('{"msgs":[{"message_id":18446744073709551614},{"message_id":18446744073709551615}]}');
  assert.equal(result.msgs[0].message_id, '18446744073709551614');
  assert.equal(result.msgs[1].message_id, '18446744073709551615');
});
test('authenticated requests stay on Tencent and never expose the token to media hosts', async () => {
  assert.throws(() => wechatUrl('https://weixin.qq.com.attacker.example/'));
  assert.throws(() => wechatUrl('http://ilinkai.weixin.qq.com/'));
  assert.throws(() => wechatUrl('https://user:pass@ilinkai.weixin.qq.com/'));
  const requests = [];
  const client = new WeChat({ token: 'secret-token' }, async (url, opts) => { requests.push({ url, opts }); return new Response('{"ret":0}'); });
  await client.text('owner', 'ctx', 'hello', 'stable-id');
  const request = requests[0]; const data = JSON.parse(request.opts.body);
  assert.equal(request.opts.headers.Authorization, 'Bearer secret-token');
  assert.equal(data.msg.client_id, 'stable-id'); assert.equal(data.msg.item_list[0].text_item.text, 'hello');
  assert.equal(request.opts.redirect, 'error');
});
test('missing context is an error, and token expiry stops normal delivery', async () => {
  const client = new WeChat({}, async () => new Response('{"ret":-14}'));
  await assert.rejects(client.text('owner', '', 'hello'), /reply context/);
  await assert.rejects(client.updates('cursor'), error => error.code === -14);
});
test('both Tencent encryption-key encodings decrypt with path traversal removed', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = randomBytes(16); const plain = Buffer.from('private file bytes');
  assert.deepEqual(aesKey(key.toString('base64')), key);
  assert.deepEqual(aesKey(Buffer.from(key.toString('hex')).toString('base64')), key);
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const client = new WeChat({ token: 'must-not-go-to-cdn' }, async (url, opts) => {
    assert.equal(opts.headers?.Authorization, undefined); return new Response(encrypted);
  });
  const file = await client.download({ type: 4, file_item: { file_name: '../../evil.txt', media: { encrypt_query_param: 'p', aes_key: key.toString('base64') } } }, dir);
  assert.equal(path.dirname(file.path), dir); assert.equal(file.name, 'evil.txt');
  assert.deepEqual(fs.readFileSync(file.path), plain);
  assert.equal(fs.statSync(file.path).mode & 0o777, 0o600);
});
test('streaming download limits apply even without content-length', async () => {
  await assert.rejects(boundedBytes(new Response(new Uint8Array(100)), 10), /exceeds/);
});
test('state and lock stay private and a second live instance is refused', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-lock-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const unlock = acquireLock(dir); const state = new State(dir); state.save();
  assert.throws(() => acquireLock(dir), /Already running/);
  assert.equal(fs.statSync(state.file).mode & 0o777, 0o600);
  unlock(); acquireLock(dir)();
});


test('outbound file encryption and media envelope follow the Tencent protocol', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-upload-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'example.txt'); const content = Buffer.from('文件 content'); fs.writeFileSync(file, content);
  let metadata; let encrypted;
  const client = new WeChat({ token: 'local-secret' }, async (url, options) => {
    if (url.pathname.endsWith('getuploadurl')) {
      metadata = JSON.parse(options.body);
      return new Response('{"upload_param":"query"}');
    }
    assert.equal(options.headers.Authorization, undefined);
    encrypted = options.body;
    return new Response('', { headers: { 'x-encrypted-param': 'download-reference' } });
  });
  const item = await client.upload(file, 'owner');
  assert.equal(metadata.rawsize, content.length); assert.equal(metadata.filesize, encrypted.length);
  const key = aesKey(item.file_item.media.aes_key);
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  assert.deepEqual(Buffer.concat([decipher.update(encrypted), decipher.final()]), content);
  assert.equal(item.type, 4); assert.equal(item.file_item.file_name, 'example.txt');
  assert.equal(item.file_item.media.encrypt_query_param, 'download-reference');
});
