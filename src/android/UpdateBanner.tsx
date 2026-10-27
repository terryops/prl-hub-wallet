import { useEffect, useRef, useState } from "react";
import { nativeCall } from "../../shared/android-bridge.ts";
import { pearlHost } from "../../shared/android-host.ts";
import { walletCopy } from "./native.ts";
import { UpdateChecker, type AppVersion, type UpdateNotice } from "./update.ts";
import type { Lang } from "../i18n/index.ts";
import { Icon } from "../Icons.tsx";

// Called once at app launch, including while locked. The parent also notifies on native resume.
export function useAndroidUpdate() {
  const [latest, setLatest] = useState<UpdateNotice>();
  const checker = useRef<UpdateChecker | null>(null);
  useEffect(() => {
    let active = true;
    checker.current = new UpdateChecker(chrome.storage.local, undefined, () => nativeCall("update.check"));
    const check = () => void nativeCall<AppVersion>("info").then((info) => checker.current?.check(info)).then((next) => { if (active) setLatest(next); }).catch(() => {});
    check();
    const off = pearlHost()?.subscribe(check);
    const visible = () => { if (!document.hidden) check(); };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; off?.(); document.removeEventListener("visibilitychange", visible); };
  }, []);
  return { latest, dismiss: () => { if (latest) { void checker.current?.dismiss(latest.versionCode); setLatest(undefined); } } };
}

export function UpdateBanner({ lang, latest, dismiss }: { lang: Lang; latest: UpdateNotice; dismiss: () => void }) {
  const w = walletCopy(lang);
  const title = latest.versionName ? w.newVersion.replace("{0}", latest.versionName) : w.newVersionPlain;
  // The website APK downloads the new file; on Play, Play's own update screen (or the store page).
  const open = () => void (latest.url ? nativeCall("openExternal", { url: latest.url }) : nativeCall("update.start")).catch(() => {});
  return <aside className="android-update" aria-label={title}>
    <button className="android-update-open" onClick={open}>
      <Icon name="received" /><strong>{title}</strong><span>{w.update}</span>
    </button>
    <button className="icon-button" aria-label={w.dismissVersion} onClick={dismiss}><Icon name="close" /></button>
  </aside>;
}
