/** Private, account-scoped Node storage. Passwords are intentionally unsupported. */
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionData } from '@onethu/core';
const exec = promisify(execFile);
export function authError(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
export type DeviceIdentity = { fingerprint: string; account?: string; finger3?: string };
export type StoredSession = { version: 1; session: SessionData | null; device: DeviceIdentity; epoch?: number; explicitLogout?: boolean };
const noFollow = constants.O_NOFOLLOW ?? 0;
const isMissing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';
async function privateMode(target: string, directory: boolean): Promise<void> {
  if (process.platform !== 'win32') { await chmod(target, directory ? 0o700 : 0o600); return; }
  // icacls edits the DACL only, and /inheritance:r drops every inherited grant
  // before /grant:r adds the single owner rule. Set-Acl rewrote the whole
  // security descriptor instead, which needs SeSecurityPrivilege as soon as an
  // object carries a SACL — an elevated run materialises one, and from then on
  // every unelevated daemon died here with AUTH_STORAGE_ACL_FAILED before it
  // could publish its discovery record. Same shape as notifications/storage.mjs.
  try {
    const { stdout } = await exec('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    const sid = /S-1-5-(?:\d+-)*\d+/.exec(String(stdout))?.[0];
    if (!sid) throw authError('AUTH_STORAGE_ACL_FAILED');
    await exec('icacls.exe', [target, '/inheritance:r', '/grant:r', `*${sid}:${directory ? '(OI)(CI)' : ''}F`], { windowsHide: true });
  } catch { throw authError('AUTH_STORAGE_ACL_FAILED'); }
}
async function checkFile(target: string, directory = false): Promise<void> {
  const stat = await lstat(target);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (!directory && stat.nlink !== 1)) throw authError('AUTH_STORAGE_UNSAFE_PATH');
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw authError('AUTH_STORAGE_UNSAFE_OWNER');
  if (process.platform !== 'win32' && (stat.mode & 0o077)) throw authError('AUTH_STORAGE_PERMISSIONS');
}
function validateSession(value: unknown): StoredSession {
  const v = value as StoredSession;
  if (!v || v.version !== 1 || !v.device || !/^[a-f0-9]{32}$/.test(v.device.fingerprint)) throw authError('AUTH_STORAGE_INVALID');
  if (v.device.account !== undefined && (typeof v.device.account !== 'string' || !/^\d{1,32}$/.test(v.device.account))) throw authError('AUTH_STORAGE_INVALID');
  if (v.device.finger3 !== undefined && (typeof v.device.finger3 !== 'string' || v.device.finger3.length > 8192)) throw authError('AUTH_STORAGE_INVALID');
  if (v.epoch !== undefined && (!Number.isSafeInteger(v.epoch) || v.epoch < 0)) throw authError('AUTH_STORAGE_INVALID');
  if (v.explicitLogout !== undefined && typeof v.explicitLogout !== 'boolean') throw authError('AUTH_STORAGE_INVALID');
  if (v.session !== null) {
    const s = v.session;
    if (!s || typeof s.username !== 'string' || !/^\d{1,32}$/.test(s.username) || s.username !== v.device.account || s.fingerprint !== v.device.fingerprint || typeof s.cookiesJson !== 'string' || s.cookiesJson.length > 4_000_000 || !Number.isFinite(s.savedAt)) throw authError('AUTH_STORAGE_INVALID');
    let cookies: unknown;
    try { cookies = JSON.parse(s.cookiesJson); } catch { throw authError('AUTH_STORAGE_INVALID'); }
    if (!Array.isArray(cookies) || cookies.length > 10000 || cookies.some(c => !c || typeof c.name !== 'string' || typeof c.value !== 'string' || typeof c.domain !== 'string' || !/^[a-z0-9.-]+$/i.test(c.domain) || typeof c.path !== 'string' || !c.path.startsWith('/') || typeof c.secure !== 'boolean' || typeof c.hostOnly !== 'boolean' || /[\r\n\0]/.test(c.name+c.value+c.domain+c.path) || (c.expiresAt !== undefined && !Number.isFinite(c.expiresAt)))) throw authError('AUTH_STORAGE_INVALID');
  }
  // Copy only known fields. An old or hand-edited file cannot smuggle a password
  // into the next snapshot via object spreading.
  return { version: 1, epoch: v.epoch ?? 0, explicitLogout: v.explicitLogout === true, device: { fingerprint: v.device.fingerprint, account: v.device.account, finger3: v.device.finger3 }, session: v.session && {
    username: v.session.username, fingerprint: v.device.fingerprint, finger3: v.device.finger3,
    cookiesJson: v.session.cookiesJson, savedAt: v.session.savedAt,
  } };
}
/** Validate an account handoff before any state or transport is changed. */
export function validateDesktopSession(value: unknown): SessionData {
  const input = value as SessionData;
  if (!input || typeof input !== 'object' || !input.fingerprint) throw authError('AUTH_HANDOFF_INVALID');
  const valid = validateSession({version:1,device:{account:input.username,fingerprint:input.fingerprint,finger3:input.finger3},session:input}).session!;
  const cookies = JSON.parse(valid.cookiesJson) as {domain:string}[];
  if (!cookies.length || cookies.some(cookie => {
    const domain = cookie.domain.replace(/^\./,'').toLowerCase();
    return domain !== 'tsinghua.edu.cn' && !domain.endsWith('.tsinghua.edu.cn');
  })) throw authError('AUTH_HANDOFF_COOKIE_SCOPE');
  return valid;
}
export async function openSessionStorage(dataDir: string, timeoutMs = 5000) {
  if (!path.isAbsolute(dataDir) || dataDir.split(/[\\/]/).includes('..')) throw authError('AUTH_STORAGE_UNSAFE_PATH');
  const root = path.resolve(dataDir);
  await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  // Ancestors may be OS aliases (macOS /tmp), but the owned directory itself
  // must be a real directory and all accesses remain inside its canonical path.
  try { await mkdir(root, { mode: 0o700 }); await privateMode(root, true); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  await checkFile(root, true);
  if (process.platform === 'win32') await privateMode(root, true);
  const canonical = await realpath(root);
  const lock = path.join(canonical, '.session.lock');
  const nonce = randomBytes(16).toString('hex');
  const started = Date.now();
  while (true) {
    let created = false;
    try {
      await mkdir(lock, { mode: 0o700 }); created = true; await privateMode(lock, true);
      const owner = await open(path.join(lock, 'owner.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
      try { await owner.writeFile(JSON.stringify({ pid: process.pid, nonce })); await owner.sync(); } finally { await owner.close(); }
      break;
    } catch (e) {
      if (created) { await unlink(path.join(lock,'owner.json')).catch(()=>undefined);await rmdir(lock).catch(()=>undefined);throw e; }
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      await checkFile(lock, true);
      try {
        await checkFile(path.join(lock, 'owner.json'));
        const handle = await open(path.join(lock, 'owner.json'), constants.O_RDONLY | noFollow);
        let owner: {pid?: unknown; nonce?: unknown};
        try { owner = JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
        if (Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0 && typeof owner.nonce === 'string') {
          let dead = false;
          try { process.kill(Number(owner.pid), 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
          if (dead) {
            // Serialize stale-owner recovery, then re-read the nonce under this
            // gate. Two contenders must never unlink a newly acquired lock.
            const recovery=path.join(canonical,'.session.recovery');let acquired=false,reclaimed=false;
            try {
              try { await mkdir(recovery,{mode:0o700});acquired=true; }
              catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
              if(acquired){
                await checkFile(path.join(lock,'owner.json'));
                const again=await open(path.join(lock,'owner.json'),constants.O_RDONLY|noFollow);
                let current:{pid?:unknown;nonce?:unknown};try{current=JSON.parse(await again.readFile('utf8'));}finally{await again.close();}
                if(current.pid===owner.pid&&current.nonce===owner.nonce&&(await readdir(lock)).every(name=>name==='owner.json')){
                  await unlink(path.join(lock,'owner.json'));await rmdir(lock);reclaimed=true;
                }
              }
            }finally{if(acquired)await rmdir(recovery);}
            if(reclaimed)continue;
          }
        }
      } catch (error) { if (!isMissing(error) && !(error instanceof SyntaxError)) throw error; }
      if (Date.now() - started >= timeoutMs) throw authError('AUTH_SESSION_BUSY');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  let closed = false;
  const file = path.join(canonical, 'session.json');
  let writes: Promise<void> = Promise.resolve();
  async function load(): Promise<StoredSession | null> {
    if (closed) throw authError('AUTH_SESSION_CLOSED');
    try {
      await checkFile(file); const handle = await open(file, constants.O_RDONLY | noFollow);
      try { if ((await handle.stat()).size > 5_000_000) throw authError('AUTH_STORAGE_INVALID'); return validateSession(JSON.parse(await handle.readFile('utf8'))); }
      finally { await handle.close(); }
    } catch (error) { if (isMissing(error)) return null; throw error; }
  }
  async function save(value: StoredSession): Promise<void> {
    if (closed) throw authError('AUTH_SESSION_CLOSED');
    const safe = validateSession(value);
    const operation = writes.catch(() => undefined).then(async () => {
      await checkFile(canonical, true);
      try { await checkFile(file); } catch (e) { if (!isMissing(e)) throw e; }
      const temporary = path.join(canonical, `.session-${nonce}-${randomBytes(6).toString('hex')}.tmp`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
      try {
        try { await privateMode(temporary, false); await handle.writeFile(JSON.stringify(safe)); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, file);
      } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
    });
    writes = operation; await operation;
  }
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    try { await writes; } finally {
      await checkFile(lock, true);
      const handle = await open(path.join(lock, 'owner.json'), constants.O_RDONLY | noFollow);
      let owner: {nonce?: string}; try { owner = JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
      if (owner.nonce !== nonce) throw authError('AUTH_LOCK_OWNERSHIP_CHANGED');
      await unlink(path.join(lock, 'owner.json')); await rmdir(lock);
    }
  }
  return { load, save, close, directory: canonical };
}
