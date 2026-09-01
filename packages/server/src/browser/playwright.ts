import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RUNTIME_DIR, setupCommand } from "../config.js";

/**
 * Playwright yükleyici.
 *
 * Playwright pakete gömülmez: yalnızca `playwright-core` ~2 MB ama yanında
 * indirdiği Chromium ~150 MB ve kullanıcıların çoğu tarayıcı otomasyonu
 * istemiyor. `scripts/setup/fetch.sh browser` isteyene kurar; kurulu
 * değilse araçlar listede görünür ama çağrıldığında nasıl kurulacağını söyler.
 *
 * Modül `runtime/` altından çalışma anında yüklenir. Bundler'ın statik
 * çözümlemesine takılmaması için tanımlayıcı bir değişkenden gelir --
 * doğrudan `import("playwright-core")` yazsaydık esbuild onu paketin içine
 * çekmeye çalışır ve derleme kurulu olmayan bir bağımlılıkta kırılırdı.
 */

const dynamicImport = new Function(
  "specifier",
  "return import(specifier)",
) as (specifier: string) => Promise<Record<string, unknown>>;

export const PLAYWRIGHT_DIR = path.join(RUNTIME_DIR, "engines", "playwright");
const ENTRY = path.join(PLAYWRIGHT_DIR, "node_modules", "playwright-core", "index.js");
const BROWSERS_DIR = path.join(PLAYWRIGHT_DIR, "browsers");

export const INSTALL_HINT =
  `Tarayıcı otomasyonu kurulu değil. \`${setupCommand("browser")}\` çalıştırın.`;

/** Playwright'ın ihtiyaç duyduğu asgari yüzey. Tam tipleri içe aktarmıyoruz
 *  çünkü paket derleme anında kurulu olmayabilir. */
export interface PwPage {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  evaluate<T>(fn: string, arg?: unknown): Promise<T>;
  click(selector: string, options?: Record<string, unknown>): Promise<void>;
  fill(selector: string, value: string, options?: Record<string, unknown>): Promise<void>;
  press(selector: string, key: string, options?: Record<string, unknown>): Promise<void>;
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
  route(pattern: string, handler: (route: PwRoute) => unknown): Promise<void>;
  waitForLoadState(state?: string, options?: Record<string, unknown>): Promise<void>;
  setDefaultTimeout(ms: number): void;
}

export interface PwRoute {
  request(): { url(): string; resourceType(): string };
  abort(reason?: string): Promise<void>;
  continue(): Promise<void>;
}

export interface PwBrowser {
  newPage(options?: Record<string, unknown>): Promise<PwPage>;
  close(): Promise<void>;
  isConnected(): boolean;
}

export interface PwLauncher {
  launch(options?: Record<string, unknown>): Promise<PwBrowser>;
}

export function playwrightInstalled(): boolean {
  return fs.existsSync(ENTRY) && fs.existsSync(BROWSERS_DIR);
}

export async function loadChromium(): Promise<PwLauncher> {
  if (!playwrightInstalled()) throw new Error(INSTALL_HINT);
  // Playwright tarayıcıyı bu değişkenle arar; sisteme kurulanı değil bizim
  // indirdiğimizi kullanmasını istiyoruz.
  process.env["PLAYWRIGHT_BROWSERS_PATH"] = BROWSERS_DIR;
  const module = await dynamicImport(pathToFileURL(ENTRY).href);
  const root = (module["default"] ?? module) as Record<string, unknown>;
  const chromium = root["chromium"] as PwLauncher | undefined;
  if (!chromium) throw new Error("playwright-core yüklendi ama chromium bulunamadı.");
  return chromium;
}
