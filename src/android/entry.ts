// The Android app's wallet page (/wallet/ inside the app): the extension's service worker and
// panel in one document, on the chrome.* shim. See BRIDGE.md in the prl-hub-android repository.
import { setVersion } from "./shim.ts";
import { pearlHost } from "../../shared/android-host.ts";
import { nativeCall, installNativeHelpers } from "../../shared/android-bridge.ts";
import "./android.css";

// The wallet follows the app's light/dark choice and palette, not only the system's.
const host = pearlHost();
const applyAppearance = () => {
  const prefs = host?.prefs();
  document.documentElement.dataset.theme = prefs?.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.palette = prefs?.palette || "classic";
};
applyAppearance();
host?.subscribe(applyAppearance);
installNativeHelpers();

const info = await nativeCall<{ versionName: string }>("info").catch(() => null);
setVersion(info?.versionName || "");
await import("../background.ts");
await import("../main.tsx");
