import { t } from "../i18n/index.js";

const reasons = new Set([
  "missing-public-key", "invalid-public-key", "empty-response", "access-restricted",
  "trust-limit", "unexpected-page", "unsafe-confirmation", "confirmation-loop", "gateway-unavailable",
  "gateway-session-pinned",
]);

/** Stable library codes only. Never log page HTML, session IDs or server-provided attributes. */
export function loginFailureDiagnostic(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const e = error as { code?: string; reason?: string; stage?: string };
  if (e.code !== "AUTH_PREPARATION_FAILED" || !reasons.has(e.reason ?? "")) return "";
  const stage = e.stage === "trusted-confirmation" ? "trusted-confirmation" : "credential-entry";
  return `AUTH-FAIL reason=${e.reason} stage=${stage}`;
}

/** Null means this is not one of our authentication errors. */
export function explainLoginError(error: unknown): string | null {
  const e = error && typeof error === "object"
    ? error as { code?: string; reason?: string; retryAfterMs?: number; status?: number; message?: string }
    : {};
  if (e.code === "AUTH_COOLDOWN") {
    const seconds = Number.isFinite(e.retryAfterMs) ? Math.max(1, Math.ceil(e.retryAfterMs! / 1000)) : 20;
    return t("login.error.cooldown", { seconds });
  }
  if (e.code === "AUTH_IN_PROGRESS") return t("login.error.inProgress");
  const sharedCode = e.code ?? e.message ?? (typeof error === "string" ? error : "");
  if (/CLI_(?:SHARED_SESSION_CHANGED|ACCOUNT_CHANGED)|AUTH_HANDOFF_LOGGED_OUT/.test(sharedCode)) return t("login.error.sessionChanged");
  if (/CLI_(?:DAEMON|BRIDGE|PENDING_LOGOUT)|AUTH_HANDOFF_UNVERIFIED/.test(sharedCode)) return t("cli.server.error");
  if (e.code === "AUTH_SESSION_CONFLICT") return t("login.error.sessionConflict");
  if (e.code === "AUTH_SESSION_CHANGED" || e.message === "AUTH_SESSION_CHANGED") return t("login.error.sessionChanged");
  if (e.code === "AUTH_2FA_RESTART") return t("login.error.restartVerification");
  if (e.code === "AUTH_2FA_METHOD") return t("login.error.changeMethod");
  if (e.status === 429) return t("login.error.restricted");
  if (e.code === "AUTH_PREPARATION_FAILED") {
    if (e.reason === "gateway-unavailable") return t("login.error.gatewayUnavailable");
    if (e.reason === "trust-limit") return t("login.error.trustLimit");
    if (e.reason === "access-restricted") return t("login.error.restricted");
    if (e.reason === "invalid-public-key" || e.reason === "unsafe-confirmation") return t("login.error.invalidForm");
    if (e.reason === "confirmation-loop") return t("login.error.confirmationLoop");
    if (e.reason === "gateway-session-pinned") return t("login.error.gatewaySession");
    return t("login.error.prepareFailed");
  }
  // Older library instances can still be alive during a development hot reload.
  if ((e.message ?? error) === "Failed to get public key.") return t("login.error.prepareFailed");
  return null;
}
