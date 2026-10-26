import { getLocale as getUiLocale } from "../i18n/index.js";
import { t as i18n, rich as i18nRich, msg as i18nMsg, useLocale as useUiLocale } from "../i18n/index.js";
import { useEffect, useState } from "react";
import { Btn, Inline, Input, SettingsRow, Stack } from "@onethu/gui";
import { Card } from "./Layout.js";
import { ErrorLine } from "./Details.js";
import { confirmOk } from "../lib/confirm.js";
import { useCloudCal, configureCloudCal, disconnectCloudCal, syncCloudCal } from "../state/cloudCal.js";
import {
  useSystemCal,
  systemCalSupported,
  enableSystemCalendar,
  disableSystemCalendar,
  removeSystemCalendar,
  syncSystemCalendar,
} from "../state/systemCal.js";

/** Same calendar controls in every experience mode; switching modes only changes the shell. */
export function CalendarSyncSettings() {
  const uiLocale = useUiLocale();

  // 云同步（清华邮箱 CalDAV 日历）
  const cloud = useCloudCal();
  const [calEmail, setCalEmail] = useState("");
  const [calPass, setCalPass] = useState("");
  const [calBusy, setCalBusy] = useState(false);
  const [calMsg, setCalMsg] = useState<string | null>(null);
  // 系统日历原生同步（Android/macOS）
  const syscal = useSystemCal();
  const [sysSupported, setSysSupported] = useState<boolean | null>(null);
  const [sysBusy, setSysBusy] = useState(false);
  const [sysMsg, setSysMsg] = useState<string | null>(null);

  useEffect(() => {
    void systemCalSupported().then(setSysSupported);
  }, []);

  return <Stack gap={3}>
      <Card>
        <SettingsRow
          title={cloud.configured ? i18n("components.calendarsyncsettings.f70b7f1642df") : i18n("components.calendarsyncsettings.5dec8ac021d7")}
          sub={
            cloud.configured ? (
              <>{i18nRich("components.calendarsyncsettings.579271d39631", { email: cloud.email, value: calMsg ? <ErrorLine text={calMsg} tone="quiet" /> : null })}</>
            ) : (
              <>{i18nRich("components.calendarsyncsettings.a1fe9e82901d", { value: calMsg ? <ErrorLine text={calMsg} tone="quiet" /> : null })}</>
            )
          }
          control={
            cloud.configured ? (
              <Inline gap={2} wrap>
                <Btn variant="outline" onClick={() =>
                    void confirmOk(
                      i18nMsg("components.calendarsyncsettings.e50242f6c79b"),
                    )
                  }>{i18n("components.calendarsyncsettings.353bd3ca6478")}</Btn>
                <Btn variant="outline" disabled={calBusy || cloud.syncing} onClick={() => {
                    setCalBusy(true);
                    setCalMsg(null);
                    void syncCloudCal()
                      .then((r) => setCalMsg(i18n("components.calendarsyncsettings.f0ba269cd55d", { total: String(r.total), added: String(r.added), updated: String(r.updated), removed: String(r.removed) })))
                      .catch((e: unknown) => setCalMsg(i18n("components.calendarsyncsettings.4d103a2b0e94", { value: String(e instanceof Error ? e.message : String(e)) })))
                      .finally(() => setCalBusy(false));
                  }}>{calBusy || cloud.syncing ? i18n("components.calendarsyncsettings.4e2238b74ec7") : i18n("components.calendarsyncsettings.36e7a43a1c67")}</Btn>
                <Btn variant="outline" disabled={calBusy || cloud.syncing} onClick={() =>
                    void disconnectCloudCal().then(() => {
                      setCalEmail("");
                      setCalPass("");
                      setCalMsg(i18n("components.calendarsyncsettings.f37e30c0f2b2"));
                    }).catch((e: unknown) => setCalMsg(i18n("components.calendarsyncsettings.1b6ad181ca5c", { value: String(e instanceof Error ? e.message : String(e)) })))
                  }>{i18n("components.calendarsyncsettings.f33ac04eece6")}</Btn>
              </Inline>
            ) : null
          }
        />
        {cloud.error ? <ErrorLine text={i18n("components.calendarsyncsettings.1c3ab23e0178", { error: String(cloud.error) })} tone="error" /> : null}
        {cloud.configured ? null : (
          <div className="og-settings-row" style={{ alignItems: "stretch" }}>
            <span className="og-settings-row-main">
              <Inline gap={2} wrap>
                <div style={{ minWidth: 200, flex: "1 1 200px" }}><Input placeholder={i18n("components.calendarsyncsettings.593bb32ef7ef")} value={calEmail} onChange={(value) => setCalEmail(value.trim())} /></div>
                <div style={{ minWidth: 140, flex: "1 1 140px" }}><Input type="password" placeholder={i18n("components.calendarsyncsettings.f7da6974f7c9")} value={calPass} onChange={(value) => setCalPass(value)} /></div>
                <Btn variant="solid" tone="brand" disabled={!/.+@.+/.test(calEmail) || !calPass || calBusy} onClick={() => {
                    setCalBusy(true);
                    setCalMsg(null);
                    void configureCloudCal(calEmail, calPass)
                      .then((cals) => setCalMsg(i18n("components.calendarsyncsettings.65dcde5641da", { value: String(cals.join("、")) })))
                      .catch((e: unknown) => setCalMsg(i18n("components.calendarsyncsettings.a8d9c61f394a", { value: String(e instanceof Error ? e.message : String(e)) })))
                      .finally(() => setCalBusy(false));
                  }}>{calBusy ? i18n("components.calendarsyncsettings.ee9ebe523d42") : i18n("components.calendarsyncsettings.31c1468a6ea3")}</Btn>
              </Inline>
            </span>
          </div>
        )}
      </Card>
      <Card>
        <SettingsRow
          title={sysSupported === false ? i18n("components.calendarsyncsettings.e7f648da0ef4") : syscal.enabled ? i18n("components.calendarsyncsettings.4414244c2645") : i18n("components.calendarsyncsettings.e7f648da0ef4")}
          sub={
            sysSupported === false ? (
              i18n("components.calendarsyncsettings.a0813c42f2ad")
            ) : syscal.enabled ? (
              <>{i18nRich("components.calendarsyncsettings.9e40f65d2856", { value: syscal.lastSyncAt ? new Date(syscal.lastSyncAt).toLocaleString(getUiLocale()) : "—", lastCount: syscal.lastCount, value2: syscal.lastError ? <ErrorLine text={i18n("components.calendarsyncsettings.35001df10d62", { lastError: String(syscal.lastError) })} tone="error" /> : null, value3: sysMsg ? <ErrorLine text={sysMsg} tone="quiet" /> : null })}</>
            ) : (
              <>{i18nRich("components.calendarsyncsettings.6db47a772acc", { value: sysMsg ? <ErrorLine text={sysMsg} tone="quiet" /> : null })}</>
            )
          }
          control={
            sysSupported === false ? null : syscal.enabled ? (
              <Inline gap={2} wrap>
                <Btn variant="outline" disabled={sysBusy || syscal.syncing} onClick={() => {
                    setSysBusy(true);
                    setSysMsg(null);
                    void syncSystemCalendar()
                      .then((r) =>
                        // 差异同步：内容没变时 added/removed 都是 0（一次 provider 都没写），
                        // 说「已写入 0 条」会让人以为坏了 —— 与指纹跳过同样报「已是最新」。
                        setSysMsg(r.skipped || (r.added === 0 && r.removed === 0) ? i18n("components.calendarsyncsettings.40012cfe27b0") : i18n("components.calendarsyncsettings.8282a625a7e6", { added: String(r.added), removed: String(r.removed) })),
                      )
                      .catch((e: unknown) => setSysMsg(i18n("components.calendarsyncsettings.4d103a2b0e94", { value: String(e instanceof Error ? e.message : String(e)) })))
                      .finally(() => setSysBusy(false));
                  }}>{sysBusy || syscal.syncing ? i18n("components.calendarsyncsettings.4e2238b74ec7") : i18n("components.calendarsyncsettings.36e7a43a1c67")}</Btn>
                <Btn variant="outline" disabled={sysBusy} onClick={() => {
                    void disableSystemCalendar()
                      .then(() => setSysMsg(i18n("components.calendarsyncsettings.288e461f287f")))
                      .catch((e: unknown) => setSysMsg(String(e instanceof Error ? e.message : e)));
                  }}>{i18n("components.calendarsyncsettings.10fe7d28b16b")}</Btn>
                <Btn variant="outline" disabled={sysBusy} onClick={() => {
                    void confirmOk(
                      i18nMsg("components.calendarsyncsettings.5b156f4dffc5"),
                    ).then((yes) => {
                      if (!yes) return;
                      setSysBusy(true);
                      void removeSystemCalendar()
                        .then(() => setSysMsg(i18n("components.calendarsyncsettings.2cea6bae6985")))
                        .catch((e: unknown) => setSysMsg(i18n("components.calendarsyncsettings.5e9e9ab95a7b", { value: String(e instanceof Error ? e.message : String(e)) })))
                        .finally(() => setSysBusy(false));
                    });
                  }}>{i18n("components.calendarsyncsettings.a7ec7c813f57")}</Btn>
              </Inline>
            ) : (
              <Btn variant="solid" tone="brand" disabled={sysBusy || sysSupported === null} onClick={() => {
                  setSysBusy(true);
                  setSysMsg(null);
                  void enableSystemCalendar()
                    .then(() => setSysMsg(i18n("components.calendarsyncsettings.32b84144958b")))
                    .catch((e: unknown) => setSysMsg(i18n("components.calendarsyncsettings.9776893d3c55", { value: String(e instanceof Error ? e.message : String(e)) })))
                    .finally(() => setSysBusy(false));
                }}>{sysBusy ? i18n("components.calendarsyncsettings.c4d0edd8c65a") : i18n("components.calendarsyncsettings.375bd11476d2")}</Btn>
            )
          }
        />
      </Card>
  </Stack>;
}
