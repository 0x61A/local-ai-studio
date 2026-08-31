import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SERVER_PORT = Number(process.env["STUDIO_PORT"] ?? 7420);

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5273,
    strictPort: true,
    // Gelistirmede API istekleri gercek sunucuya gider.
    proxy: { "/api": { target: `http://127.0.0.1:${SERVER_PORT}` } },
  },
});
