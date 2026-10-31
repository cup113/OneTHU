import { fileURLToPath } from "node:url";
/** Browser-level mobile acceptance. Inputs go through Chrome's trusted touch
 * pipeline and its actual hit testing; no element.dispatchEvent / force click.
 * This is a WebView-sized browser check, not physical Android device coverage. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const base = process.argv[2] ?? 'http://127.0.0.1:5180';
const out = new URL('../docs/onegui/mobile-touch-2026-10-20/', import.meta.url);
await mkdir(out, { recursive: true });
const checks = [], errors = [];
const check = (c, m) => { assert.ok(c, m); checks.push(m); console.log('✓ ' + m); };
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });

async function setup(width, mode = 'full') {
  const p = await browser.newPage({ viewport: { width, height: width === 320 ? 740 : 844 }, hasTouch: true, isMobile: true });
  p.setDefaultTimeout(12000);
  p.on('pageerror', e => { if (!/reading 'invoke'/.test(e.message)) errors.push(e.message); });
  await p.addInitScript(mode => {
    performance.setResourceTimingBufferSize(10000);
    localStorage.setItem('onethu.onboarded.phone', '1');
    localStorage.setItem('onethu.experience.v1', mode);
    if (mode !== 'full') localStorage.setItem('onethu.board.phoneCanvas.v1', '1');
    window.__touchLog = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'])
      window.addEventListener(type, e => window.__touchLog.push({ type, trusted: e.isTrusted, pointerType: e.pointerType }), true);
  }, mode);
  await p.goto(base + '/?explorer-preview=home', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.explorer-shell');
  if (mode === 'full') await p.waitForSelector('.freeboard-wrap.is-reading');
  await p.waitForTimeout(1000);
  return p;
}
async function touchDrag(p, from, dx, dy, steps = 8) {
  const cdp = await p.context().newCDPSession(p);
  const point = (x, y) => ({ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(from.x, from.y)] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(from.x + dx * i / steps, from.y + dy * i / steps)] });
    await p.waitForTimeout(24);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach(); await p.waitForTimeout(220);
}
async function itemRect(p) {
  return p.locator('[data-item-id="home.clock"]').evaluate(el => {
    const s = getComputedStyle(el), b = el.getBoundingClientRect();
    return { x: parseFloat(s.left), y: parseFloat(s.top), w: parseFloat(s.width), h: parseFloat(s.height), scale: b.width / parseFloat(s.width) };
  });
}
async function bodyPoint(p) {
  return p.locator('[data-item-id="home.clock"]').evaluate(el => {
    const r = el.getBoundingClientRect();
    const shortcuts = document.querySelector(".oneshot")?.getBoundingClientRect();
    const bottom = shortcuts && shortcuts.top > innerHeight / 2 ? shortcuts.top - 12 : innerHeight - 16;
    for (let y = Math.min(bottom, r.bottom - 20); y > Math.max(70, r.top + 8); y -= 16) {
      for (let x = Math.max(24, r.left + 24); x < Math.min(innerWidth - 40, r.right - 16); x += 20) {
        const hit = document.elementFromPoint(x, y);
        if (hit?.closest('[data-item-id="home.clock"]') === el && !hit.closest('.free-toolbar,.free-handle,button,a,input,textarea,[role=button]')) return { x, y };
      }
    }
    throw new Error('Clock has no uncovered body point in the actual viewport');
  });
}
const shot = (p, name) => p.screenshot({ path: fileURLToPath(new URL(name + '.png', out)) });
const zoom = p => p.locator('.board-viewport-tools').getByRole('button', { name: /^\d+%$/ });

try {
  for (const width of [390, 320]) {
    const p = await setup(width);
    try {
      check(await p.locator('.freeboard-wrap.is-reading').count() === 1, `${width}: default reading order`);
      await shot(p, `${width}-reading`);
      await p.getByRole('button', { name: '自由摆放', exact: true }).tap(); await p.waitForTimeout(400);
      check(await zoom(p).innerText() === '500%', `${width}: first free-canvas visit defaults to 500%`);
      const feedback = await p.locator('.board-note').boundingBox(), shortcutsBefore = await p.locator('.oneshot').boundingBox();
      check(feedback && shortcutsBefore && feedback.y + feedback.height < shortcutsBefore.y, `${width}: canvas status is readable above shortcut navigation`);
      const gap = await p.evaluate(() => {
        const clock = document.querySelector('[data-item-id="home.clock"]').getBoundingClientRect();
        const services = document.querySelector('[data-item-id="home.services"]').getBoundingClientRect();
        const y = (clock.bottom + services.top) / 2, x = innerWidth / 2;
        return { x, y, clear: !document.elementFromPoint(x, y)?.closest('.free-item,button') };
      });
      check(gap.clear, `${width}: horizontal pan starts on a visible blank canvas gap`);
      await touchDrag(p, gap, -(width / 2 - 32), 0);
      check(await p.locator('.explorer-panel.is-home-canvas').evaluate(el => el.scrollLeft) > 80, `${width}: native horizontal swipe reaches off-screen canvas content`);
      await shot(p, `${width}-panned`);
      check(await p.getByRole('button', { name: '阅读顺序', exact: true }).evaluate(el => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }), `${width}: reading-mode control stays visible and reachable after horizontal panning`);
      for (let i = 0; i < 4 && await p.locator('.explorer-panel.is-home-canvas').evaluate(el => el.scrollLeft) > 1; i++) {
        await touchDrag(p, { x: 40, y: gap.y }, width - 80, 0);
      }
      check(await p.locator('.explorer-panel.is-home-canvas').evaluate(el => el.scrollLeft) < 2, `${width}: reverse swipe returns to the left edge`);
      const start = await bodyPoint(p), before = await itemRect(p);
      await p.evaluate(() => window.__touchLog.length = 0);
      await touchDrag(p, start, 48, 36);
      const moved = await itemRect(p), log = await p.evaluate(() => window.__touchLog);
      check(log.length > 3 && log.every(e => e.trusted && e.pointerType === 'touch'), `${width}: drag uses trusted touch events`);
      check(!log.some(e => e.type === 'pointercancel'), `${width}: nested card scrolling does not cancel drag`);
      check(Math.abs(moved.x - before.x - 48 / before.scale) < 2 && Math.abs(moved.y - before.y - 36 / before.scale) < 2, `${width}: complete finger displacement reaches saved card coordinates`);
      // Explicit user choice, followed by reload/toggle/orientation changes.
      await p.getByRole('button', { name: '缩小', exact: true }).tap();
      await p.getByRole('button', { name: '缩小', exact: true }).tap(); await p.waitForTimeout(300);
      check(await zoom(p).innerText() === '300%', `${width}: user can reduce zoom`);
      const bp = await bodyPoint(p); await p.touchscreen.tap(bp.x, bp.y); await p.waitForTimeout(250);
      check(!(await p.locator('[data-item-id="home.clock"]').getAttribute('class')).includes('is-pinned'), `${width}: selecting does not activate a toolbar button underneath the finger`);
      const handle = p.locator('[data-item-id="home.clock"] .fh-se');
      const hit = await handle.evaluate(el => { const b = el.getBoundingClientRect(); const x = b.x + b.width / 2, y = b.y + b.height / 2; return { x, y, reachable: document.elementFromPoint(x, y) === el, width: b.width, height: b.height }; });
      check(hit.width >= 43 && hit.height >= 43, `${width}: corner touch target stays at least 44 screen pixels`);
      check(hit.reachable, `${width}: resize handle is really on top at its screen coordinate`);
      const sizeBefore = await itemRect(p);
      await touchDrag(p, hit, 36, 30);
      const resized = await itemRect(p);
      check(Math.abs(resized.w - sizeBefore.w - 36 / sizeBefore.scale) < 2 && Math.abs(resized.h - sizeBefore.h - 30 / sizeBefore.scale) < 2, `${width}: native corner drag changes width and height`);
      await shot(p, `${width}-resized`);
      await p.reload(); await p.waitForSelector('.freeboard-wrap.phone-canvas'); await p.waitForTimeout(600);
      check(await zoom(p).innerText() === '300%', `${width}: reload keeps the saved 300%`);
      const restored = await itemRect(p);
      check(restored.x === resized.x && restored.y === resized.y && restored.w === resized.w && restored.h === resized.h, `${width}: move and resize persist on reload`);
      await p.getByRole('button', { name: '阅读顺序', exact: true }).tap();
      await p.getByRole('button', { name: '自由摆放', exact: true }).tap();
      check(await zoom(p).innerText() === '300%', `${width}: toggling reading order preserves chosen zoom`);
      await zoom(p).tap();
      await p.getByRole('button', { name: '阅读顺序', exact: true }).tap();
      await p.getByRole('button', { name: '自由摆放', exact: true }).tap();
      check(await zoom(p).innerText() === '100%', `${width}: explicitly saved 100% is not mistaken for an uninitialized view`);
      // Phone portrait and desktop/landscape store independent views.
      await p.setViewportSize({ width: 844, height: 390 }); await p.waitForTimeout(700);
      check(!(await p.evaluate(() => document.documentElement.classList.contains('is-phone'))), `${width}: landscape adopts desktop layout`);
      check(await zoom(p).innerText() === '100%', `${width}: portrait zoom does not overwrite landscape`);
      await shot(p, `${width}-landscape`);
      const lp = await bodyPoint(p), lb = await itemRect(p);
      await touchDrag(p, lp, 32, 24);
      const la = await itemRect(p);
      check(Math.abs(la.x - lb.x - 32 / lb.scale) < 2 && Math.abs(la.y - lb.y - 24 / lb.scale) < 2, `${width}: landscape finger drag also reaches its destination`);
      await p.setViewportSize({ width, height: width === 320 ? 740 : 844 }); await p.waitForTimeout(650);
      check(await zoom(p).innerText() === '100%', `${width}: rotating back retains portrait choice`);
      await p.getByRole('button', { name: '阅读顺序', exact: true }).tap();
      const scrollBefore = await p.evaluate(() => scrollY);
      await touchDrag(p, { x: 90, y: Math.min(500, p.viewportSize().height - 240) }, 0, -180);
      check(await p.evaluate(() => scrollY) > scrollBefore + 40, `${width}: reading order scrolls naturally with a finger`);
      await shot(p, `${width}-scrolled`);
      const bar = await p.locator('.oneshot').boundingBox(), tools = await p.locator('.board-viewport-tools').boundingBox(), oh = await p.locator('.ex-bbar').boundingBox();
      check(bar && tools && oh && tools.y + tools.height <= bar.y && bar.y + bar.height <= oh.y + 1, `${width}: board tools, five shortcuts and OH do not cover each other`);
    } finally { await p.close(); }
  }
  for (const mode of ['simple', 'practical']) {
    const p = await setup(390, mode);
    check(await p.locator('.freeboard-wrap:visible').count() === 0, `${mode}: no active board manipulation surfaces`);
    check(await p.evaluate(() => localStorage.getItem('onethu.boardview.v2')) === null, `${mode}: hidden full-mode board does not initialize or modify saved zoom`);
    await p.close();
  }
  check(errors.length === 0, 'No runtime errors: ' + JSON.stringify(errors.slice(0, 3)));
  await writeFile(new URL('report.json', out), JSON.stringify({ kind: 'Chrome mobile emulation using trusted CDP touch', physicalAndroid: false, checks }, null, 2) + '\n');
  console.log(`\n${checks.length} real-input browser checks passed`);
} finally { await browser.close(); }
