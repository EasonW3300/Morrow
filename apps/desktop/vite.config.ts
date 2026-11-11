import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri devUrl 固定 1420（tauri.conf.json），strictPort 防漂移
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "chrome105",
    outDir: "dist",
  },
});
