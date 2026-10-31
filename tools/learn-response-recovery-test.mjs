/** Real HttpClient + LearnClient, synthetic transport only. Never uses an account. */
import assert from 'node:assert/strict';
import { HttpClient, AuthRequiredError, onAuthRequired } from '../packages/core/src/http.ts';
import { LearnClient } from '../packages/core/src/learn/client.ts';
import * as urls from '../packages/core/src/learn/urls.ts';
globalThis.fetch = async () => { throw Error('Live network forbidden'); };
const page = '<html><script>var __vpn_hostname_data="vpn", __vpn_app_hostname_data="learn";</script><a href="/f/wlxt/index?_csrf=fixture-token">Courses</a></html>';
const login = '<html><title>网络学堂</title><a class="re_log" href="/f/login">重新登录</a></html>';
const gateway = '<html><script>var __vpn_hostname_data="vpn", __vpn_app_hostname_data="learn";</script></html>';
const form = '<html><form><textarea name="zynr">Example answer</textarea><input name="fileupload"></form></html>';
const notice = '<html><a class="ml-10" href="/b/wlxt/notice?wjid=fixture-file">Example.pdf</a></html>';
const defer = () => { let resolve; const promise = new Promise(r => resolve=r); return {promise, resolve}; };
let count = 0;
async function test(name, fn) { await fn(); count++; console.log('✓ ' + name); }
function fixture(handler) {
  const logs = [], calls = [];
  const http = new HttpClient({ fetch: async (url, init) => {
    calls.push({ url, method: init.method ?? 'GET' });
    if (url.includes('/wengine-vpn/cookie')) return new Response('');
    const result = await handler(url, init);
    return result instanceof Response ? result : new Response(typeof result === 'string' ? result : JSON.stringify(result));
  }});
  http.debug = text => logs.push(text);
  const client = new LearnClient(http);
  client.applyCsrf('old-fixture-token');
  return { client, http, calls, logs };
}
await test('normal Wengine-injected course page is accepted and diagnosed as proxied business page', async () => {
  const {client} = fixture(() => page);
  assert.equal(await client.resume(), true);
  assert.match(client.lastDebug, /kind=learn-page-proxied/);
  assert.match(client.lastCsrfDebug, /^ok/);
});
await test('login page with its own CSRF cannot establish a learning session', async () => {
  const {client} = fixture(() => login.replace('</html>', '<input name="_csrf" value="login-only"></html>'));
  let hooks=0; client.reloginHook = async () => { hooks++; return false; };
  assert.equal(await client.resume(), false); assert.equal(hooks, 1);
  assert.match(client.lastCsrfDebug, /^miss kind=learn-login-shell/);
});
for (const body of [login, '<html><input name="i_pass"><input name="_csrf" value="login-only"></html>']) {
  await test('JSON course endpoint login HTML gets exactly one learning-domain recovery', async () => {
    let alive=false, hooks=0;
    const f=fixture(url => url.includes('/f/wlxt/index/course/student/') ? page : alive ? {resultList:[{wlkcid:'example-course', kcm:'Example'}]} : body);
    f.client.reloginHook=async () => { hooks++; alive=true; return true; };
    assert.equal((await f.client.getCourseList('example-semester'))[0].id, 'example-course');
    assert.equal(hooks,1);
    assert.equal(f.calls.filter(c=>c.url.includes('loadCourseBySemesterId')).length,2);
  });
}
await test('failed learning recovery rejects instead of looping or returning empty courses', async () => {
  let hooks=0; const f=fixture(()=>login);
  f.client.reloginHook=async()=>{hooks++; return false;};
  await assert.rejects(f.client.getCourseList('example'), AuthRequiredError);
  assert.equal(hooks,1); assert.equal(f.client.csrfToken,null);
});
await test('a retry that still returns login fails after one attempt', async () => {
  let hooks=0; const f=fixture(url=>url.includes('/f/wlxt/index/course/student/')?page:login);
  f.client.reloginHook=async()=>{hooks++;return true;};
  await assert.rejects(f.client.getCourseList('example'), AuthRequiredError); assert.equal(hooks,1);
});
for (const [body,status] of [
  ['<html><title>HTTP Status 502</title>Example</html>',502],
  ['<html><title>HTTP Status 500</title>Example</html>',200],
  ['{"error":"rate-limited"}',429], [gateway,200], ['{"unfinished":',200], ['null',200],
]) {
  await test(`non-auth response (${status}, ${body.slice(0,26)}) does not start login`,async()=>{
    let hooks=0;const f=fixture(()=>new Response(body,{status}));
    f.client.reloginHook=async()=>{hooks++;return false;};
    await assert.rejects(f.client.getCourseList('example'), e=>!(e instanceof AuthRequiredError));
    assert.equal(hooks,0);
  });
}
await test('login text quoted inside valid JSON stays course data',async()=>{
  let hooks=0;const f=fixture(()=>({resultList:[{wlkcid:'example',kcm:login}]}));
  f.client.reloginHook=async()=>{hooks++;return false;};
  assert.equal((await f.client.getCourseList('example')).length,1); assert.equal(hooks,0);
});
await test('late parallel failures share one successful recovery generation',async()=>{
  const late=defer(); let failedCalls=0, hooks=0;
  const f=fixture(async url=>{
    if (url.includes('/f/wlxt/index/course/student/')) return page;
    if (url.includes('_csrf=old-fixture-token')) { if (++failedCalls===2) await late.promise; return login; }
    return {resultList:[]};
  });
  f.client.reloginHook=async()=>{hooks++;return true;};
  const first=f.client.getCourseList('A'), second=f.client.getCourseList('B');
  await first; late.resolve(); await second; assert.equal(hooks,1);
});
await test('late parallel failures share failed recovery without another login',async()=>{
  const late=defer();let calls=0,hooks=0;
  const f=fixture(async()=>{if(++calls===2)await late.promise;return login;});
  f.client.reloginHook=async()=>{hooks++;return false;};
  const first=assert.rejects(f.client.getCourseList('A'),AuthRequiredError);
  const second=assert.rejects(f.client.getCourseList('B'),AuthRequiredError);
  await first;late.resolve();await second;assert.equal(hooks,1);
});
await test('homework double page login recovers both pages before parsing form and answer',async()=>{
  let alive=false,hooks=0;
  const f=fixture(url=>url.includes('/f/wlxt/index/course/student/')?page:alive?form:login);
  f.client.reloginHook=async()=>{hooks++;alive=true;return true;};
  const detail=await f.client.getHomeworkPageDetail('example-course','example-homework');
  assert.equal(detail.hasSubmitForm,true); assert.equal(detail.submittedContent,'Example answer');assert.equal(hooks,1);
  assert.equal(f.calls.filter(c=>/viewCj|tijiao/.test(c.url)).length,4);
});
await test('one unavailable homework page rejects instead of inventing a missing form',async()=>{
  const f=fixture(url=>url.includes('viewCj')?form:new Response('Unavailable',{status:503}));
  await assert.rejects(f.client.getHomeworkPageDetail('example','example'),/HTTP 503/);
});
await test('one empty homework page is unavailable, not proof that a form is absent',async()=>{
  const f=fixture(url=>url.includes('tijiao')?'':'<html><p>Grade page</p></html>');
  await assert.rejects(f.client.getHomeworkPageDetail('example','example'),/LEARN_RESPONSE_UNEXPECTED/);
});
await test('assignment prose and an ID link alongside a real form do not trigger login',async()=>{
  let hooks=0;
  const f=fixture(()=>form.replace('</html>','<p>Discuss re_log</p><a href="https://id.tsinghua.edu.cn/do/off/ui/auth/login/form/example/0">Reference</a></html>'));
  f.client.reloginHook=async()=>{hooks++;return false;};
  assert.equal((await f.client.getHomeworkPageDetail('example','example')).hasSubmitForm,true);assert.equal(hooks,0);
});
for (const read of ['getAllHomework','getAllNotifications','getFileList']) {
  await test(`${read} rejects missing containers but accepts explicit empty data`,async()=>{
    for (const body of [{},{message:'Please log in'}]) {
      const f=fixture(()=>body);
      await assert.rejects(f.client[read](read==='getFileList'?'example':['example']),/LEARN_RESPONSE_UNEXPECTED/);
    }
    for (const body of [{object:[]},{object:{aaData:[]}},{object:{resultsList:[]}}]) {
      const f=fixture(()=>body);
      assert.equal((await f.client[read](read==='getFileList'?'example':['example'])).length,0);
    }
  });
}
for (const method of ['resume','getAllHomework']) {
  await test(`${method} with no CSRF recovers one initial HTTP 401 and stores the fresh session`,async()=>{
    let alive=false,hooks=0;
    const f=fixture(url=>url.includes('/f/wlxt/index/course/student/')
      ? new Response(alive?page:'Unauthorized',{status:alive?200:401})
      : {object:[]});
    f.client.applyCsrf('');
    f.client.reloginHook=async()=>{
      hooks++; assert.equal(f.client.lastCsrfDebug,'miss status=401');
      alive=true; return true;
    };
    const result=await f.client[method](['example']);
    if(method==='resume') assert.equal(result,true); else assert.deepEqual(result,[]);
    assert.equal(hooks,1);assert.equal(f.client.csrfToken,'fixture-token');
    assert.equal(f.calls.filter(c=>c.url.includes('/f/wlxt/index/course/student/')).length,2);
  });
  await test(`${method} with no CSRF does not relogin on 403, 429, 503 or gateway failures`,async()=>{
    for(const [body,status] of [['Denied',403],['Busy',429],['Busy',503],[gateway,200]]) {
      let hooks=0;const f=fixture(()=>new Response(body,{status}));f.client.applyCsrf('');
      f.client.reloginHook=async()=>{hooks++;return false;};
      await assert.rejects(f.client[method](['example']),e=>!(e instanceof AuthRequiredError));assert.equal(hooks,0);
    }
  });
}
await test('a read answers 401 or 403 with one learning recovery; other statuses stay service failures',async()=>{
  // 403 与 401 同处理：2026-10-30 实录里学习域会话过期后同一读接口连续回 403，重建后
  // 立即 200；而真实「无权限」的形态是 200 + 可见文案的壳页（classifyLearnPage 的
  // learn-denied），不是 403。取凭据页（启动探活）不在此列，见 learn-recovery-probe-test。
  for(const status of [401,403]) {
    let hooks=0;const f=fixture(()=>new Response('Denied',{status}));
    f.client.reloginHook=async()=>{hooks++;return false;};
    await assert.rejects(f.client.getCourseList('example'),AuthRequiredError);
    assert.equal(hooks,1,`${status} 走一次学习域重建，重建失败才把会话错误交上去`);
  }
  for(const status of [429,503]) {
    let hooks=0;const f=fixture(()=>new Response('Busy',{status}));
    f.client.reloginHook=async()=>{hooks++;return false;};
    await assert.rejects(f.client.getCourseList('example'),e=>!(e instanceof AuthRequiredError));
    assert.equal(hooks,0,`${status} 是服务错误，不重登`);
  }
});
await test('learning recovery never starts a simultaneous global watchdog login',async()=>{
  let globalCalls=0,localCalls=0;const stop=onAuthRequired(()=>globalCalls++);
  try {
    const f=fixture(()=>login);f.client.reloginHook=async()=>{localCalls++;return false;};
    await assert.rejects(f.client.getCourseList('example'),AuthRequiredError);
    assert.equal(localCalls,1);assert.equal(globalCalls,0);
  } finally { stop(); }
});
await test('notification login shell is recovered before attachment parsing',async()=>{
  let alive=false,hooks=0;
  const f=fixture(url=>url.includes('/f/wlxt/index/course/student/')?page:alive?notice:login);
  f.client.reloginHook=async()=>{alive=true;hooks++;return true;};
  assert.equal((await f.client.getNotificationPageDetail('example','example')).attachment.id,'fixture-file');assert.equal(hooks,1);
});
await test('diagnostics keep structure without response content or credentials',async()=>{
  const secret='PRIVATE_FIXTURE_CANARY';const f=fixture(()=>'<html><title>HTTP Status 500</title>'+secret+'</html>');
  await assert.rejects(f.client.getCourseList(secret));
  assert.ok(!JSON.stringify([f.logs,f.client.lastDebug,f.client.lastResponseDebug]).includes(secret));
});
console.log(`Learning response recovery: ${count} behavioral cases passed; no live network.`);
