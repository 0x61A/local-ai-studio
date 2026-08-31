// Sunucuyu tek bir CommonJS dosyasina paketler: dist/server.cjs
// Son kullanici hicbir sey build etmez; bu dosya surumle birlikte gelir.
import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [path.join(here, "src/main.ts")],
  outfile: path.join(here, "dist/server.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: true,
  minify: !process.argv.includes("--watch"),
  // node: yerlesikleri disarida birakilir, geri kalan her sey gomulur
  packages: "bundle",
  external: ["node:*"],
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("[build] izleniyor...");
} else {
  await build(options);
}
