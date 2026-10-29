#!/usr/bin/env node
/** Package the same independent CLI used by terminal clients, with a private
 * Node runtime. Desktop hosts never depend on the user's PATH or npm install. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile, chmod, rename, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { resolveCliPackageVersion } from './cli-package-version.mjs';

const scriptDir=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(scriptDir,'../../..');
const target=process.env.CARGO_BUILD_TARGET??process.env.TAURI_ENV_TARGET_TRIPLE??'';
const targetPlatform=process.env.TAURI_ENV_PLATFORM??(target.includes('android')?'android':target.includes('windows')?'windows':target.includes('apple-darwin')?'macos':process.platform);
const platform=({macos:'darwin',windows:'win32'})[targetPlatform]??targetPlatform;
if(platform==='android'||platform==='ios'||process.env.ONETHU_MOBILE_BUILD==='1') {
  console.log('OneTHU CLI runtime: mobile build, no Node resources.');
  process.exit(0);
}
if(!['darwin','win32','linux'].includes(platform)) throw Error('Unsupported desktop CLI platform: '+platform);
const rawArch=process.env.TAURI_ENV_ARCH??(target.startsWith('aarch64')?'arm64':target.startsWith('x86_64')?'x64':process.arch);
const arch=({aarch64:'arm64',x86_64:'x64'})[rawArch]??rawArch;
if(!['arm64','x64'].includes(arch)) throw Error('Unsupported desktop CLI architecture: '+arch);
if(platform!==process.platform) throw Error('Build the desktop CLI on its target platform; do not package a host Node binary for a different OS.');
const output=path.resolve(scriptDir,'../src-tauri/resources/cli-runtime');
const staging=output+'.staging-'+process.pid;
const hash=data=>createHash('sha256').update(data).digest('hex');
const checkedVersion=v=>/^v(?:2[2-9]|[3-9]\d)\.\d+\.\d+$/.test(v);
const nodeVersion=process.env.ONETHU_CLI_NODE_VERSION??(checkedVersion(process.version)?process.version:'v22.22.1');
if(!checkedVersion(nodeVersion)) throw Error('ONETHU_CLI_NODE_VERSION must be an exact Node >=22 version.');
const nodeName=platform==='win32'?'node.exe':'node';
/** SDK 把版本编进 bundle，`daemon.status` 报的就是它；分叉包版本与上游不是一条序列。
 *  打包期间替换这一行常量，构建完还原（被别处改动过就不覆盖，只报错让人核对）。 */
const SDK_INDEX=path.join(root,'packages/sdk/src/index.ts');
const SDK_VERSION_LINE=/^export const VERSION = '([^']+)';$/m;
async function withSdkVersion(version,build) {
  const source=await readFile(SDK_INDEX,'utf8');
  const match=SDK_VERSION_LINE.exec(source);
  if(!match) throw Error('packages/sdk/src/index.ts: VERSION 行形状变了，无法注入 CLI 包版本');
  if(match[1]===version) return build();
  const patched=source.replace(SDK_VERSION_LINE,`export const VERSION = '${version}';`);
  await writeFile(SDK_INDEX,patched);
  try {
    return await build();
  } finally {
    const current=await readFile(SDK_INDEX,'utf8');
    if(current===patched) await writeFile(SDK_INDEX,source);
    else console.error(`✗ ${SDK_INDEX} 在打包期间被改动，未自动还原（应为 ${version}）`);
  }
}

async function download(url) {
  const response=await fetch(url,{signal:AbortSignal.timeout(120000),redirect:'error'});
  if(!response.ok) throw Error('Node runtime download failed ('+response.status+'): '+url);
  return Buffer.from(await response.arrayBuffer());
}
function standaloneMacNode(file) {
  if(platform!=='darwin') return true;
  try {
    return execFileSync('otool',['-L',file],{encoding:'utf8'}).split('\n').slice(1).filter(Boolean).every(line=>/^\s+\/(?:usr\/lib|System\/Library)\//.test(line));
  } catch { return false; }
}
async function nodeRuntime() {
  const candidate=process.env.ONETHU_CLI_NODE??process.execPath;
  let version=null;
  try {
    version=JSON.parse(execFileSync(candidate,['-p','JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'],{encoding:'utf8',env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''}}));
  } catch {
    version=null;
  }
  // Homebrew Node has external dylibs. Official release archives provide a
  // standalone executable and its complete bundled dependency licence notice.
  // Same-OS cross-arch builds (x64 macOS packing an arm64 DMG) skip the host
  // binary and fall through to the official archive for the target arch.
  if(version&&version.platform===platform&&version.arch===arch&&checkedVersion(version.version)&&standaloneMacNode(candidate)) {
    for(const license of [path.resolve(candidate,'../../LICENSE'),path.join(path.dirname(candidate),'LICENSE')]) {
      try { if((await stat(license)).isFile()) return {binary:candidate,license,version:version.version}; } catch {}
    }
  }
  const nodePlatform=platform==='win32'?'win':platform;
  const name=`node-${nodeVersion}-${nodePlatform}-${arch}`;
  const archive=name+(platform==='win32'?'.zip':'.tar.gz');
  const cache=path.join(process.env.ONETHU_CLI_RUNTIME_CACHE??path.join(homedir(),'.cache','onethu-cli-runtime'),name);
  const binary=path.join(cache,platform==='win32'?'node.exe':'bin/node'),license=path.join(cache,'LICENSE');
  const origin=`https://nodejs.org/dist/${nodeVersion}/`;
  const marker=path.join(cache,'.verified.json');
  // Exact releases are immutable. Recheck cached file digests without requiring
  // network access every time a developer restarts the preview.
  try {
    const saved=JSON.parse(await readFile(marker,'utf8'));
    if(/^[a-f0-9]{64}$/.test(saved.archiveSha256??'')&&saved.nodeSha256===hash(await readFile(binary))&&saved.licenseSha256===hash(await readFile(license))) return {binary,license,version:nodeVersion};
  } catch {}
  const sums=(await download(origin+'SHASUMS256.txt')).toString('utf8');
  const expected=sums.split('\n').map(line=>line.trim().split(/\s+/)).find(parts=>parts[1]===archive)?.[0];
  if(!/^[a-f0-9]{64}$/.test(expected??'')) throw Error('Official Node checksum is missing for '+archive);
  const bytes=await download(origin+archive);
  if(hash(bytes)!==expected) throw Error('Official Node archive checksum mismatch.');
  const temp=path.join(tmpdir(),'onethu-node-'+process.pid+'-'+Date.now());
  await mkdir(temp,{recursive:true});
  try {
    const archivePath=path.join(temp,archive);
    await writeFile(archivePath,bytes);
    if(platform==='win32') {
      // Environment values avoid interpolating paths into PowerShell syntax.
      execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath $env:ONETHU_NODE_ARCHIVE -DestinationPath $env:ONETHU_NODE_EXTRACT'],{env:{...process.env,ONETHU_NODE_ARCHIVE:archivePath,ONETHU_NODE_EXTRACT:temp},stdio:'pipe'});
    } else execFileSync('tar',['-xzf',archivePath,'-C',temp],{stdio:'pipe'});
    await rm(cache,{recursive:true,force:true});
    await mkdir(path.dirname(cache),{recursive:true});
    await cp(path.join(temp,name),cache,{recursive:true});
    await writeFile(marker,JSON.stringify({archiveSha256:expected,nodeSha256:hash(await readFile(binary)),licenseSha256:hash(await readFile(license))}));
  } finally { await rm(temp,{recursive:true,force:true}); }
  return {binary,license,version:nodeVersion};
}

