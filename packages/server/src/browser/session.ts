import fs from "node:fs";
import path from "node:path";
import { BROWSER_OUTPUTS_DIR } from "../config.js";
import { assertPublicUrl, FetchBlockedError } from "../search/fetch.js";
import { loadChromium, type PwBrowser, type PwPage } from "./playwright.js";

/**
 * Tarayıcı oturumu.
 *
 * Tek bir başsız Chromium; araç çağrıları arasında açık kalır ki oturum
 * (giriş yapılmış sayfa, alışveriş sepeti) adımlar boyunca korunsun.
 *
 * Adresin kaynağı model çıktısıdır, yani güvenilmez. `fetch_url`'deki SSRF
 * koruması burada da geçerli -- ama tek bir kontrol yetmez: sayfa kendi
 * içinden yüzlerce istek yapar ve içlerinden biri `169.254.169.254` olabilir.
 * Bu yüzden koruma tek adrese değil, sayfanın çıkardığı HER isteğe uygulanır.
 */

/** Ana bilgisayar adı başına bir kez çözümlenir; sayfa başına yüzlerce
 *  isteği tek tek DNS'e sormak sayfayı kullanılamaz hâle getirirdi. */
const hostVerdicts = new Map<string, boolean>();

const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;
const MAX_TEXT_CHARS = 8000;
const MAX_ELEMENTS = 80;

let browser: PwBrowser | null = null;
let page: PwPage | null = null;

export interface ElementRef {
  ref: number;
  role: string;
  name: string;
  value?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  elements: ElementRef[];
}

export function browserOpen(): boolean {
  return page !== null && browser?.isConnected() === true;
}

export async function getPage(): Promise<PwPage> {
  if (page && browser?.isConnected()) return page;

  const chromium = await loadChromium();
  browser = await chromium.launch({ headless: true });
  const created = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    // Varsayılan Playwright kimliği birçok sitede engellenir.
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  created.setDefaultTimeout(ACTION_TIMEOUT_MS);
  await created.route("**/*", guardRequest);
  page = created;
  return created;
}

export async function closeBrowser(): Promise<void> {
  const current = browser;
  browser = null;
  page = null;
  hostVerdicts.clear();
  await current?.close().catch(() => undefined);
}

/** Sayfanın çıkardığı her istek. Özel ağa gideni düşürür. */
async function guardRequest(route: {
  request(): { url(): string; resourceType(): string };
  abort(reason?: string): Promise<void>;
  continue(): Promise<void>;
}): Promise<void> {
  const target = route.request().url();
  if (await isRequestAllowed(target)) {
    await route.continue().catch(() => undefined);
    return;
  }
  await route.abort("blockedbyclient").catch(() => undefined);
}

/** Sayfanın çıkardığı tek bir isteğe verilen karar. Dışa açık: güvenlik
 *  kararını doğrudan sınayabilmek için. */
export async function isRequestAllowed(rawUrl: string): Promise<boolean> {
  let host: string;
  try {
    const url = new URL(rawUrl);
    // data: ve blob: sayfanın kendi ürettiği içerik; ağa çıkmaz.
    if (url.protocol === "data:" || url.protocol === "blob:") return true;
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    host = url.hostname.toLowerCase();
  } catch {
    return false;
  }

  const cached = hostVerdicts.get(host);
  if (cached !== undefined) return cached;

  const allowed = await assertPublicUrl(rawUrl).then(
    () => true,
    () => false,
  );
  hostVerdicts.set(host, allowed);
  return allowed;
}

