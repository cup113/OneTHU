/**
 * 网络学堂附件名解析（纯函数，零依赖）。
 *
 * 背景（用户 2026-10-25 反馈）：从网络学堂下载附件时，落盘名变成「下载」且没有任何后缀。
 * 根因是作业/通知详情页的附件锚点文本常常就是**动作词**（下载 / 点击下载 / 附件），
 * 而不是文件名；此前 `parseAttachmentAnchor` 直接把锚点文本当 name，于是落盘名 = 下载。
 * 真正的文件名在：
 *   - 锚点属性里（title / download / data-name / data-filename）；
 *   - URL 参数里（wjmc / filename / fileName / filePath / path …）；
 *   - downloadUrl 解码后的路径 basename；
 *   - 文本里混排的「xxx.pdf（下载）」这种形态。
 * 本模块只负责「从这些候选里挑一个像文件名的」；仍无法确定时返回 ""，由 UI 用带 id
 * 的兜底名、Rust 侧再按 Content-Type 补后缀。
 */

const GENERIC_LABELS = new Set([
  "下载", "点击下载", "下载附件", "下载文件", "点击下载附件", "附件", "文件", "查看", "预览", "打开",
  "download", "download file", "download attachment", "click to download", "attachment", "file", "view", "preview", "open",
]);

/** 常见文件扩展名（用来从装饰文本里抠出真名，也用来优先选择带后缀候选） */
const EXT = "(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|tgz|txt|md|csv|json|xml|html?|png|jpe?g|gif|webp|svg|bmp|mp4|mov|avi|mkv|mp3|wav|m4a|ipynb|py|cpp|cc|c|h|hpp|java|js|ts|tsx|jsx|tex|r|go|rs|rb|php|sql|sh|bat|ps1|ppt|key|pages|numbers|rtf|epub|dwg|fig|sketch|drawio)";
const HAS_EXT_RE = new RegExp(`\\.${EXT}$`, "i");
const EMBEDDED_RE = new RegExp(`([^\\s/\\\\<>:"|?*()（）\\[\\]{}]+?\\.${EXT})(?=$|[\\s()（）\\[\\]【】,，。;；])`, "i");

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x0*27;/gi, "'")
    .replace(/&amp;/g, "&");
}

function clean(raw: string | undefined): string {
  if (!raw) return "";
  return decodeEntities(raw)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
}

function fileNameFromPath(value: string): string {
  try {
    const decoded = decodeURIComponent(decodeEntities(value)).replace(/\\/g, "/");
    const path = decoded.split(/[?#]/)[0] ?? "";
    const seg = path.split("/").filter(Boolean).pop() ?? "";
    const name = clean(seg);
    return HAS_EXT_RE.test(name) ? name : "";
  } catch {
    return "";
  }
}

/** 候选 → 文件名：优先带已知后缀；其次从装饰文本里抠；最后非泛化词也接受 */
function pick(candidates: string[]): string {
  const cleaned = candidates.map(clean).filter(Boolean);
  // 1) 直接就是已知文件名
  const exact = cleaned.find((c) => !GENERIC_LABELS.has(c.toLowerCase()) && HAS_EXT_RE.test(c));
  if (exact) return exact;
  // 2) 文本里夹着「xxx.pdf」/「下载 xxx.zip」：抠第一段像文件名的
  for (const c of cleaned) {
    const m = EMBEDDED_RE.exec(c);
    if (m?.[1] && !GENERIC_LABELS.has(m[1].toLowerCase())) return m[1];
  }
  // 3) 没有任何后缀但明显不是动作词（如「课程大纲」）：保留，交给 Content-Type 补后缀
  return cleaned.find((c) => c.length > 1 && !GENERIC_LABELS.has(c.toLowerCase())) ?? "";
}

/** 从 href / downloadUrl 的查询参数里找文件名。 */
export function attachmentNameFromUrl(url: string): string {
  const out: string[] = [];
  try {
    const search = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
    const params = new URLSearchParams(search);
    for (const key of ["wjmc", "filename", "fileName", "file_name", "name", "filePath", "filepath", "path", "downloadFile", "downloadUrl"]) {
      const value = params.get(key);
      if (!value) continue;
      // filePath/path 可能是一整串路径，取 basename
      const fromPath = fileNameFromPath(value);
      if (fromPath) out.push(fromPath);
      // A URL/path without a filename is not a name. Keep it empty so callers
      // can use the notification list's original fjmc rather than an endpoint.
      if (!/[\\/]/.test(value)) out.push(value);
      const fromValuePath = fileNameFromPath(value.replace(/\\/g, "/"));
      if (fromValuePath) out.push(fromValuePath);
    }
  } catch {
    /* 非标准 URL：忽略 */
  }
  out.push(fileNameFromPath(url));
  return pick(out);
}

export interface AttachmentNameInput {
  /** 锚点内部文本（可含标签，本函数会剥掉） */
  text?: string;
  /** 锚点属性（title / download / data-name / data-filename 等，键名大小写不敏感） */
  attributes?: Record<string, string>;
  /** href 原串（可含 wjmc / downloadUrl 等参数） */
  href?: string;
  /** 单独传 downloadUrl 参数（已解码前） */
  downloadUrl?: string;
}

/**
 * 附件地址是否真的指向一个**文件**。
 *
 * 用途：把站点渲染出来但根本没有文件的锚点挡在解析层（不产出附件行，就不会有
 * 一个「点了必然失败」的预览按钮）。
 *
 * 真机依据（2026-10-28）：通知详情页给出的附件地址是
 *   …/b/wlxt/kcgg/wlkc_ggb/student/kcggFjxz/{wlkcid}/{32位id}/
 * **路径末段为空**（以 `/` 结尾），请求恒 404；随后预览器把 404 的 HTML 错误页
 * 当成登录墙，用户看到「登录状态已失效，请重新登录后再预览」——而同一秒
 * learn 的列表接口全是 200。learn 的下载端点一律是
 * `downloadFile?wjid=…` / `kcggFjxz?wlkcid=…` 这种「端点 + 查询参数」形态，
 * 没有一个以 `/` 收尾，所以「路径以 / 结尾」就是「没有文件名」的可靠信号。
 */
export function isDownloadableAttachmentUrl(url: string): boolean {
  const raw = String(url ?? "").trim();
  if (!raw) return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    // 末段为空（目录形态）：站点没有给出文件名 → 不是可下载文件
    if (u.pathname.endsWith("/")) return false;
    return u.pathname.replace(/^\/+/, "").length > 0;
  } catch {
    return false;
  }
}

/** 从附件锚点推导落盘文件名；推不出唯一真名时返回 ""（调用方走 id 兜底 + Content-Type 后缀）。 */
export function learnAttachmentName(input: AttachmentNameInput): string {
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.attributes ?? {})) attrs[k.toLowerCase()] = v;
  const candidates: string[] = [];
  for (const key of ["download", "title", "data-name", "data-filename", "data-title", "aria-label"]) {
    if (attrs[key]) candidates.push(attrs[key]!);
  }
  if (input.text) candidates.push(input.text);
  if (input.downloadUrl) {
    candidates.push(attachmentNameFromUrl(input.downloadUrl));
  }
  if (input.href) {
    candidates.push(attachmentNameFromUrl(input.href));
    const fromPath = fileNameFromPath(input.href);
    if (fromPath) candidates.push(fromPath);
  }
  return pick(candidates);
}