await rm(staging,{recursive:true,force:true});
await mkdir(staging,{recursive:true});
try {
  const {version:packageVersion,source:versionSource}=resolveCliPackageVersion();
  // daemon.status 报的是 SDK 里编译进去的 VERSION 常量（packages/sdk/src/index.ts），
  // 光改包内 package.json 不够：打包期间把它换成应用版本，构建结束原样还原。
  await withSdkVersion(packageVersion,()=>execFileSync(process.execPath,[path.join(root,'packages/cli/scripts/build.mjs')],{cwd:root,stdio:'inherit'}));
  const node=await nodeRuntime();
  for(const item of ['package.json','bin','src','scripts','dist','README.md','README.en.md','LICENSE','LICENSES']) {
    await cp(path.join(root,'packages/cli',item),path.join(staging,item),{recursive:true,filter:file=>!path.basename(file).startsWith('._')});
  }
  await cp(node.binary,path.join(staging,nodeName));
  await chmod(path.join(staging,nodeName),0o755);
  await cp(node.license,path.join(staging,'LICENSES','NODE-LICENSE'));
  // 版本对齐：应用按「已安装包版本 == 应用版本」判定可用（见 scripts/cli-package-version.mjs）。
  // 分叉构建把包内 package.json 的版本改成应用版本，CLI 自报版本、runtime.json 与 zip 文件名
  // 三处才对得上——只改 runtime.json 会让 CLI 进程自报上游版本，daemon 握手仍被判不兼容。
  const stagedPackage=path.join(staging,'package.json');
  const staged=JSON.parse(await readFile(stagedPackage,'utf8'));
  if(staged.version!==packageVersion){
    const original=staged.version;
    staged.version=packageVersion;
    await writeFile(stagedPackage,JSON.stringify(staged,null,2)+'\n');
    console.log(`CLI package version: ${original} → ${packageVersion} (from ${versionSource})`);
  }
  if(platform==='darwin') execFileSync('codesign',['--force','--sign','-',path.join(staging,nodeName)],{stdio:'pipe'});
  // Keep Node as data during app signing so nested Mach-O resigning cannot
  // invalidate the installer's digest. The compressed resource also shrinks the app.
  const nodeBytes=await readFile(path.join(staging,nodeName));
  const nodeSha256=hash(nodeBytes);
  await writeFile(path.join(staging,'node.gz'),gzipSync(nodeBytes,{level:9}));
  await rm(path.join(staging,nodeName));
  const files={};
  async function walk(dir,relative='') {
    for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(entry.name.startsWith('._')) continue;
      const rel=relative+entry.name;
      if(entry.isDirectory()) await walk(path.join(dir,entry.name),rel+'/');
      else if(entry.isFile()) files[rel]=hash(await readFile(path.join(dir,entry.name)));
      else throw Error('CLI runtime contains a non-regular file: '+rel);
    }
  }
  await walk(staging);
  const manifest={protocolVersion:1,version:JSON.parse(await readFile(path.join(staging,'package.json'),'utf8')).version,platform,arch,nodeVersion:node.version,nodeSha256,files};
  manifest.buildId=hash(JSON.stringify(manifest));
  await writeFile(path.join(staging,'runtime.json'),JSON.stringify(manifest,null,2)+'\n');
  await rm(output,{recursive:true,force:true});
  await rename(staging,output);
  console.log(`OneTHU CLI runtime bundled: ${platform}/${arch} ${node.version}, ${manifest.buildId.slice(0,12)}`);
} finally { await rm(staging,{recursive:true,force:true}); }
