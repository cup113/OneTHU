import { client, originalUrl, directUrl, resourceUrl } from './client.js';
import { esc as e, loading, empty, error, btn, nativeFrameCss } from './ui.js';
import { details } from './details.js';
import { parseLearnTime } from '../../../packages/core/src/learn/time.js';
import type { CourseInfo, Homework, Notification, CourseFile } from '../../../packages/core/src/learn/types.js';
import css from './style.css';

type View='dashboard'|'courses'|'homework'|'notices'|'files'|'native';
type Data<T>={state:'loading'|'ready'|'error';rows:T[];failed:string[]};
const fresh=<T>():Data<T>=>({state:'loading',rows:[],failed:[]});
const labels:Record<View,string>={dashboard:'学习首页',courses:'全部课程',homework:'作业',notices:'通知',files:'文件',native:'课程服务'};
const state={view:'dashboard' as View,cid:'',query:'',filter:'all',semester:'',semesters:[] as string[],courses:[] as CourseInfo[],homework:fresh<Homework>(),notices:fresh<Notification>(),files:fresh<CourseFile>(),generation:0,native:'',ignored:new Set<string>(),pinned:new Set<string>()};
const params=new URL(location.href).searchParams;
if(window.top!==window){const style=document.createElement('style');style.textContent=nativeFrameCss();document.documentElement.append(style);}
else if(params.get('ntl')==='original'){const a=document.createElement('a');a.href='/f/wlxt/index/course/student/';a.textContent='返回 NextTHULearn';a.style.cssText='position:fixed;bottom:20px;right:20px;z-index:2147483647;background:#212120;color:#fff;border-radius:10px;padding:10px 16px;text-decoration:none;font:600 13px sans-serif';document.documentElement.append(a);}
else if(/^\/f\/(wlxt|xt)\//.test(location.pathname)) void start();

async function start(){
  if(document.getElementById('nextthulearn-root'))return;
  const host=document.createElement('div');host.id='nextthulearn-root';host.style.cssText='position:fixed;inset:0;z-index:2147483646';document.documentElement.append(host);if(document.body)document.body.inert=true;
  const root=host.attachShadow({mode:'open'});
  root.innerHTML=`<style>${css}</style><div class="app"><aside class="sidebar"><div class="brand"><span class="logo">(One<span>THU</span>)</span><div><strong>NextTHULearn</strong><small>网络学堂 · 学习工作台</small></div></div><div class="nav-label">学习</div><nav class="nav">${(['dashboard','courses','homework','notices','files'] as View[]).map((v,i)=>`<button class="nav-item" data-view="${v}" aria-label="${labels[v]}"><span class="nav-icon">${['⌂','▦','✓','◉','▤'][i]}</span><span class="nav-text">${labels[v]}</span><span class="nav-count" id="count-${v}"></span></button>`).join('')}</nav><div class="sidebar-bottom"><button data-action="school-services">学堂服务</button><button data-action="toggle-theme" id="theme">深色外观</button><a href="${e(originalUrl(location.href))}">原版网站 ↗</a><small>OneTHU · NextTHULearn 0.2</small></div></aside><main class="main"><header class="top"><div class="breadcrumb">学习 <span>/</span><b id="crumb">学习首页</b></div><div class="top-actions"><select id="semester" aria-label="选择学期" disabled><option>读取学期…</option></select><button id="refresh" class="icon-btn" aria-label="刷新" title="刷新">↻</button><a class="original" href="${e(originalUrl(location.href))}">原版网站 ↗</a></div></header><div class="content"><div id="body">${loading('正在连接网络学堂…')}</div></div></main></div><div class="detail-mask" id="detail-mask" hidden><section class="detail-dialog" role="dialog" aria-modal="true" aria-labelledby="detail-title"><header><h2 id="detail-title"></h2><button data-action="close-detail" aria-label="关闭详情">✕</button></header><div class="detail-body" id="detail-body"></div></section></div><div class="toast" id="toast" role="status" hidden></div>`;
  const $=<T extends HTMLElement=HTMLElement>(s:string)=>root.querySelector(s) as T;
  const body=$('#body');const app=$('.app');let detailToken=0,focusBefore:HTMLElement|null=null;
  let busy=false;let ready=false;let pendingRoute=true;let nativeLoaded=false;
  let draftTouched=false;
  const savedTheme=localStorage.getItem('nextthulearn:theme');if(savedTheme==='dark')host.dataset.theme='dark';
  function toast(t:string){$('#toast').textContent=t;$('#toast').hidden=false;setTimeout(()=>{$('#toast').hidden=true;},4000);}
  function open(title:string,html:string){if($('#detail-mask').hidden)focusBefore=root.activeElement as HTMLElement;detailToken++;$('#detail-title').textContent=title;$('#detail-body').innerHTML=html;$('#detail-mask').hidden=false;app.inert=true;$('#detail-mask button').focus();draftTouched=false;return detailToken;}
  const detail=details({root,open,update:(token,html)=>{if(token===detailToken&&!$('#detail-mask').hidden)$('#detail-body').innerHTML=html;},refresh:()=>loadCourses(),toast});
  function close(){if(draftTouched&&!confirm('有尚未提交的内容，确认关闭详情？'))return;detailToken++;detail.invalidate();$('#detail-mask').hidden=true;app.inert=false;focusBefore?.focus();draftTouched=false;}
  root.addEventListener('input',ev=>{if((ev.target as Element).closest('.editor-form'))draftTouched=true;});
  root.addEventListener('click',ev=>{const action=(ev.target as Element).closest<HTMLElement>('[data-action]')?.dataset.action;if(draftTouched&&['back-forum','new-thread','thread'].includes(action||'')&&!confirm('有尚未提交的内容，确认离开？')){ev.preventDefault();ev.stopImmediatePropagation();}},true);
  root.addEventListener('keydown',event=>{const ev=event as KeyboardEvent;if($('#detail-mask').hidden)return;if(ev.key==='Escape'){ev.preventDefault();close();}if(ev.key==='Tab'){const els=Array.from($('#detail-mask').querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input,select,textarea')).filter(el=>!el.hidden);const first=els[0],last=els.at(-1);if(ev.shiftKey&&root.activeElement===first){ev.preventDefault();last?.focus();}else if(!ev.shiftKey&&root.activeElement===last){ev.preventDefault();first?.focus();}}});
  window.addEventListener('beforeunload',ev=>{if(draftTouched){ev.preventDefault();ev.returnValue='';}});
  const name=(id:string)=>state.courses.find(c=>c.id===id)?.name||'课程';
  const course=()=>state.courses.find(c=>c.id===state.cid);
  function route(view:View,cid='',filter='all'){
    state.view=view;state.cid=cid;state.filter=filter;state.query='';nativeLoaded=false;
    const hash=new URLSearchParams({view,...(cid?{course:cid}:{}),...(filter!=='all'?{filter}:{}),...(view==='native'?{native:state.native}:{})});history.replaceState(null,'','#'+hash);render();$('.content').scrollTop=0;
  }
  function initialRoute(){
    const hash=new URLSearchParams(location.hash.slice(1));const v=hash.get('view');
    if(v&&v in labels){state.view=v as View;state.cid=hash.get('course')||'';state.filter=hash.get('filter')||'all';if(v==='native'){try{state.native=directUrl(hash.get('native')||'/f/wlxt/index/course/student/');}catch{state.native='/f/wlxt/index/course/student/';}}return;}
    const cid=params.get('wlkcid')||'';state.cid=cid;
    if(location.pathname.includes('/kczy/'))state.view='homework';else if(location.pathname.includes('/kcgg/'))state.view='notices';else if(location.pathname.includes('/kj/'))state.view='files';else if(cid)state.view='courses';
    if(!/\/index\/course\/student\/?(?:index|course)?$/.test(location.pathname)&&!['homework','notices','files'].includes(state.view)){state.view='native';state.native=location.href;}
  }
  const heading=(title:string,desc:string,extra='')=>`<div class="page-head"><div><div class="eyebrow">OneTHU · 学习</div><h1>${e(title)}</h1><p>${e(desc)}</p></div>${extra}</div>`;
  const count=(d:Data<unknown>)=>d.state==='loading'?'…':`${d.rows.length}${d.failed.length?'+':''}`;
  const status=(d:Data<unknown>)=>d.failed.length?error(`${d.failed.length} 门课程读取失败，已显示成功读取的内容。请刷新重试。`):d.state==='loading'?loading():'';
  const byCid=<T extends {courseId:string}>(rows:T[])=>rows.filter(x=>!state.cid||x.courseId===state.cid);
  const matches=(...x:unknown[])=>!state.query||x.some(s=>String(s??'').toLowerCase().includes(state.query.toLowerCase()));
  const time=(x:string)=>parseLearnTime(x)?.getTime()??Infinity;
  const pending=(h:Homework)=>!h.submitted&&!state.ignored.has(h.id);
  const overdue=(h:Homework)=>pending(h)&&time(h.deadline)<Date.now();
  const currentRows=()=>byCid(state.homework.rows);
  function toolbar(ph:string,filters:Array<[string,string]>=[]){return `<div class="toolbar"><div class="search"><span>⌕</span><input id="search" aria-label="${ph}" placeholder="${ph}" value="${e(state.query)}"></div>${filters.length?`<div class="segments">${filters.map(([k,v])=>`<button data-filter="${k}" class="${state.filter===k?'selected':''}">${v}</button>`).join('')}</div>`:''}</div>`;}
  function courseTabs(){if(!state.cid)return '';return `<div class="course-heading">${btn('all-courses','← 全部课程','class="back"')}<h2>${e(name(state.cid))}</h2><p>${e(course()?.teacherName||'')} · ${e(course()?.timeAndLocation.join('；')||'')}</p></div><div class="course-tabs">${(['overview','homework','notices','files','forum','groups','info','questions','questionnaires','mail','online','favorites','notes'] as const).map((k,i)=>`<button data-course-tab="${k}" class="${(k==='overview'&&state.view==='courses')||k===state.view?'selected':''}">${['概览','作业','通知','文件','讨论','分组','课程信息','答疑','问卷','邮件','在线课堂','收藏','备注'][i]}</button>`).join('')}</div>`;}
  function homeworkRow(h:Homework,compact=false){return `<button class="row ${compact?'compact':''}" data-open="homework" data-id="${e(h.id)}"><span class="row-icon ${h.graded?'done':h.submitted?'submitted':overdue(h)?'urgent':''}">${h.graded?'✓':h.submitted?'↗':'▢'}</span><span class="row-main"><strong>${e(h.title)}</strong><span>${e(name(h.courseId))}${compact?'':' · '+e(h.deadline||'截止时间未提供')}</span>${compact?`<small>${e(h.deadline||'截止时间未提供')}</small>`:''}</span><span class="badge ${h.graded?'done':h.submitted?'submitted':overdue(h)?'urgent':''}">${h.graded?'已批改':h.submitted?'已提交':overdue(h)?'已逾期':'未提交'}</span></button>`;}
  function noticeRow(n:Notification,compact=false){return `<button class="row ${compact?'compact':''}" data-open="notices" data-id="${e(n.id)}"><span class="row-icon">◉</span><span class="row-main"><strong>${e(n.title)}</strong><span>${e(name(n.courseId))} · ${e(n.publishTime)}</span></span>${n.important?'<span class="badge urgent">重要</span>':!n.hasRead?'<span class="badge submitted">未读</span>':''}</button>`;}
  function fileRow(f:CourseFile,compact=false){return `<button class="row ${compact?'compact':''}" data-open="files" data-id="${e(f.id)}" data-cid="${e(f.courseId)}"><span class="row-icon">▤</span><span class="row-main"><strong>${e(f.title)}</strong><span>${e(name(f.courseId))} · ${e(f.uploadTime)}</span></span><span class="badge">${e(f.fileType||'文件')}</span></button>`;}
  function metric(v:View,label:string,value:string,sub:string){return `<button class="metric" data-section="${v}" data-summary-filter="${v==='notices'?'unread':v==='homework'?'pending':'all'}"><span>${label}</span><b>${value}</b><small>${sub} <i>↗</i></small></button>`;}
  function schoolCount(key:'unreadNotices'|'unreadFiles'|'pendingHomework'){const rows=state.cid?state.courses.filter(c=>c.id===state.cid):state.courses;const nums=rows.map(c=>c.summary?.[key]);return nums.every(x=>x!==undefined)?String(nums.reduce((a,b)=>a!+b!,0)):'—';}
  function overview(){
    const hw=byCid(state.homework.rows).filter(pending).sort((a,b)=>time(a.deadline)-time(b.deadline));
    const notices=byCid(state.notices.rows).slice().sort((a,b)=>time(b.publishTime)-time(a.publishTime));
    const files=byCid(state.files.rows).slice().sort((a,b)=>time(b.uploadTime)-time(a.uploadTime));
    return `<div class="metrics">${metric('notices','未浏览通知',schoolCount('unreadNotices'),'查看未读通知')}${metric('homework','未提交作业',schoolCount('pendingHomework'),'查看未提交作业')}${metric('files','未浏览文件',schoolCount('unreadFiles'),'查看课程文件')}</div><div class="overview-columns"><section class="panel"><div class="section-line"><h2>待办作业</h2><button data-section="homework">全部 ${count(state.homework)} ›</button></div>${status(state.homework)}${hw.slice(0,6).map(h=>homeworkRow(h,true)).join('')|| (state.homework.state!=='loading'?empty('暂无待办作业'):'')}</section><section class="panel"><div class="section-line"><h2>课程通知</h2><button data-section="notices">全部 ${count(state.notices)} ›</button></div>${status(state.notices)}${notices.slice(0,6).map(n=>noticeRow(n,true)).join('')||(state.notices.state!=='loading'?empty('暂无通知'):'')}</section><section class="panel"><div class="section-line"><h2>最新文件</h2><button data-section="files">全部 ${count(state.files)} ›</button></div>${status(state.files)}${files.slice(0,6).map(f=>fileRow(f,true)).join('')||(state.files.state!=='loading'?empty('暂无文件'):'')}</section></div>`;
  }
  function courses(){const rows=state.courses.filter(c=>matches(c.name,c.englishName,c.teacherName,c.courseNumber)).sort((a,b)=>Number(state.pinned.has(b.id))-Number(state.pinned.has(a.id)));return `<div class="course-grid">${rows.map(c=>`<article class="course-card"><div class="course-top"><span>${e(c.courseNumber)}–${c.courseIndex}</span><button data-pin="${e(c.id)}" title="${state.pinned.has(c.id)?'取消置顶':'置顶课程'}">${state.pinned.has(c.id)?'★':'☆'}</button></div><button class="course-title" data-section="courses" data-cid="${e(c.id)}">${e(c.name||c.englishName)} <span>›</span></button><p>${e(c.teacherName)}</p><p class="schedule-text">${e(c.timeAndLocation.join('；')||'未提供上课时间地点')}</p><div class="course-stats">${(['notices','homework','files'] as View[]).map((v,i)=>`<button data-section="${v}" data-cid="${e(c.id)}"><b>${c.summary?.[(['unreadNotices','pendingHomework','unreadFiles'] as const)[i]]??'—'}</b><span>${['通知未读','作业未交','文件未读'][i]}</span></button>`).join('')}</div><div class="course-actions"><button data-section="courses" data-cid="${e(c.id)}">进入课程</button><button data-action="forum" data-cid="${e(c.id)}">讨论</button><button data-action="groups" data-cid="${e(c.id)}">分组</button></div></article>`).join('')||empty('没有找到课程')}</div>`;}
  function render(){
    if(!ready)return;
    root.querySelectorAll('[data-view]').forEach(el=>el.classList.toggle('active',(el as HTMLElement).dataset.view===state.view));$('#crumb').textContent=state.cid?name(state.cid)+' / '+labels[state.view]:labels[state.view];
    $('#count-homework').textContent=state.homework.state==='loading'?'…':String(state.homework.rows.filter(pending).length)+(state.homework.failed.length?'+':'');$('#count-notices').textContent=count(state.notices);$('#count-files').textContent=count(state.files);
    if(state.view==='native'&&nativeLoaded)return;
    const prefix=courseTabs();let html='';
    if(state.view==='dashboard'){html=heading('学习首页',`${state.semester} · ${state.courses.length} 门课程`)+overview()+`<div class="section-line section-gap"><h2>我的课程</h2><button data-section="courses">查看全部 ›</button></div>`+courses();}
    else if(state.view==='courses'){html=state.cid?prefix+overview():heading('全部课程',`${state.semester} · ${state.courses.length} 门课程`)+toolbar('搜索课程、教师或课程号')+courses();}
    else if(state.view==='homework'){
      const data=state.homework;const rows=currentRows().filter(h=>matches(h.title,name(h.courseId))).filter(h=>state.filter==='ignored'?state.ignored.has(h.id):!state.ignored.has(h.id)).filter(h=>state.filter==='pending'?pending(h):state.filter==='new'?pending(h)&&!overdue(h):state.filter==='overdue'?overdue(h):state.filter==='submitted'?h.submitted&&!h.graded:state.filter==='graded'?h.graded:true).sort((a,b)=>time(a.deadline)-time(b.deadline));
      html=prefix+heading(state.cid?'课程作业':'全部作业','正文、附件、提交和批改结果都在这里。',btn('export-calendar','导出截止日历','class="button-link"'))+toolbar('搜索作业或课程',[['all','全部'],['pending','未提交'],['new','进行中'],['overdue','已逾期'],['submitted','已提交'],['graded','已批改'],['ignored','已忽略']])+status(data)+`<div class="list">${rows.map(h=>`<div class="homework-list-row">${homeworkRow(h)}<button class="ignore-btn" data-ignore="${e(h.id)}" title="${state.ignored.has(h.id)?'恢复':'忽略'}作业">${state.ignored.has(h.id)?'恢复':'忽略'}</button></div>`).join('')||(data.state!=='loading'?empty('没有匹配的作业'):'')}</div>`;
    }else if(state.view==='notices'){const d=state.notices;const rows=byCid(d.rows).filter(n=>matches(n.title,name(n.courseId))).filter(n=>state.filter==='unread'?!n.hasRead:state.filter==='important'?n.important:true).sort((a,b)=>time(b.publishTime)-time(a.publishTime));html=prefix+heading('课程通知','阅读通知正文和附件。')+toolbar('搜索通知或课程',[['all','全部'],['unread','未读'],['important','重要']])+status(d)+`<div class="list">${rows.map(n=>noticeRow(n)).join('')||(d.state!=='loading'?empty('没有匹配的通知'):'')}</div>`;}
    else if(state.view==='files'){const d=state.files;const rows=byCid(d.rows).filter(f=>matches(f.title,f.description,name(f.courseId))).filter(f=>state.filter==='pdf'?f.fileType?.toLowerCase()==='pdf':state.filter==='slides'?/^(ppt|pptx)$/i.test(f.fileType||''):true).sort((a,b)=>time(b.uploadTime)-time(a.uploadTime));html=prefix+heading('课程文件','预览、下载并查找课程资料。')+toolbar('搜索文件或课程',[['all','全部'],['pdf','PDF'],['slides','演示文稿']])+status(d)+`<div class="list">${rows.map(f=>fileRow(f)).join('')||(d.state!=='loading'?empty('没有匹配的文件'):'')}</div>`;}
    else if(state.view==='native'){html=prefix+`<div class="native-toolbar"><span>课程页面</span><a href="${e(originalUrl(state.native))}" target="_blank" rel="noopener">在独立窗口打开 ↗</a></div><iframe class="native-frame" id="native-frame" title="课程服务" src="${e(embedded(state.native))}"></iframe>`;nativeLoaded=true;}
    const focused=root.activeElement as HTMLInputElement;const searchFocused=focused?.id==='search';const pos=searchFocused?focused.selectionStart:null;
    body.innerHTML=html;
    if(searchFocused){const next=$<HTMLInputElement>('#search');next?.focus();if(pos!==null)next?.setSelectionRange(pos,pos);}
  }
  function embedded(raw:string){const u=new URL(directUrl(raw));u.searchParams.set('ntl','embedded');return u.href;}
  const servicePaths:Record<string,string>={info:'/f/wlxt/kc/v_kcxx_jskcxx/student/beforeXskcxx',questions:'/f/wlxt/bbs/bbs_kcdy/student/beforePageDyList',questionnaires:'/f/wlxt/kcwj/wlkc_wjb/student/beforePageList_wks',mail:'/f/wlxt/mail/yj_yjxxb/student/beforePageList',online:'/f/wlxt/zxkt/wlkc_zxktb/student/beforePageList',favorites:'/f/xt/wlkc_xsscb/student/mysc',notes:'/f/wlxt/xt/wlkc_xsbjb/student/mybz'};
  function service(kind:string){if(!state.cid)return;if(kind==='forum')void detail.threads(state.cid);else if(kind==='groups')void detail.groups(state.cid);else if(servicePaths[kind]){state.native=servicePaths[kind]+'?wlkcid='+encodeURIComponent(state.cid);route('native',state.cid);}}
  async function collect<T>(fn:(id:string)=>Promise<T[]>,gen:number,apply:(d:Data<T>)=>void){const rows:T[]=[];const failed:string[]=[];const ids=state.courses.map(c=>c.id);let cursor=0;async function worker(){while(cursor<ids.length&&gen===state.generation){const cid=ids[cursor++]!;try{rows.push(...await fn(cid));}catch{failed.push(cid);}}}await Promise.all(Array.from({length:Math.min(3,ids.length)},worker));if(gen!==state.generation)return;apply({state:failed.length?'error':'ready',rows,failed});render();}
  async function loadCourses(){const gen=++state.generation;state.homework=fresh();state.notices=fresh();state.files=fresh();nativeLoaded=false;try{const cs=await client.getCourseList(state.semester);if(gen!==state.generation)return;state.courses=cs;ready=true;render();await Promise.all([collect(id=>client.getAllHomework([id]),gen,d=>state.homework=d),collect(id=>client.getNotificationList(id),gen,d=>state.notices=d),collect(id=>client.getFileList(id),gen,d=>state.files=d)]);if(pendingRoute){pendingRoute=false;await deepDetail();}}catch{if(gen===state.generation)body.innerHTML=error('课程读取失败，请刷新重试。');}}
  async function deepDetail(){const cid=params.get('wlkcid'),hw=params.get('xszyid'),nid=params.get('id');if(hw&&cid){const h=state.homework.rows.find(h=>h.id===hw&&h.courseId===cid);if(h)void detail.hw(h);}else if(location.pathname.includes('beforeViewXs')&&nid){const n=state.notices.rows.find(n=>n.id===nid);if(n)void detail.notice(n);}}
  async function load(){if(busy)return;busy=true;$('#refresh').setAttribute('disabled','');body.innerHTML=loading('正在连接网络学堂…');try{if(!await client.resume())throw 0;const [current,semesters]=await Promise.all([client.getCurrentSemester(),client.getSemesterIdList()]);state.semesters=Array.from(new Set([current.id,...semesters]));state.semester=state.semester||current.id;const select=$<HTMLSelectElement>('#semester');select.innerHTML=state.semesters.map(s=>`<option value="${e(s)}" ${s===state.semester?'selected':''}>${e(s)}</option>`).join('');select.disabled=false;await loadCourses();}catch{body.innerHTML=error('登录状态失效或网络不可用，请先在原网站登录。')+`<a class="action" href="${e(originalUrl(location.href))}">打开原版网站</a>`;}finally{busy=false;$('#refresh').removeAttribute('disabled');}}
  function exportCalendar(){const hw=byCid(state.homework.rows).filter(pending);const format=(d:Date)=>d.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//OneTHU//NextTHULearn//ZH'];for(const h of hw){const deadline=parseLearnTime(h.deadline);if(!deadline)continue;lines.push('BEGIN:VEVENT','UID:'+h.id+'@nextthulearn','DTSTAMP:'+format(new Date()),'DTSTART:'+format(deadline),'SUMMARY:'+h.title.replace(/[\r\n]/g,' ').replace(/[,;\\]/g,'\\$&'),'DESCRIPTION:'+name(h.courseId).replace(/[\r\n]/g,' ').replace(/[,;\\]/g,'\\$&'),'END:VEVENT');}lines.push('END:VCALENDAR');const u=URL.createObjectURL(new Blob([lines.join('\r\n')],{type:'text/calendar;charset=utf-8'}));const a=document.createElement('a');a.href=u;a.download='网络学堂作业截止.ics';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
  root.addEventListener('input',ev=>{const el=ev.target as HTMLInputElement;if(el.id==='search'){state.query=el.value;render();}});
  root.addEventListener('change',ev=>{const el=ev.target as HTMLSelectElement;if(el.id==='semester'){state.semester=el.value;state.cid='';state.view='dashboard';pendingRoute=false;void loadCourses();}});
  root.addEventListener('click',ev=>{const el=(ev.target as Element).closest('button,[data-open]') as HTMLElement|null;if(!el)return;
    if(el.dataset.view)route(el.dataset.view as View);
    if(el.dataset.section)route(el.dataset.section as View,el.dataset.cid??state.cid,el.dataset.summaryFilter||'all');
    if(el.dataset.filter){state.filter=el.dataset.filter;render();}
    if(el.dataset.pin){state.pinned.has(el.dataset.pin)?state.pinned.delete(el.dataset.pin):state.pinned.add(el.dataset.pin);render();}
    if(el.dataset.ignore){state.ignored.has(el.dataset.ignore)?state.ignored.delete(el.dataset.ignore):state.ignored.add(el.dataset.ignore);render();}
    if(el.dataset.open==='homework'){const h=state.homework.rows.find(h=>h.id===el.dataset.id);if(h)void detail.hw(h);}
    if(el.dataset.open==='notices'){const n=state.notices.rows.find(n=>n.id===el.dataset.id);if(n)void detail.notice(n);}
    if(el.dataset.open==='files'){const f=state.files.rows.find(f=>f.id===el.dataset.id&&f.courseId===el.dataset.cid);if(f)detail.file(f);}
    if(el.dataset.courseTab){const k=el.dataset.courseTab;if(k==='overview')route('courses',state.cid);else if(['homework','notices','files'].includes(k))route(k as View,state.cid);else service(k);}
    if(el.dataset.action==='school-services'){state.native='/f/wlxt/index/course/student/?ntl=embedded';route('native');}
    if(el.dataset.action==='all-courses')route('courses');
    if(el.dataset.action==='forum'&&el.dataset.cid)void detail.threads(el.dataset.cid);
    if(el.dataset.action==='groups'&&el.dataset.cid)void detail.groups(el.dataset.cid);
    if(el.dataset.action==='close-detail')close();
    if(el.dataset.action==='toggle-theme'){host.dataset.theme=host.dataset.theme==='dark'?'light':'dark';localStorage.setItem('nextthulearn:theme',host.dataset.theme);}
    if(el.dataset.action==='export-calendar')exportCalendar();
    if(el.id==='refresh')void load();
  });
  initialRoute();await load();
}
