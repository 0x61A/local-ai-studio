/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { App } from "../src/App";
import { useUi } from "../src/stores/ui";

/**
 * Render dumanı testleri.
 *
 * Tarayıcı açmadan yakaladıkları: içe aktarma döngüleri, modül düzeyinde
 * patlayan kod, eksik çeviri anahtarı, ilk boyamada çöken bileşen.
 * Bunlar tam da "derleniyor ama beyaz ekran" sınıfı hatalar.
 */

// vi.mock çağrısı dosyanın tepesine kaldırılır; fabrika kendi kendine
// yeterli olmalı, dışarıdaki değişkenlere dokunamaz.
vi.mock("../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/api")>(
    "../src/lib/api",
  );
  const empty = () => Promise.resolve([]);
  return {
    ...actual,
    hasToken: () => true,
    authHeaders: () => ({}),
    api: {
      system: () =>
        Promise.resolve({
          os: { platform: "darwin", release: "25.6.0", arch: "arm64" },
          cpu: { model: "Apple M4", physicalCores: 10, logicalCores: 10 },
          memory: { totalMb: 16384, freeMb: 7000 },
          gpu: {
            name: "Apple M4",
            vendor: "apple",
            vramTotalMb: 12288,
            accelerator: "Metal",
          },
          node: "v24.20.0",
          appVersion: "0.1.0",
        }),
      telemetry: () =>
        Promise.resolve({
          cpuUsagePercent: 12,
          memoryUsedMb: 9000,
          memoryTotalMb: 16384,
          vramUsedMb: 0,
          vramTotalMb: 12288,
          uptimeSeconds: 42,
        }),
      health: () =>
        Promise.resolve({ ok: true, version: "0.1.0", engines: {}, issues: [] }),
      models: () =>
        Promise.resolve({
          models: [],
          budget: { budgetMb: 6000, usedMb: 0, freeMb: 6000, unifiedMemory: true },
        }),
      engine: () => Promise.resolve(null),
      providers: empty,
      providerModels: () => Promise.resolve({ models: [], error: null }),
      conversations: empty,
      settings: () =>
        Promise.resolve({
          preferences: {
            defaultProvider: "llamacpp",
            defaultModel: "",
            systemPrompt: "",
            temperature: 0.7,
            maxTokens: 2048,
          },
        }),
      downloads: empty,
      search: empty,
    },
  };
});



beforeEach(() => {
  // localStorage bu ortamda yok (Node 26'nın deneysel yerleşiği
  // happy-dom'unkini gölgeliyor). Uygulama bunu zaten kaldırabilmeli --
  // lib/storage.ts sessizce boşa düşer. Test tam da o yolu doğruluyor.
  useUi.getState().setLanguage("tr");
});
afterEach(cleanup);

describe("uygulama kabuğu", () => {
  it("çökmeden render olur", () => {
    render(<App />);
    expect(screen.getByText("Local AI Studio")).toBeTruthy();
  });

  it("gezinme sekmelerini gösterir", () => {
    render(<App />);
    for (const label of ["Sohbet", "Modeller", "Ayarlar", "Sistem"]) {
      expect(screen.getAllByText(label).length, `eksik sekme: ${label}`).toBeGreaterThan(0);
    }
  });

  it("hazır olmayan sekmeleri devre dışı bırakır", () => {
    render(<App />);
    // Faz 4'ün ses yarısı hâlâ kapalı.
    for (const label of ["Ses"]) {
      const button = screen.getByText(label).closest("button");
      expect(button?.disabled, `açık kalmış sekme: ${label}`).toBe(true);
    }
  });

  it("hazır sekmeler tıklanabilir", () => {
    render(<App />);
    for (const label of ["Sohbet", "Ajan", "Modeller", "Bilgi tabanı", "Görsel", "Ayarlar"]) {
      const button = screen.getByText(label).closest("button");
      expect(button?.disabled, `kapalı kalmış sekme: ${label}`).toBe(false);
    }
  });

  it("çeviri anahtarı sızdırmaz", () => {
    // t() bulamadığı anahtarı olduğu gibi döner; ekranda "chat.send" gibi
    // ham bir anahtar görünüyorsa çeviri eksik demektir. Yalnızca bizim
    // ad alanlarımızı arıyoruz ki normal cümleler yanlış eşleşmesin.
    const { container } = render(<App />);
    const namespaces = ["app", "nav", "chat", "models", "settings", "system", "telemetry", "auth", "error", "common"];
    const pattern = new RegExp(`\\b(${namespaces.join("|")})\\.[a-z][a-zA-Z]*\\b`);
    const text = container.textContent ?? "";
    const leaked = pattern.exec(text);
    expect(leaked?.[0] ?? null, `çevrilmemiş anahtar: ${leaked?.[0]}`).toBeNull();
  });

  it("dil değiştirince arayüz İngilizceye döner", () => {
    render(<App />);
    useUi.getState().setLanguage("en");
    cleanup();
    render(<App />);
    expect(screen.getAllByText("Chat").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Models").length).toBeGreaterThan(0);
  });
});
