import { defineConfig } from "vite";
import { touchHover } from "./scripts/touch-hover.mjs";
import { oldWebViewCss } from "./scripts/old-webview-css.mjs";
// The wallet inside the Android app: served at https://pearlhub.net/wallet/ from the APK.
// web/scripts/build-android.mjs in prl-hub-web copies dist-android/ into the app bundle.
export default defineConfig({
  base: "/wallet/",
  publicDir: false,
  resolve: { dedupe: ["react", "react-dom"] },
  define: { __PEARL_ANDROID__: "true" },
  // Touch screens: hover styles show only while pressed (scripts/touch-hover.mjs). What cssTarget can't lower
  // for an old WebView gets a fallback (scripts/old-webview-css.mjs).
  css: { postcss: { plugins: [touchHover(), oldWebViewCss()] } },
  build: {
    // The phone's System WebView can be old (no Play updates); the default target's `@media (width<=640px)`
    // is dropped before Chrome 104. Same target as prl-hub-web's Android build (ANDROID_WEBVIEW there).
    target: "chrome82",
    cssTarget: "chrome82",
    outDir: "dist-android",
    emptyOutDir: true,
    rollupOptions: { input: { wallet: "android.html" } },
  },
});
