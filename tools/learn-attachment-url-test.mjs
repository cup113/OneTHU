/**
 * 附件地址「是不是真的指向一个文件」的判读（纯函数）。
 *
 * 真机事故（2026-10-28）：通知详情页渲染出的附件地址是
 *   …/b/wlxt/kcgg/wlkc_ggb/student/kcggFjxz/{wlkcid}/{32位id}/
 * 路径末段为空、请求恒 404，于是 UI 上出现一行「预览」按钮，点开必然失败
 * （而且旧代码把 404 的 HTML 错误页当登录墙，报「登录状态已失效」）。
 *
 * 跑法：node --import ./tools/ts-resolve-register.mjs tools/learn-attachment-url-test.mjs
 */
const { isDownloadableAttachmentUrl } = await import("../packages/core/src/learn/attachmentName.ts");

let pass = 0, fail = 0;
const eq = (name, a, b) => {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else { fail++; console.error(`✗ ${name}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
};

const PREFIX = "https://webvpn.tsinghua.edu.cn/https/77726476706e69737468656265737421fcf2408e297e7c4377068ea48d546d30ca8cc97bcc";

/* ① 真机那条 404：末段为空 → 不是文件 */
{
  const broken = `${PREFIX}/b/wlxt/kcgg/wlkc_ggb/student/kcggFjxz/2026-2027-1152226972/26ef84e7a13dd9fb01a180fa31eb660e/`;
  eq("真机 404 地址（末段为空）判否", isDownloadableAttachmentUrl(broken), false);
  eq("带查询参数也判否", isDownloadableAttachmentUrl(broken + "?wjid=1"), false);
}

/* ② learn 真实下载端点：端点 + 查询参数，末段有名字 → 是文件 */
{
  eq("课件下载端点", isDownloadableAttachmentUrl(`${PREFIX}/b/wlxt/kj/wlkc_kjxxb/student/downloadFile?sfgk=0&wjid=123`), true);
  eq("通知附件端点", isDownloadableAttachmentUrl(`${PREFIX}/b/wlxt/kcgg/wlkc_ggb/student/kcggFjxz?wlkcid=1&ggid=2&wjid=3`), true);
  eq("路径式文件名", isDownloadableAttachmentUrl(`${PREFIX}/b/wlxt/kcgg/wlkc_ggb/student/kcggFjxz/1/2/%E4%BD%9C%E4%B8%9A.docx`), true);
  eq("讨论区附件端点", isDownloadableAttachmentUrl(`${PREFIX}/b/wlxt/bbs/bbs_tltb/student/downloadFileByTlForStu?wlkcid=1&wjid=2`), true);
}

/* ③ 非 http / 空 / 畸形：一律判否，绝不让它们冒充附件 */
{
  eq("空串", isDownloadableAttachmentUrl(""), false);
  eq("无协议相对路径", isDownloadableAttachmentUrl("/b/wlxt/x?wjid=1"), false);
  eq("javascript:", isDownloadableAttachmentUrl("javascript:void(0)"), false);
  eq("站点根", isDownloadableAttachmentUrl(`${PREFIX}/`), false);
  eq("畸形地址", isDownloadableAttachmentUrl("http://[::1"), false);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
