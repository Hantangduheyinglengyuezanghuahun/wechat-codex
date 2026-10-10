import { secureDir } from './storage.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

export const API = 'https://ilinkai.weixin.qq.com';
const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const MAX_MEDIA = 25 * 1024 * 1024;

export function wechatUrl(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || !(u.hostname === 'weixin.qq.com' || u.hostname.endsWith('.weixin.qq.com')) || u.username || u.password || (u.port && u.port !== '443')) {
    throw new Error('Expected an HTTPS Tencent Weixin endpoint.');
  }
  return u;
}

// Preserve uint64 message IDs, including when Tencent encodes them as JSON numbers.
export function parseWire(text) {
  return JSON.parse(text, (key, value, context) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value) && context?.source && /^\d+$/.test(context.source)) return context.source;
    return value;
  });
}

export function chunks(text, maxBytes = 3500) {
  const result = []; let part = ''; let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes && part) { result.push(part); part = ''; bytes = 0; }
    part += char; bytes += size;
  }
  if (part) result.push(part);
  return result;
}

export function aesKey(value, hex) {
  const raw = hex ? Buffer.from(hex, 'hex') : Buffer.from(value ?? '', 'base64');
  if (raw.length === 16) return raw;
  if (raw.length === 32 && /^[a-f\d]{32}$/i.test(raw.toString())) return Buffer.from(raw.toString(), 'hex');
  throw new Error('Invalid attachment encryption key.');
}

export async function boundedBytes(response, limit = MAX_MEDIA + 32) {
  if (!response.ok) throw new Error(`WeChat media HTTP ${response.status}.`);
  const length = Number(response.headers.get('content-length'));
  if (length > limit) { await response.body?.cancel(); throw new Error('Attachment exceeds 25 MiB.'); }
  const parts = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Attachment exceeds 25 MiB.');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

export class WeChat {
  constructor(account = {}, fetcher = fetch) {
    this.account = account; this.base = wechatUrl(account.baseUrl ?? API).origin; this.fetch = fetcher;
  }
  async api(endpoint, data, { timeout = 40000, base = this.base, signal } = {}) {
    const url = wechatUrl(new URL(`/ilink/bot/${endpoint}`, base));
    const headers = {
      'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
      'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '1',
    };
    if (this.account.token) headers.Authorization = `Bearer ${this.account.token}`;
    const response = await this.fetch(url, {
      method: data === undefined ? 'GET' : 'POST', headers, redirect: 'error',
      body: data === undefined ? undefined : JSON.stringify({ ...data, base_info: { channel_version: '0.1.0', bot_agent: 'WeChatCodexLocal/0.1.0' } }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`WeChat HTTP ${response.status}.`);
    const result = parseWire(await response.text());
    if ((result.ret !== undefined && result.ret !== 0) || (result.errcode !== undefined && result.errcode !== 0)) {
      const code = result.errcode || result.ret;
      throw Object.assign(new Error(code === -14 ? 'WeChat login expired. Run npm run login.' : `WeChat API error ${code}.`), { code });
    }
    return result;
  }
  updates(cursor, signal) { return this.api('getupdates', { get_updates_buf: cursor }, { signal }); }
  async sendItems(user, context, items, id = randomUUID()) {
    if (!context) throw new Error('No WeChat reply context; send a fresh message from your phone.');
    return this.api('sendmessage', { msg: {
      from_user_id: '', to_user_id: user, client_id: id, message_type: 2,
      message_state: 2, context_token: context, item_list: items,
    } });
  }
  async text(user, context, text, id) {
    return this.sendItems(user, context, [{ type: 1, text_item: { text } }], id);
  }
  async typing(user, context, status = 1) {
    const config = await this.api('getconfig', { ilink_user_id: user, context_token: context }, { timeout: 10000 });
    if (config.typing_ticket) await this.api('sendtyping', { ilink_user_id: user, typing_ticket: config.typing_ticket, status }, { timeout: 10000 });
  }
  async download(item, dir, beforeWrite = () => {}) {
    const object = item.image_item ?? item.file_item ?? item.voice_item ?? item.video_item;
    if (!object) return null;
    const media = object.media;
    if (!media) throw new Error('WeChat attachment has no downloadable media.');
    const url = media.full_url ?? (media.encrypt_query_param ? `${CDN}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}` : null);
    if (!url) throw new Error('WeChat attachment has no download URL.');
    const response = await this.fetch(wechatUrl(url), { redirect: 'error', signal: AbortSignal.timeout(60000) });
    let bytes = await boundedBytes(response);
    if (media.aes_key || object.aeskey) {
      const decipher = createDecipheriv('aes-128-ecb', aesKey(media.aes_key, object.aeskey), null);
      bytes = Buffer.concat([decipher.update(bytes), decipher.final()]);
    }
    if (bytes.length > MAX_MEDIA) throw new Error('Attachment exceeds 25 MiB.');
    let name = object.file_name || (item.type === 2 ? imageName(bytes) : item.type === 3 ? 'voice.silk' : 'video.mp4');
    name = name.replaceAll('\\', '/').split('/').at(-1).replace(/[\x00-\x1f\x7f]/g, '_').slice(-160) || 'attachment.bin';
    secureDir(dir);
    beforeWrite(bytes.length);
    const file = path.join(dir, `${randomUUID()}-${name}`);
    fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' });
    return { path: file, name, kind: item.type === 2 ? 'image' : item.type === 3 ? 'audio' : 'file' };
  }
  async upload(file, user) {
    if (fs.statSync(file).size > MAX_MEDIA) throw new Error('Attachment exceeds 25 MiB.');
    const bytes = fs.readFileSync(file); const key = randomBytes(16); const filekey = randomBytes(16).toString('hex');
    const cipher = createCipheriv('aes-128-ecb', key, null);
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const info = await this.api('getuploadurl', {
      filekey, media_type: 3, to_user_id: user, rawsize: bytes.length,
      rawfilemd5: createHash('md5').update(bytes).digest('hex'), filesize: encrypted.length,
      no_need_thumb: true, aeskey: key.toString('hex'),
    });
    if (!info.upload_full_url && !info.upload_param) throw new Error('WeChat returned no upload URL.');
    const url = info.upload_full_url ?? `${CDN}/upload?encrypted_query_param=${encodeURIComponent(info.upload_param)}&filekey=${filekey}`;
    const response = await this.fetch(wechatUrl(url), { method: 'POST', body: encrypted, headers: { 'Content-Type': 'application/octet-stream' }, redirect: 'error', signal: AbortSignal.timeout(60000) });
    await boundedBytes(response, 1024 * 1024);
    const query = response.headers.get('x-encrypted-param');
    if (!query) throw new Error('WeChat upload returned no media reference.');
    return { type: 4, file_item: { file_name: path.basename(file), len: String(bytes.length), media: {
      encrypt_query_param: query, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1,
    } } };
  }
}

function imageName(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image.png';
  if (bytes[0] === 255 && bytes[1] === 216) return 'image.jpg';
  if (bytes.toString('ascii', 0, 3) === 'GIF') return 'image.gif';
  if (bytes.toString('ascii', 8, 12) === 'WEBP') return 'image.webp';
  return 'image.bin';
}
