import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "onnxruntime-web/webgpu": "onnxruntime-web/wasm" } },
  worker: { format: "es" },
  build: { outDir: "dist" },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/feeds": "http://127.0.0.1:8787",
    },
  },
});
