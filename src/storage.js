import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MEDIA_BUDGET = 512 * 1024 * 1024;
export const MEDIA_FILES = 2048;
export function secureDir(dir) {
  dir = path.resolve(dir);
  // Refuse symlink components before creating or chmodding anything.
  let current = path.parse(dir).root;
  for (const part of dir.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Private directory cannot contain symlinks.'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Private directory must be owned by this user.');
  fs.chmodSync(dir, 0o700);
  return dir;
}
export function secureFile(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Private file must be a regular, singly linked file owned by this user.');
  fs.chmodSync(file, 0o600);
}
export function mediaUsage(dir) {
  let bytes = 0, files = 0;
  const walk = p => {
    if (!fs.existsSync(p)) return;
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) throw new Error('Media storage cannot contain symlinks.');
    if (stat.isDirectory()) { secureDir(p); for (const name of fs.readdirSync(p)) walk(path.join(p, name)); }
    else { secureFile(p); bytes += stat.size; files++; }
  };
  for (const name of ['inbound', 'outbound']) walk(path.join(dir, name));
  return { bytes, files, maxBytes: MEDIA_BUDGET, maxFiles: MEDIA_FILES };
}
export function reserveMedia(dir, bytes) {
  const usage = mediaUsage(dir);
  if (usage.bytes + bytes > MEDIA_BUDGET || usage.files >= MEDIA_FILES) throw new Error('Attachment storage is full. Use /storage and remove unneeded inbound files locally.');
}
export function exportRoot(dir) { return path.resolve(process.env.WECHAT_CODEX_EXPORT_DIR || path.join(dir, 'exports')); }
export function snapshotExport(dir, requested, maxBytes) {
  const root = secureDir(exportRoot(dir));
  const file = path.resolve(root, requested);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('Exports must be inside the folder shown by /exports.');
  let current = root;
  for (const component of relative.split(path.sep)) {
    if (component.startsWith('.') || /^(?:id_rsa|id_ed25519|credentials|auth\.json|account\.json)$/i.test(component) || /\.(?:pem|key|p12|pfx)$/i.test(component)) throw new Error('Credential and hidden paths cannot be exported.');
    current = path.join(current, component);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Export symlinks are not allowed.');
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Export must be a regular, singly linked file owned by this user.');
    if (stat.size > maxBytes) throw new Error('Attachment exceeds 25 MiB.');
    reserveMedia(dir, stat.size);
    // Read at most the limit even if the source grows during the copy.
    const bytes = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < bytes.length) { const n = fs.readSync(fd, bytes, length, bytes.length - length, null); if (!n) break; length += n; }
    if (length > stat.size) throw new Error('Export changed during snapshot; retry after writing finishes.');
    const folder = secureDir(path.join(secureDir(path.join(dir, 'outbound')), randomUUID()));
    const target = path.join(folder, path.basename(file));
    try { fs.writeFileSync(target, bytes.subarray(0, length), { flag: 'wx', mode: 0o600 }); }
    catch (e) { fs.rmSync(folder, { recursive: true, force: true }); throw e; }
    return target;
  } finally { fs.closeSync(fd); }
}
export function removeSnapshot(dir, file) {
  if (!file) return;
  const root = path.join(path.resolve(dir), 'outbound');
  const relative = path.relative(root, path.resolve(file));
  if (!/^[0-9a-f-]{36}[/\\][^/\\]+$/i.test(relative)) return;
  const folder = path.dirname(file);
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) return;
  if (fs.existsSync(folder) && fs.lstatSync(folder).isSymbolicLink()) return;
  fs.rmSync(file, { force: true });
  try { fs.rmdirSync(folder); } catch (e) { if (!['ENOENT', 'ENOTEMPTY'].includes(e.code)) throw e; }
}
