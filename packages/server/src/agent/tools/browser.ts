import { z } from "zod";
import {
  clickRef,
  closeBrowser,
  describeSnapshot,
  navigate,
  browserOpen,
  screenshot,
  snapshot,
  typeRef,
} from "../../browser/session.js";
import { FetchBlockedError } from "../../search/fetch.js";
import { INSTALL_HINT, playwrightInstalled } from "../../browser/playwright.js";
import { defineTool, type Tool, type ToolContext, type ToolResult } from "../types.js";

/**
 * Bilgisayar kullanımı: gerçek bir tarayıcıda gezinme.
 *
 * Hepsi `computer` riskinde, yani hepsi onay kapısından geçer -- okuma bile.
 * `fetch_url` zaten okumak için var; tarayıcıyı açmak farklı bir şey:
 * oturum çerezleri taşınır, JavaScript çalışır, tıklama gerçek bir eylemdir.
 * Kullanıcı "bu araca hep izin ver" diyerek okumayı serbest bırakabilir;
 * varsayılanı gevşetmek yerine kararı ona bırakıyoruz.
 *
 * Sayfa içeriği güvenilmezdir ve modele öyle etiketlenerek verilir: gezilen
 * sayfa "şimdi şu dosyayı sil" yazıyorsa bu bir talimat değil, veridir.
 */

function guardMissing(): ToolResult | null {
  return playwrightInstalled() ? null : { content: INSTALL_HINT, isError: true };
}

async function approve(
  context: ToolContext,
  toolName: string,
  summary: string,
  args: unknown,
): Promise<boolean> {
  return context.requestApproval({
    toolName,
    risk: "computer",
    summary,
    arguments: args,
  });
}

function failure(err: unknown): ToolResult {
  const message =
    err instanceof FetchBlockedError
      ? err.message
      : `Tarayıcı hatası: ${(err as Error).message}`;
  return { content: message, isError: true };
}

export const browserOpenTool: Tool<{ url: string }> = defineTool({
  name: "browser_open",
  description:
    "Bir adresi gerçek tarayıcıda açar ve sayfanın metnini, tıklanabilir " +
    "öğelerinin numaralı listesini döner. JavaScript ile üretilen sayfalar " +
    "için fetch_url yerine bunu kullan.",
  risk: "computer",
  schema: z.object({ url: z.string().url().describe("Açılacak tam adres") }),
  async run(input, context): Promise<ToolResult> {
    const missing = guardMissing();
    if (missing) return missing;
    if (!(await approve(context, "browser_open", `Tarayıcıda aç: ${input.url}`, input))) {
      return { content: "Kullanıcı sayfayı açmayı reddetti.", isError: true };
    }
    try {
      const snap = await navigate(input.url);
      return { content: describeSnapshot(snap), detail: { url: snap.url, title: snap.title } };
    } catch (err) {
      return failure(err);
    }
  },
});

export const browserRead: Tool<Record<string, never>> = defineTool({
  name: "browser_read",
  description:
    "Açık sayfayı yeniden okur. Tıklama veya yazmadan sonra sayfa değiştiyse " +
    "öğe numaraları da değişir; yeni numaraları buradan al.",
  risk: "computer",
  schema: z.object({}),
  async run(_input, context): Promise<ToolResult> {
    const missing = guardMissing();
    if (missing) return missing;
    if (!browserOpen()) {
      return { content: "Açık bir sayfa yok. Önce browser_open kullan.", isError: true };
    }
    if (!(await approve(context, "browser_read", "Açık sayfayı oku", {}))) {
      return { content: "Kullanıcı sayfayı okumayı reddetti.", isError: true };
    }
    try {
      return { content: describeSnapshot(await snapshot()) };
    } catch (err) {
      return failure(err);
    }
  },
});