export async function navigate(rawUrl: string): Promise<PageSnapshot> {
  // Adres çubuğuna girecek adres ayrıca ve açıkça kontrol edilir: istek
  // kancası sessizce düşürürdü, burada nedeni söyleyebiliyoruz.
  await assertPublicUrl(rawUrl);
  const current = await getPage();
  await current.goto(rawUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
  await current.waitForLoadState("load", { timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
  return snapshot();
}

/**
 * Sayfayı modele okunur hâle getirir.
 *
 * Etkileşimli öğelere numara verilir ve numara DOM'a yazılır; tıklama/yazma
 * araçları CSS seçici değil bu numarayı alır. Küçük bir modelden geçerli
 * seçici beklemek güvenilmezdi -- numara listesi ise sayfanın kendisinden
 * geliyor, uydurulamaz.
 */
export async function snapshot(): Promise<PageSnapshot> {
  const current = await getPage();
  const raw = await current.evaluate<{
    title: string;
    text: string;
    elements: ElementRef[];
  }>(snapshotScript(MAX_ELEMENTS));

  const text = raw.text.slice(0, MAX_TEXT_CHARS);
  return {
    url: current.url(),
    title: raw.title,
    text,
    truncated: raw.text.length > MAX_TEXT_CHARS,
    elements: raw.elements,
  };
}

export async function clickRef(ref: number): Promise<void> {
  const current = await getPage();
  try {
    await current.click(selectorFor(ref), { timeout: ACTION_TIMEOUT_MS });
  } catch (err) {
    // Playwright'ın "Timeout 15000ms exceeded" mesajı modele ne yapacağını
    // söylemiyor. Öğe kaymış ya da örtülmüş olabilir; çıkış yolu yeniden
    // okumak.
    if (/Timeout/i.test((err as Error).message)) {
      throw new Error(
        `${ref} numaralı öğe tıklanamadı (görünür değil ya da örtülmüş). ` +
          `browser_read ile listeyi yenile.`,
      );
    }
    throw err;
  }
  // Tıklama gezinme başlatmış olabilir; başlamadıysa beklemek boşuna sürmesin.
  await current.waitForLoadState("load", { timeout: 5000 }).catch(() => undefined);
}

export async function typeRef(ref: number, value: string, submit: boolean): Promise<void> {
  const current = await getPage();
  const selector = selectorFor(ref);
  // Parola alanina yazmak kapida onaylansa bile yapilmaz: onay kartinda
  // gorunen metin kullanicinin kendi parolasi olurdu ve ajanin elinde
  // dogru parola zaten yok -- uydurdugunu girmek hesabi kilitler.
  const isPassword = await current.evaluate<boolean>(
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      return Boolean(node && node.tagName === 'INPUT' && node.type === 'password');
    })()`,
  );
  if (isPassword) {
    throw new Error("Parola alanina yazilamaz. Bu alani kullanici kendisi doldurmali.");
  }
  await current.fill(selector, value, { timeout: ACTION_TIMEOUT_MS });
  if (submit) {
    await current.press(selector, "Enter", { timeout: ACTION_TIMEOUT_MS });
    await current.waitForLoadState("load", { timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
  }
}

export async function screenshot(): Promise<{ filename: string; bytes: number }> {
  const current = await getPage();
  const buffer = await current.screenshot({ type: "png", fullPage: false });
  fs.mkdirSync(BROWSER_OUTPUTS_DIR, { recursive: true });
  const filename = `shot-${Date.now()}.png`;
  fs.writeFileSync(path.join(BROWSER_OUTPUTS_DIR, filename), buffer);
  return { filename, bytes: buffer.length };
}

export function selectorFor(ref: number): string {
  return `[data-studio-ref="${ref}"]`;
}

/** Modele verilecek metin. Sayfa içeriği güvenilmez, öyle etiketlenir. */
export function describeSnapshot(snap: PageSnapshot): string {
  const elements = snap.elements
    .map((element) => {
      const value = element.value ? ` = "${element.value}"` : "";
      return `[${element.ref}] ${element.role}: ${element.name}${value}`;
    })
    .join("\n");

  return [
    `Adres: ${snap.url}`,
    `Başlık: ${snap.title}`,
    "",
    "Etkileşimli öğeler (numarayı browser_click/browser_type ile kullan):",
    elements || "(yok)",
    "",
    "--- güvenilmez sayfa içeriği başlangıcı ---",
    snap.text + (snap.truncated ? "\n… (kesildi)" : ""),
    "--- güvenilmez sayfa içeriği sonu ---",
  ].join("\n");
}

export { FetchBlockedError };

/**
 * Sayfa içinde çalışır. Görünür etkileşimli öğelere `data-studio-ref` yazar
 * ve numaralı listesini döner.
 *
 * Kaynak metin olarak geçirilir çünkü bundler bu fonksiyonu tarayıcıya değil
 * sunucuya derlerdi. Metin de kendi kendini çağıran bir ifade olmak zorunda:
 * `evaluate` bir dizgeyi ifade olarak değerlendirir, fonksiyon dizgesine
 * argüman geçirmez -- öyle yazınca sonuç sessizce `undefined` gelir.
 */
function snapshotScript(max: number): string {
  return `(() => {
  const selector = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [contenteditable="true"]';
  const nodes = Array.from(document.querySelectorAll(selector));
  const elements = [];
  let ref = 0;

  for (const node of nodes) {
    if (elements.length >= ${max}) break;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    if (Number(style.opacity) === 0) continue;
    // Ekran okuyucu icin gizlenmis ogeler ("iceriğe atla" gibi) 1x1 kutuyla
    // ekran disinda durur ve clip ile kirpilir. Kutu > 0 demek yetmiyordu:
    // listeye giriyor, model tikliyor, tiklama zaman asimina dusuyordu.
    if (rect.width < 4 || rect.height < 4) continue;
    if (rect.right <= 0 || rect.bottom <= 0) continue;
    if (style.clip !== 'auto' && style.clip !== '') continue;
    if (node.disabled === true) continue;

    ref += 1;
    node.setAttribute('data-studio-ref', String(ref));

    const tag = node.tagName.toLowerCase();
    const role =
      node.getAttribute('role') ||
      (tag === 'a' ? 'link' : tag === 'input' ? (node.type || 'input') : tag);
    // Gorsel baglantilarin metni yok. Adsiz birakmak modele hangi ogeye
    // tiklayacagini sectirmez; alt metnine ve adresin son parcasina duseriz.
    const image = node.querySelector ? node.querySelector('img[alt]') : null;
    const href = node.getAttribute('href') || '';
    const name = (
      node.getAttribute('aria-label') ||
      node.getAttribute('placeholder') ||
      node.getAttribute('name') ||
      node.getAttribute('title') ||
      (node.innerText || node.value || '') ||
      (image ? image.getAttribute('alt') : '') ||
      href.split(/[/?#]/).filter(Boolean).pop() || ''
    ).replace(/\\s+/g, ' ').trim().slice(0, 80);

    const entry = { ref, role, name: name || '(adsız)' };
    if (tag === 'input' && node.type !== 'password' && node.value) {
      entry.value = String(node.value).slice(0, 60);
    }
    elements.push(entry);
  }

  return {
    title: document.title || '',
    text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim(),
    elements,
  };
})()`;
}
