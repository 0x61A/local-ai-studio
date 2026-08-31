import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Router } from "../src/http/router.js";

describe("Router.match", () => {
  const router = new Router()
    .get("/api/models", {}, () => [])
    .get("/api/models/:id", {}, ({ params }) => params)
    .post("/api/chat", { body: z.object({ text: z.string() }) }, () => null);

  it("tam yolu eslestirir", () => {
    expect(router.match("GET", "/api/models")).not.toBeNull();
  });

  it("parametreli yolu cozer", () => {
    const found = router.match("GET", "/api/models/qwen-7b.gguf");
    expect(found?.params["id"]).toBe("qwen-7b.gguf");
  });

  it("yanlis metotta eslesmez", () => {
    expect(router.match("POST", "/api/models")).toBeNull();
  });

  it("uzunlugu farkli yolda eslesmez", () => {
    expect(router.match("GET", "/api/models/a/b")).toBeNull();
  });

  it("bilinmeyen yolda null doner", () => {
    expect(router.match("GET", "/api/yok")).toBeNull();
  });
});
