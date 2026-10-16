import { defineConfig } from "vite";
// The wallet inside the Android app: served at https://pearlhub.net/wallet/ from the APK.
// web/scripts/build-android.mjs in prl-hub-web copies dist-android/ into the app bundle.
export default defineConfig({
  base: "/wallet/",
  publicDir: false,
  resolve: { dedupe: ["react", "react-dom"] },
  define: { __PEARL_ANDROID__: "true" },
  build: {
    outDir: "dist-android",
    emptyOutDir: true,
    rollupOptions: { input: { wallet: "android.html" } },
  },
});
