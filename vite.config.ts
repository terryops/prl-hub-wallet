import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  // One React for every file. In the combined private source, shared/ is ../web/src with
  // its own node_modules; deduping keeps that build identical to this one.
  resolve: { dedupe: ["react", "react-dom"] },
  build: {
    rollupOptions: {
      input: { wallet: "index.html", background: "src/background.ts" },
      output: { entryFileNames: (chunk) => chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js" }
    }
  }
});
