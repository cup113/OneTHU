/**
 * 日程 · 悬浮圆钮验收（可拖动 + 弹层单滚动 + 手机 Sheet）
 *
 * 覆盖三件事：
 *  1) 圆钮可拖动、位置记忆（onethu.schedule.dock-pos.v1），拖完的那次 click 不误开面板，
 *     3px 抖动仍是点击（协议与 hard-refresh-browser-test 的浮钮一致）；
 *  2) 设置浮层单滚动契约：整个浮层子树里至多一个可滚动元素（桌面=外壳 .og-float；
 *     修复前外壳与 .schedule-panel 各滚各的，手机上要滚两层才见得到「添加日程」）；
 *     「＋ 添加日程」在面板首行，不滚动即可见；
 *  3) 手机形态面板走底部 Sheet（.og-sheet--bottom），唯一滚动容器是 .og-panel-body。
 *
 * 数据：route 拦截 Vite 客户端模块注入课程夹具（同 schedule-timeline-browser-test）。
 * 跑法：ONETHU_TEST_URL=http://127.0.0.1:5180 CHROME_BIN=<chrome> node tools/schedule-dock-browser-test.mjs
 */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
const base=process.env.ONETHU_TEST_URL??'http://127.0.0.1:5180';
const out=process.env.ONETHU_TEST_ARTIFACTS??'artifacts/schedule-dock-review';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
let checks=0;const errors=[];const check=(c,m)=>{assert.ok(c,m);checks++;console.log('✓ '+m);};
const KEY='onethu.schedule.dock-pos.v1';
const fixture={semester:{id:'x'},courses:[],homework:[],notifications:[],files:[],schedule:[
  {courseName:'数据结构',dayOfWeek:1,startTime:'10:00',endTime:'11:30',location:'六教 6A205',teacher:'张老师'},
  {courseName:'计算机网络',dayOfWeek:3,startTime:'14:00',endTime:'15:30',location:'三教 3200',teacher:'王老师'},
]};
const setup=async p=>{
  p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.message));
  await p.addInitScript(()=>{performance.setResourceTimingBufferSize(10000);localStorage.setItem('onethu.onboarded.phone','1')});
  await p.route('**/src/state/data.ts*',async r=>{const res=await r.fetch();let b=await res.text();
    for(const n of ['useLearnData','useCampusData'])b=b.replace(`export function ${n}() {`,`export function ${n}() {return {data:${JSON.stringify(fixture)},state:'ready',error:null,reload:async()=>{}};`);
    await r.fulfill({response:res,body:b});});
};
const go=async p=>{await p.goto(base+'/?explorer-preview=page&page=schedule',{waitUntil:'domcontentloaded'});await p.waitForSelector('.explorer-shell');await p.waitForTimeout(1600);};
/** 浮层子树里「真的会滚」的元素（scrollHeight 超出 + overflow 允许滚；含根节点本身）——单滚动契约：至多 1 个 */
const scrollables=async (p,rootSel)=>p.evaluate(sel=>{
  const root=document.querySelector(sel);if(!root)return null;
  return [root,...root.querySelectorAll('*')].filter(el=>{
    const s=getComputedStyle(el);
    return (s.overflowY==='auto'||s.overflowY==='scroll')&&el.scrollHeight>el.clientHeight+1;
  }).map(el=>el.className);
},rootSel);
/** 「＋ 添加日程」是否在面板首行（不滚动即可见） */
const addEventFirstRow=async (p,rootSel)=>p.evaluate(sel=>{
  const root=document.querySelector(sel);if(!root)return false;
  const add=[...root.querySelectorAll('button')].find(b=>(b.textContent??'').includes('添加日程'));
  const first=root.querySelector(':scope > .schedule-panel-row, :scope > *:first-child');
  return !!add&&!!first&&first.contains(add);
},rootSel);
const dockBox=p=>p.locator('.schedule-dock').boundingBox();
/** 鼠标拖动（桌面）；触摸拖动走 CDP（手机） */
const dragDock=async(p,dx,dy)=>{
  const r=await dockBox(p);assert.ok(r,'dock exists');
  const from={x:r.x+r.width/2,y:r.y+r.height/2},to={x:from.x+dx,y:from.y+dy};
  if(p.viewportSize().width<600){
    const cdp=await p.context().newCDPSession(p);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[from]});
    for(let i=1;i<=6;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:from.x+(to.x-from.x)*i/6,y:from.y+(to.y-from.y)*i/6}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();
  }else{await p.mouse.move(from.x,from.y);await p.mouse.down();await p.mouse.move(to.x,to.y,{steps:6});await p.mouse.up();}
  return r;
};
try{
  /* ════ 桌面 1280：单滚动 + 添加日程置顶 + 拖动/记忆/吞 click ════ */
  {
    const p=await browser.newPage({viewport:{width:1280,height:860}});await setup(p);await go(p);
    await p.locator('.schedule-dock').waitFor();
    // 1. 点击圆钮 → 锚定 Popover 打开；「＋ 添加日程」在首行
    await p.locator('.schedule-dock button').first().click();await p.waitForTimeout(600);
    const pop=p.locator('.og-schedule-pop');await pop.waitFor();
    await p.locator('.og-schedule-pop .schedule-panel').waitFor();
    check(await p.locator('.og-popover').count()===1,'desktop: settings open as anchored popover');
    check(await addEventFirstRow(p,'.og-schedule-pop .schedule-panel'),'desktop: add-event sits in the first panel row');
    // 2. 单滚动契约：面板自身不滚（overflowY 可见、无 max-height），子树里至多一个滚动元素
    const styles=await p.evaluate(()=>{
      const pn=document.querySelector('.og-schedule-pop .schedule-panel');
      if(!pn)return null;const s=getComputedStyle(pn);return{ov:s.overflowY,mh:s.maxHeight};
    });
    check(!!styles&&styles.ov==='visible','desktop: panel itself never scrolls (shell is the only scroller)');
    check(!!styles&&(styles.mh==='none'||styles.mh===''),'desktop: panel carries no own max-height');
    check(await (async()=>{const list=await scrollables(p,'.og-schedule-pop');return Array.isArray(list)&&list.length<=1;})(),'desktop: at most one scrollable element in the popover subtree');
    // 3. 展开日历快跳后内容变高，契约仍然成立，添加日程仍可见
    await p.locator('.og-schedule-pop .schedule-panel-label').click();await p.waitForTimeout(400);
    check(await p.locator('.schedule-cal').isVisible(),'desktop: calendar quick-jump expands inside the panel');
    check(await (async()=>{const list=await scrollables(p,'.og-schedule-pop');return Array.isArray(list)&&list.length<=1;})(),'desktop: still one scrollable with calendar open');
    const addBox=await p.locator('.og-schedule-pop .schedule-panel').getByRole('button',{name:'＋ 添加日程',exact:true}).boundingBox();
    const shellBox=await pop.boundingBox();
    check(!!addBox&&!!shellBox&&addBox.y>=shellBox.y-1&&addBox.y+addBox.height<=shellBox.y+shellBox.height+1,'desktop: add-event visible without scrolling');
    await p.screenshot({path:out+'/desktop-panel.png'});
    await p.keyboard.press('Escape');await p.locator('.og-schedule-pop').waitFor({state:'hidden'});
    check(await p.evaluate(()=>localStorage.getItem(KEY))===null,'desktop: no dock position stored before any drag');
    // 4. 3px 抖动 = 点击（面板开合照常），且不写位置
    const before=await dockBox(p);
    await p.mouse.move(before.x+before.width/2,before.y+before.height/2);await p.mouse.down();
    await p.mouse.move(before.x+before.width/2+3,before.y+before.height/2+3);await p.mouse.up();
    await p.locator('.og-schedule-pop').waitFor();await p.waitForTimeout(200);
    check(true,'desktop: 3px jitter still toggles the panel (click passes)');
    check(await p.evaluate(()=>localStorage.getItem(KEY))===null,'desktop: jitter writes no dock position');
    await p.keyboard.press('Escape');await p.locator('.og-schedule-pop').waitFor({state:'hidden'});
    // 5. 面板开着时拖走圆钮：面板收起，松手的 click 被吞掉不再弹开
    await p.locator('.schedule-dock button').first().click();await p.locator('.og-schedule-pop').waitFor();
    const r0=await dragDock(p,-120,-180);await p.waitForTimeout(350);
    check(await p.locator('.og-schedule-pop').count()===0,'desktop: dragging the dock leaves the panel closed (trailing click swallowed)');
    const r1=await dockBox(p);
    check(!!r1&&Math.abs((r0.x-r1.x)-120)<6&&Math.abs((r0.y-r1.y)-180)<6,'desktop: dock follows the pointer');
    const stored=await p.evaluate(()=>JSON.parse(localStorage.getItem(KEY)??'null'));
    check(!!stored&&Number.isFinite(stored.right)&&Number.isFinite(stored.bottom)&&stored.right>0&&stored.bottom>0,'desktop: dock position persisted');
    // 6. 刷新后位置保持，且圆钮完整落在事件区内
    await p.reload();await p.waitForSelector('.explorer-shell');await p.waitForTimeout(1600);
    const r2=await dockBox(p);
    check(!!r2&&Math.abs(r2.x-r1.x)<2&&Math.abs(r2.y-r1.y)<2,'desktop: dock position survives reload');
    const inside=await p.evaluate(()=>{const d=document.querySelector('.schedule-dock')?.getBoundingClientRect();const s=document.querySelector('.schedule-stage')?.getBoundingClientRect();return !!d&&!!s&&d.left>=s.left-1&&d.right<=s.right+1&&d.top>=s.top-1&&d.bottom<=s.bottom+1;});
    check(inside,'desktop: dragged dock stays inside the stage');
    // 7. 拖动之后点击仍然开面板（skipClick 只吞一次）
    await p.locator('.schedule-dock button').first().click();await p.locator('.og-schedule-pop').waitFor();
    check(await p.locator('.og-schedule-pop .schedule-panel').isVisible(),'desktop: click still opens the panel after a drag');
    await p.keyboard.press('Escape');
    await p.close();
  }
  /* ════ 手机 390：底部 Sheet + 单滚动 + 触摸拖动 ════ */
  {
    const p=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});await setup(p);await go(p);
    await p.locator('.schedule-dock').waitFor();
    await p.locator('.schedule-dock button').first().tap();await p.waitForTimeout(600);
    const sheet=p.locator('.og-sheet--bottom .schedule-panel');await sheet.waitFor();
    check(true,'phone: settings open as a bottom sheet');
    check(await p.locator('.og-sheet--bottom .og-panel-title').innerText().then(t=>t.includes('日程设置')),'phone: sheet carries the settings title');
    check(await addEventFirstRow(p,'.og-sheet--bottom .schedule-panel'),'phone: add-event sits in the first panel row');
    const phoneStyles=await p.evaluate(()=>{
      const pn=document.querySelector('.og-sheet--bottom .og-panel-body .schedule-panel');
      const body=document.querySelector('.og-sheet--bottom .og-panel-body');
      if(!pn||!body)return null;
      return{pnOv:getComputedStyle(pn).overflowY,bodyOv:getComputedStyle(body).overflowY};
    });
    check(!!phoneStyles&&phoneStyles.pnOv==='visible','phone: panel itself never scrolls (sheet body is the only scroller)');
    check(!!phoneStyles&&(phoneStyles.bodyOv==='auto'||phoneStyles.bodyOv==='scroll'),'phone: sheet body is the scroll container');
    check(await (async()=>{const list=await scrollables(p,'.og-sheet--bottom');return Array.isArray(list)&&list.length<=1;})(),'phone: at most one scrollable element in the sheet subtree');
    await p.screenshot({path:out+'/phone-sheet.png'});
    await p.keyboard.press('Escape');await p.locator('.og-sheet--bottom .schedule-panel').waitFor({state:'hidden'});
    check(true,'phone: Escape closes the sheet');
    // 触摸拖动：位移 + 记忆
    const r0=await dragDock(p,-70,-160);await p.waitForTimeout(350);
    const r1=await dockBox(p);
    check(!!r1&&Math.abs((r0.x-r1.x)-70)<8&&Math.abs((r0.y-r1.y)-160)<8,'phone: touch drag moves the dock');
    check(await p.evaluate(k=>{const v=JSON.parse(localStorage.getItem(k)??'null');return !!v&&v.right>0&&v.bottom>0;},KEY),'phone: dock position persisted');
    await p.close();
  }
  check(errors.length===0,'no runtime errors '+errors.join(';'));
  writeFileSync(out+'/report.json',JSON.stringify({checks,errors},null,2));
  console.log(`schedule-dock: ${checks} checks passed`);
}catch(err){
  writeFileSync(out+'/report.json',JSON.stringify({checks,errors:String(err?.stack??err)},null,2));
  console.error(String(err?.stack??err));process.exitCode=1;
}finally{await browser.close();}
