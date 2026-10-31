import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {DaemonClient} from '../src/daemon.mjs';
const fixture=fileURLToPath(new URL('./fixtures/daemon-startup.mjs',import.meta.url));
const snapshot={username:'90000001',fingerprint:'c'.repeat(32),cookiesJson:JSON.stringify([
  {name:'sid',value:'synthetic-cookie',domain:'id.tsinghua.edu.cn',path:'/',secure:true,hostOnly:true},
]),savedAt:1};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deadline=ms=>new Promise((_,reject)=>{setTimeout(()=>reject(Error('startup fixture timeout')),ms).unref();});
async function start(t){
  const dir=await mkdtemp(path.join(tmpdir(),'onethu-held-startup-'));
  await writeFile(path.join(dir,'session.json'),JSON.stringify({version:1,epoch:4,explicitLogout:false,device:{fingerprint:snapshot.fingerprint,account:snapshot.username},session:snapshot}),{mode:0o600});
  const child=spawn(process.execPath,[fixture,dir],{env:{...process.env,ONETHU_ENDPOINT:''},stdio:['ignore','pipe','pipe','ipc']});
  const closed=once(child,'close');let stderr='';child.stderr.on('data',b=>{stderr+=b;});
  const held=new Promise(resolve=>child.on('message',message=>{if(message==='probe-held')resolve();}));
  t.after(async()=>{if(child.exitCode===null){child.send('release');child.kill('SIGTERM');}await closed;await rm(dir,{recursive:true,force:true});});
  const lines=createInterface({input:child.stdout});
  await Promise.race([once(lines,'line'),closed.then(()=>{throw Error(stderr||'daemon exited');}),deadline(30000)]);lines.close();
  await Promise.race([held,deadline(15000)]);
  // Windows CI 上 daemon 首次初始化存储要经 PowerShell 写 DACL（实测单次可达 2s+），
  // 2s 的客户端超时会让 desktop.logout/exportSession 直接报 DAEMON_REQUEST_TIMEOUT。
  const client=new DaemonClient(JSON.parse(await readFile(path.join(dir,'daemon-access.json'),'utf8')),15000);
  return {child,client,dir};
}
test('desktop exports its durable snapshot while the daemon startup network probe is hanging',{timeout:60000},async t=>{
  const f=await start(t),s=await f.client.call('desktop.exportSession');
  assert.equal(s.restoring,true);assert.equal(s.snapshot.username,snapshot.username);assert.equal(s.session.authenticated,false);
});
test('explicit desktop logout interrupts startup and a late response cannot restore the account',{timeout:60000},async t=>{
  const f=await start(t),s=await f.client.call('desktop.status');
  await f.client.call('desktop.logout',{expectedAccount:s.username,expectedEpoch:s.epoch});
  f.child.send('release');await delay(50);
  const after=await f.client.call('desktop.exportSession');assert.equal(after.snapshot,null);assert.equal(after.username,null);assert.equal(after.tombstone,true);
  assert.equal(JSON.parse(await readFile(path.join(f.dir,'session.json'),'utf8')).session,null);
});
test('a verified explicit handoff supersedes the hanging startup probe without waiting for it',{timeout:60000},async t=>{
  const f=await start(t),s=await f.client.call('desktop.status');
  const next={...snapshot,fingerprint:'d'.repeat(32)};
  const adopted=await f.client.call('desktop.adoptSession',{snapshot:next,expectedEpoch:s.epoch,reason:'login'});
  assert.equal(adopted.session.state,'ready');f.child.send('release');await delay(50);
  const after=await f.client.call('desktop.exportSession');assert.equal(after.snapshot.fingerprint,next.fingerprint);assert.equal(after.session.state,'ready');
});
