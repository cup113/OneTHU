import path from 'node:path';
import { constants, existsSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

const exec = promisify(execFile);
const noFollow = constants.O_NOFOLLOW ?? 0;
const missing = error => error?.code === 'ENOENT';
/** Windows 自带 whoami/icacls 在 System32，但 PATH 会把它们劫持掉——Git 的 coreutils
 * 也带一个 whoami.exe，它把 `/user` 当多余参数（Windows CI 实测：
 * "whoami: extra operand '/user'"），另一份 icacls 则可能根本不存在。按绝对路径解析，
 * 找不到才退回裸名字。 */
const systemTool = name => {
  const root = process.env.SystemRoot || process.env.windir;
  if (!root) return name;
  const full = path.join(root, 'System32', name);
  return existsSync(full) ? full : name;
};
export class NotificationError extends Error {
  constructor(code, message = code) { super(message); this.code = code; }
}
export function fail(code, message) { throw new NotificationError(code, message); }

async function assertPath(target, allowMissing = false) {
  let cursor = path.parse(target).root;
  for (const part of path.resolve(target).slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = await lstat(cursor); } catch (error) { if (allowMissing && missing(error)) return; throw error; }
    if (stat.isSymbolicLink()) fail('NOTIFICATION_STORAGE_UNSAFE_PATH');
  }
}
async function privateMode(target, directory) {
  if (process.platform !== 'win32') { await chmod(target, directory ? 0o700 : 0o600); return; }
  const { stdout } = await exec(systemTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const sid = /S-1-5-(?:\d+-)*\d+/.exec(stdout)?.[0];
  if (!sid) fail('NOTIFICATION_STORAGE_ACL_FAILED');
  await exec(systemTool('icacls.exe'), [target, '/inheritance:r', '/grant:r', `*${sid}:${directory ? '(OI)(CI)' : ''}F`], { windowsHide: true });
}
async function checkOwned(target, directory) {
  await assertPath(target);
  const stat = await lstat(target);
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) fail('NOTIFICATION_STORAGE_UNSAFE_PATH');
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('NOTIFICATION_STORAGE_UNSAFE_OWNER');
  if (process.platform !== 'win32' && stat.mode & 0o077) fail('NOTIFICATION_STORAGE_PERMISSIONS');
}

/** The SDK runtime owns the enclosing data-directory lock for this store's lifetime. */
export class NotificationStorage {
  constructor(directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.split(/[\\/]/).includes('..')) fail('NOTIFICATION_STORAGE_ABSOLUTE_PATH_REQUIRED');
    this.directory = path.resolve(directory);
    this.pending = new Set(); this.closed = false; this.closePromise = null;
    this.ready = this.initialize();
    // Construction starts I/O even when no channel is ever used. Observe an
    // early failure immediately; reads/writes still await the original promise.
    this.ready.catch(() => {});
  }
  async initialize() {
    await assertPath(this.directory, true);
    await mkdir(path.dirname(this.directory), { recursive: true, mode: 0o700 });
    try { await mkdir(this.directory, { mode: 0o700 }); await privateMode(this.directory, true); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    await checkOwned(this.directory, true);
    for (const sub of ['ledger', 'inbox']) {
      const target = path.join(this.directory, sub);
      try { await mkdir(target, { mode: 0o700 }); await privateMode(target, true); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
      await checkOwned(target, true);
    }
  }
  file(name) {
    if (!/^(?:config\.json|(?:ledger|inbox)\/[a-f0-9]{64}\.json)$/.test(name)) fail('NOTIFICATION_STORAGE_UNSAFE_PATH');
    return path.join(this.directory, ...name.split('/'));
  }
  perform(work) {
    if (this.closed) return Promise.reject(new NotificationError('NOTIFICATION_STORAGE_CLOSED'));
    const operation = this.ready.then(work);
    this.pending.add(operation);
    operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
    return operation;
  }
  read(name) { return this.perform(async () => {
    const target = this.file(name);
    try {
      await checkOwned(target, false);
      const handle = await open(target, constants.O_RDONLY | noFollow);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) fail('NOTIFICATION_STORAGE_INVALID');
        const text = await handle.readFile('utf8');
        if (Buffer.byteLength(text) > 1024 * 1024) fail('NOTIFICATION_STORAGE_INVALID');
        try { return JSON.parse(text); } catch { fail('NOTIFICATION_STORAGE_INVALID'); }
      } finally { await handle.close(); }
    } catch (error) { if (missing(error)) return null; throw error; }
  }); }
  write(name, value) { return this.perform(async () => {
    const target = this.file(name);
    await checkOwned(path.dirname(target), true);
    try { await checkOwned(target, false); } catch (error) { if (!missing(error)) throw error; }
    const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    const text = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(text) > 1024 * 1024) fail('NOTIFICATION_STORAGE_INVALID');
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    try { await privateMode(temporary, false); await handle.writeFile(text); await handle.sync(); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    finally { await handle.close(); }
    try { await rename(temporary, target); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    // Make the rename durable where directory fsync is supported. Windows has no
    // portable directory fsync, but the file itself is flushed before rename.
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(target), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }); }
  inboxNames() { return this.perform(async () => {
    await checkOwned(path.join(this.directory, 'inbox'), true);
    return (await readdir(path.join(this.directory, 'inbox'))).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  }); }
  close() {
    if (!this.closePromise) {
      this.closed = true;
      // A storage failure must not prevent the owner from releasing its lock.
      // It remains observable through the original ready/operation promises.
      this.closePromise = Promise.allSettled([this.ready, ...this.pending]).then(() => {});
    }
    return this.closePromise;
  }
}
