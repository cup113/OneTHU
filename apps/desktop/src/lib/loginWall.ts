/**
 * 「这次拿回来的不是文件」的判别（纯函数、零依赖，可直测）。
 *
 * 为什么单独成文件：附件预览、正文图片这些**旁路**不经过数据页的错误提示链，得自己
 * 判断响应到底是文件、登录页还是网关页；而这段逻辑若留在 `clients.ts` 里，单测一 import
 * 就会把整个 `@onethu/core` 拖进来（Node 的类型剥离不支持 core 里的参数属性语法），
 * 于是判错一次就再也测不到。做法同 `sessionErrors.ts`。
 *
 * 历史故障（2026-10-28，用户实录）：通知附件点「预览」显示「登录状态已失效，请重新登录
 * 后再预览」，而同一秒 learn 的列表接口全是 200。真因是附件地址本身 404，learn 回的是
 * **HTML 错误页**，而旧判据「非图片 + 前 512 字节以 `<!doctype`/`<html` 开头」把所有
 * HTML 都算成登录墙 → 任何 4xx/5xx 都说成「登录状态失效」。现在把三类分开：
 *
 * - `login`   真登录页/登录跳转（`location.href="/"` 那种 69 字节跳转页、id 登录表单、
 *             learn 的 `j_spring_security_check`）→ 用户确实该重新登录；
 * - `gateway` webvpn 取票引导页（`__vpn_hostname_data`）→ 登录状态没建立起来，同样该重登；
 * - `html`    普通 HTML 页（404/500 错误页、站点提示页）→ **不是**登录墙，调用方按
 *             HTTP 状态或「响应不是文件」如实上报。
 */

/** 非文件响应的三种来源；`null` = 看起来就是文件字节。 */
export type NonFileBody = "login" | "gateway" | "html";

/** 判据只看响应头部（前 2 KB）——错误页/登录页都在开头就暴露身份。 */
const HEAD_BYTES = 2048;
/** 「短响应」上限：跳转页/引导页都很小；正常页面很长，不该被短响应规则误伤。 */
const SHORT_BODY_BYTES = 4096;

/** 真·登录页特征（与 core `LEARN_LOGIN_PAGE_RE` 同源，这里只看旁路需要的几条）。 */
const LOGIN_MARKUP_RE =
  /sm2publicKey|name=["']i_pass["']|j_spring_security_check|电子身份服务系统|\/do\/off\/ui\/auth\/login\/|\/f\/login\b|\bre_log\b/i;

export function classifyWallBody(mime: string, buf: Uint8Array): NonFileBody | null {
  // 图片字节就是字节：`<` 开头的 SVG 也可能是合法图片，交给 mime 守卫单独判。
  if (/^image\//i.test(mime)) return null;

  const head = new TextDecoder()
    .decode(buf.subarray(0, HEAD_BYTES))
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (!head) return null;

  if (LOGIN_MARKUP_RE.test(head)) return "login";

  // webvpn 取票引导页：短、带 __vpn_* 变量、没有任何业务/登录文案。
  if (
    buf.length < SHORT_BODY_BYTES &&
    head.includes("__vpn_hostname_data") &&
    head.includes("__vpn_app_hostname_data")
  ) {
    return "gateway";
  }

  // learn 会话死时下载端点回的就是 `location.href="/"` 这种跳转页（实测 69 字节）。
  if (buf.length < SHORT_BODY_BYTES && /location\.href/i.test(head)) return "login";

  if (/^<(!doctype|html)/i.test(head)) return "html";
  return null;
}

/**
 * 兼容旧口径的布尔版：**登录状态没建立起来**（登录页或网关引导页）才算。
 * 普通 HTML 页不再算——那正是把 404 说成「登录状态已失效」的根源。
 */
export function isLoginWallBody(mime: string, buf: Uint8Array): boolean {
  const kind = classifyWallBody(mime, buf);
  return kind === "login" || kind === "gateway";
}
