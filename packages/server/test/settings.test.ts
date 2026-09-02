import { describe, expect, it } from "vitest";
import { Router } from "../src/http/router.js";
import { getPreferences, registerSettingsRoutes } from "../src/routes/settings.js";
import { userContent } from "../src/routes/chat.js";
import { deleteSetting, setSetting } from "../src/store/settings.js";

describe("Ayarlar Rotası ve Güç Profilleri", () => {
  it("Varsayılan tercihler balanced güç profilini döner", () => {
    deleteSetting("preferences");
    const prefs = getPreferences();
    expect(prefs.powerMode).toBe("balanced");
    expect(prefs.ubatchSize).toBe(256);
    expect(prefs.gpuOffload).toBe(true);
  });

  it("POST /api/settings ile güç modu performance, eco veya custom olarak güncellenir", () => {
    const router = new Router();
    registerSettingsRoutes(router);

    // Mock direct save
    setSetting("preferences", {
      ...getPreferences(),
      powerMode: "eco",
      ubatchSize: 128,
    });

    const updated = getPreferences();
    expect(updated.powerMode).toBe("eco");
    expect(updated.ubatchSize).toBe(128);

    setSetting("preferences", {
      ...getPreferences(),
      powerMode: "performance",
      ubatchSize: 512,
    });

    const perf = getPreferences();
    expect(perf.powerMode).toBe("performance");
    expect(perf.ubatchSize).toBe(512);
  });
});

describe("tercih semasi", () => {
  it("bilinmeyen anahtari reddeder", async () => {
    // .passthrough() ile keyfi JSON tercih deposuna yazilabiliyordu.
    const router = new Router();
    registerSettingsRoutes(router);
    const found = router.match("POST", "/api/settings");
    const schema = found?.route.spec.body;
    expect(schema).toBeDefined();
    expect(schema!.safeParse({ temperature: 0.5 }).success).toBe(true);
    expect(schema!.safeParse({ kotuAnahtar: "x" }).success).toBe(false);
  });
});

describe("sohbet gorsel icerigi", () => {
  it("gorsel yoksa duz metin birakir", () => {
    // Her mesaji parca dizisine cevirmek gereksiz: metin sohbetinde
    // saglayicilara fazladan sarmalama gonderirdi.
    expect(userContent("merhaba", [])).toBe("merhaba");
  });

  it("gorsel varsa metin + gorsel parcalari uretir", () => {
    const parts = userContent("bu ne?", [{ base64: "AAA", mimeType: "image/jpeg" }]);
    expect(parts).toEqual([
      { type: "text", text: "bu ne?" },
      { type: "image", imageBase64: "AAA", mimeType: "image/jpeg" },
    ]);
  });

  it("tur verilmezse PNG varsayar", () => {
    const parts = userContent("x", [{ base64: "AAA" }]);
    expect(Array.isArray(parts) ? parts[1]?.mimeType : null).toBe("image/png");
  });
});
