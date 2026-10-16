import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  // One React for every file, shared/ included.
  resolve: { dedupe: ["react", "react-dom"] },
  // Android-only branches (__PEARL_ANDROID__) fold away; vite.android.config.ts sets it to true.
  define: { __PEARL_ANDROID__: "false" },
  build: {
    rollupOptions: {
      input: { wallet: "index.html", background: "src/background.ts" },
      output: { entryFileNames: (chunk) => chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js" }
    }
  }
});
