import { describe, expect, it, vi } from "vitest";
import {
  browserClick,
  browserOpenTool,
  browserRead,
  browserScreenshot,
  browserTools,
  browserType,
} from "../src/agent/tools/browser.js";
import { INSTALL_HINT } from "../src/browser/playwright.js";
import {
  describeSnapshot,
  isRequestAllowed,
  selectorFor,
  type PageSnapshot,
} from "../src/browser/session.js";
import { builtinTools } from "../src/agent/registry.js";
import type { ToolContext } from "../src/agent/types.js";

// Kurulum durumu makineden makineye değişir; testin sonucu ona bağlı olmasın.
// Kurulu-değil dalı böylece her yerde gerçekten çalışır.
vi.mock("../src/browser/playwright.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/browser/playwright.js")>()),
  playwrightInstalled: () => false,
}));

function context(approve = true): ToolContext & { asked: string[] } {
  const asked: string[] = [];
  return {
    workspaceRoot: "/tmp",
    signal: new AbortController().signal,
    asked,
    requestApproval: async (request) => {
      asked.push(request.summary);
      return approve;
    },
  };
}

const snapshot: PageSnapshot = {
  url: "https://ornek.test/ara",
  title: "Örnek",
  text: "Sayfa gövdesi.",
  truncated: false,
  elements: [
    { ref: 1, role: "search", name: "Arama kutusu", value: "kedi" },
    { ref: 2, role: "button", name: "Ara" },
  ],
};

describe("tarayıcı seçicisi", () => {
  it("numaradan öznitelik seçicisi üretir", () => {
    expect(selectorFor(7)).toBe('[data-studio-ref="7"]');
  });
});

describe("sayfa özeti", () => {
  it("öğeleri numaralı listeler ve değeri gösterir", () => {
    const described = describeSnapshot(snapshot);
    expect(described).toContain("[1] search: Arama kutusu = \"kedi\"");
    expect(described).toContain("[2] button: Ara");
  });

  it("sayfa içeriğini güvenilmez diye etiketler", () => {
    // Gezilen sayfa modele talimat veremesin: içerik veri olarak sarmalanır.
    const described = describeSnapshot(snapshot);
    expect(described).toContain("--- güvenilmez sayfa içeriği başlangıcı ---");
    expect(described).toContain("--- güvenilmez sayfa içeriği sonu ---");
    expect(described.indexOf("başlangıcı")).toBeLessThan(described.indexOf("Sayfa gövdesi"));
  });

  it("kesilen metni belirtir", () => {
    expect(describeSnapshot({ ...snapshot, truncated: true })).toContain("… (kesildi)");
  });

  it("öğe yoksa boş bırakmaz", () => {
    expect(describeSnapshot({ ...snapshot, elements: [] })).toContain("(yok)");
  });
});

describe("tarayıcı araçları", () => {
  it("hepsi computer riskinde", () => {
    // Plan kararı: tarayıcıdaki her eylem onay kapısından geçer, okuma dahil.
    expect(browserTools.every((tool) => tool.risk === "computer")).toBe(true);
  });

  it("araç kaydına eklenmiş", () => {
    const names = builtinTools().map((tool) => tool.name);
    for (const tool of browserTools) expect(names).toContain(tool.name);
  });

  it("kurulu değilse nasıl kurulacağını söyler, çökmez", async () => {
    const result = await browserOpenTool.run(
      { url: "https://ornek.test" },
      context(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe(INSTALL_HINT);
  });

  it("kurulu değilken onay bile istemez", async () => {
    const ctx = context();
    await browserOpenTool.run({ url: "https://ornek.test" }, ctx);
    await browserRead.run({}, ctx);
    await browserClick.run({ ref: 1 }, ctx);
    await browserType.run({ ref: 1, text: "x" }, ctx);
    await browserScreenshot.run({}, ctx);
    // Yapılamayacak bir iş için kullanıcıyı onay sormaya uyandırmak gürültü.
    expect(ctx.asked).toEqual([]);
  });

});

describe("tarayıcı SSRF koruması", () => {
  it("özel ağ adreslerini düşürür", async () => {
    // Sayfa kendi içinden istek çıkarır; biri bulut metadata ucu olabilir.
    expect(await isRequestAllowed("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(await isRequestAllowed("http://127.0.0.1:7420/api/settings")).toBe(false);
    expect(await isRequestAllowed("http://10.0.0.5/")).toBe(false);
    expect(await isRequestAllowed("http://localhost/")).toBe(false);
  });

  it("http/https dışındaki şemaları düşürür", async () => {
    expect(await isRequestAllowed("file:///etc/passwd")).toBe(false);
    expect(await isRequestAllowed("ftp://ornek.test/x")).toBe(false);
    expect(await isRequestAllowed("bozuk-adres")).toBe(false);
  });

  it("sayfanın kendi ürettiği içeriğe izin verir", async () => {
    // data: ve blob: ağa çıkmaz; engellemek sayfayı bozardı.
    expect(await isRequestAllowed("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(await isRequestAllowed("blob:https://ornek.test/abc")).toBe(true);
  });
});

describe("tarayıcı araç şemaları", () => {
  it("browser_open geçerli adres ister", () => {
    expect(browserOpenTool.schema.safeParse({ url: "degil-bir-adres" }).success).toBe(false);
    expect(browserOpenTool.schema.safeParse({ url: "https://ornek.test" }).success).toBe(true);
  });

  it("browser_click pozitif tam sayı ister", () => {
    expect(browserClick.schema.safeParse({ ref: 0 }).success).toBe(false);
    expect(browserClick.schema.safeParse({ ref: 1.5 }).success).toBe(false);
    expect(browserClick.schema.safeParse({ ref: 3 }).success).toBe(true);
  });

  it("browser_type gönderme bayrağı isteğe bağlı", () => {
    expect(browserType.schema.safeParse({ ref: 1, text: "merhaba" }).success).toBe(true);
    expect(
      browserType.schema.safeParse({ ref: 1, text: "merhaba", submit: true }).success,
    ).toBe(true);
  });
});
