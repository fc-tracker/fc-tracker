import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [react()],

  // `npm run build:demo`: the overlay with sample data for the website (site/public/demo).
  ...(mode === "demo"
    ? { base: "/demo/", build: { outDir: "site/public/demo", emptyOutDir: true, rollupOptions: { input: "demo.html" } } }
    : {}),

  // `npm run build:web`: the browser version (fc-tracker.com/web) – the overlay fed by screen reading in the tab.
  ...(mode === "web"
    ? { base: "/web/", build: { outDir: "site/public/web", emptyOutDir: true, rollupOptions: { input: ["web.html", "dashboard.html"] } } }
    : {}),

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
