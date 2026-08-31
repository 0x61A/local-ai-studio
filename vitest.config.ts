import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

const shared = path.resolve(import.meta.dirname, "packages/shared/src");

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Sıra önemli: takma adlar önek eşlemesiyle çözülür, bu yüzden daha
    // uzun ("/constants") olan önce gelmeli.
    alias: [
      { find: "@studio/shared/constants", replacement: path.join(shared, "constants.ts") },
      { find: "@studio/shared", replacement: path.join(shared, "index.ts") },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "packages/*/test/**/*.test.tsx"],
  },
});
