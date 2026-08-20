import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      // Browser-safe entry: the full barrel drags in ssh2 and node builtins.
      "@sparktop/core": resolve(import.meta.dirname, "../core/src/client.ts"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:5757",
      "/ws": { target: "ws://127.0.0.1:5757", ws: true },
    },
  },
  build: {
    outDir: "dist",
    // Chunked so the chart library is cached independently of app code.
    rollupOptions: {
      output: {
        manualChunks: { uplot: ["uplot"], react: ["react", "react-dom"] },
      },
    },
  },
});
