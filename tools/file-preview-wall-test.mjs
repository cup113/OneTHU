/**
 * 「拿回来的不是文件」的三分判别：登录页 / 网关引导页 / 普通 HTML 页。
 *
 * 真机事故（2026-10-28，用户实录）：通知附件点「预览」显示
 * 「登录状态已失效，请重新登录后再预览」，而同一秒 learn 的列表接口全是 200。
 * 真因是附件地址 404，learn 回的是 HTML 错误页；旧判据把所有 HTML 都算成登录墙，
 * 于是任何 4xx/5xx 都在指控「登录状态失效」。
 *
 * 跑法：node --import ./tools/ts-resolve-register.mjs tools/file-preview-wall-test.mjs
 */
const { classifyWallBody, isLoginWallBody } = await import("../apps/desktop/src/lib/loginWall.ts");

let pass = 0, fail = 0;
const eq = (name, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error(`✗ ${name}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
};

const bytes = (s) => new TextEncoder().encode(s);

/* ① 普通 HTML 错误页（404/500）：不是登录墙——这正是被误报成「登录状态已失效」的那类 */
{
  const notFound = bytes(`<!DOCTYPE html><html><head><title>404</title></head><body>找不到页面</body></html>`);
  eq("404 错误页 → html", classifyWallBody("text/html; charset=utf-8", notFound), "html");
  eq("404 错误页不算登录墙", isLoginWallBody("text/html; charset=utf-8", notFound), false);
  const small = bytes(`<html><body>服务器开小差了</body></html>`);
  eq("小错误页仍不算登录墙", isLoginWallBody("text/html", small), false);
}

/* ② 真登录页：必须仍然判成登录墙（别把该重登的场景放过去） */
{
  const idForm = bytes(`<html><body><form action="/do/off/ui/auth/login/check"><input name="i_pass"></form></body></html>`);
  eq("id 登录表单 → login", classifyWallBody("text/html", idForm), "login");
  eq("id 登录表单算登录墙", isLoginWallBody("text/html", idForm), true);
  // learn 会话死时下载端点回的就是这种 69 字节跳转页
  const redirect = bytes(`<script>location.href="/"</script>`);
  eq("location.href 跳转页 → login", classifyWallBody("text/html", redirect), "login");
  eq("跳转页算登录墙", isLoginWallBody("text/html", redirect), true);
}

/* ③ webvpn 取票引导页：短页面 + __vpn_* 变量 → gateway（仍算「该重新登录」，但不是错误页） */
{
  const guide = bytes(`<!DOCTYPE html><html><head><script>var __vpn_hostname_data="x";var __vpn_app_hostname_data="y";</script></head><body></body></html>`);
  eq("引导页 → gateway", classifyWallBody("text/html", guide), "gateway");
  eq("引导页算登录墙（上层提示重登）", isLoginWallBody("text/html", guide), true);
  // 被 wengine 注入 __vpn_* 的**正常长页面**不算引导页
  const normal = bytes(`<!DOCTYPE html><html><body><script>var __vpn_hostname_data="x";var __vpn_app_hostname_data="y";</script>${"业务内容".repeat(1200)}</body></html>`);
  eq("长页面不算引导页", classifyWallBody("text/html", normal), "html");
}

/* ④ 真正的文件字节：一切放行 */
{
  const pdf = bytes("%PDF-1.7\n...");
  eq("PDF → null", classifyWallBody("application/pdf", pdf), null);
  const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  eq("docx(zip) → null", classifyWallBody("application/octet-stream", docx), null);
  const empty = new Uint8Array();
  eq("空响应 → null（交给上层按空文件报）", classifyWallBody("application/octet-stream", empty), null);
  // 图片 mime 短路：SVG 也可能以 `<` 开头，不能按 HTML 处理
  const svg = bytes(`<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`);
  eq("SVG 图片不算 HTML", classifyWallBody("image/svg+xml", svg), null);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