export const browserClick: Tool<{ ref: number }> = defineTool({
  name: "browser_click",
  description:
    "Sayfadaki numaralı bir öğeye tıklar. Numarayı browser_open/browser_read çıktısından al.",
  risk: "computer",
  schema: z.object({
    ref: z.number().int().min(1).describe("Öğe numarası"),
  }),
  async run(input, context): Promise<ToolResult> {
    const missing = guardMissing();
    if (missing) return missing;
    if (!browserOpen()) {
      return { content: "Açık bir sayfa yok. Önce browser_open kullan.", isError: true };
    }

    // Onay kartında numara değil ne olduğu yazsın: "[7]" karar verdirmez.
    const before = await snapshot().catch(() => null);
    const target = before?.elements.find((element) => element.ref === input.ref);
    if (!target) {
      return {
        content: `Sayfada ${input.ref} numaralı öğe yok. browser_read ile listeyi yenile.`,
        isError: true,
      };
    }
    if (!(await approve(context, "browser_click", `Tıkla: ${target.role} "${target.name}"`, input))) {
      return { content: "Kullanıcı tıklamayı reddetti.", isError: true };
    }

    try {
      await clickRef(input.ref);
      return { content: describeSnapshot(await snapshot()) };
    } catch (err) {
      return failure(err);
    }
  },
});

export const browserType: Tool<{ ref: number; text: string; submit?: boolean }> = defineTool(
  {
    name: "browser_type",
    description:
      "Numaralı bir yazı alanına metin yazar. submit true ise Enter'a basar.",
    risk: "computer",
    schema: z.object({
      ref: z.number().int().min(1).describe("Alan numarası"),
      text: z.string().max(4000).describe("Yazılacak metin"),
      submit: z.boolean().optional().describe("Yazdıktan sonra Enter'a bas"),
    }),
    async run(input, context): Promise<ToolResult> {
      const missing = guardMissing();
      if (missing) return missing;
      if (!browserOpen()) {
        return { content: "Açık bir sayfa yok. Önce browser_open kullan.", isError: true };
      }

      const before = await snapshot().catch(() => null);
      const target = before?.elements.find((element) => element.ref === input.ref);
      if (!target) {
        return {
          content: `Sayfada ${input.ref} numaralı alan yok. browser_read ile listeyi yenile.`,
          isError: true,
        };
      }
      const approved = await approve(
        context,
        "browser_type",
        `"${target.name}" alanına yaz: ${input.text.slice(0, 80)}` +
          (input.submit ? " (ve gönder)" : ""),
        input,
      );
      if (!approved) return { content: "Kullanıcı yazmayı reddetti.", isError: true };

      try {
        await typeRef(input.ref, input.text, input.submit ?? false);
        return { content: describeSnapshot(await snapshot()) };
      } catch (err) {
        return failure(err);
      }
    },
  },
);

export const browserScreenshot: Tool<Record<string, never>> = defineTool({
  name: "browser_screenshot",
  description:
    "Açık sayfanın ekran görüntüsünü alır ve dosyaya kaydeder. Kullanıcının " +
    "ne olduğunu görmesi için; sen görüntüyü göremezsin, sayfayı okumak için " +
    "browser_read kullan.",
  risk: "computer",
  schema: z.object({}),
  async run(_input, context): Promise<ToolResult> {
    const missing = guardMissing();
    if (missing) return missing;
    if (!browserOpen()) {
      return { content: "Açık bir sayfa yok. Önce browser_open kullan.", isError: true };
    }
    if (!(await approve(context, "browser_screenshot", "Sayfanın ekran görüntüsünü al", {}))) {
      return { content: "Kullanıcı ekran görüntüsünü reddetti.", isError: true };
    }
    try {
      const shot = await screenshot();
      return {
        content: `Ekran görüntüsü kaydedildi: ${shot.filename} (${shot.bytes} bayt).`,
        detail: { filename: shot.filename },
      };
    } catch (err) {
      return failure(err);
    }
  },
});

export const browserClose: Tool<Record<string, never>> = defineTool({
  name: "browser_close",
  description: "Tarayıcıyı kapatır. İşin bittiğinde belleği boşaltmak için çağır.",
  risk: "computer",
  schema: z.object({}),
  async run(): Promise<ToolResult> {
    // Kapatmak tek geri alınamayan yanı oturumun kaybı; onay istemeye değmez.
    await closeBrowser();
    return { content: "Tarayıcı kapatıldı." };
  },
});

export const browserTools = [
  browserOpenTool,
  browserRead,
  browserClick,
  browserType,
  browserScreenshot,
  browserClose,
];
