import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Router, writeError } from "../src/http/router.js";
import { HttpError } from "../src/http/errors.js";
import { PathEscapeError } from "../src/security/paths.js";

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

describe("hata yazimi", () => {
  /** ServerResponse yerine yeterli olan asgari sahte nesne. */
  function fakeResponse() {
    const captured = { status: 0, body: "" };
    return {
      captured,
      res: {
        writableEnded: false,
        writeHead(status: number) {
          captured.status = status;
        },
        end(body: string) {
          captured.body = body;
        },
      } as unknown as import("node:http").ServerResponse,
    };
  }

  it("kok disina cikan yolu 403 yapar, 500 degil", () => {
    // Reddedilmis bir istek sunucu hatasi degildir; her dosya ucunun ayni
    // cevabi vermesi icin cevrim tek yerde.
    const { res, captured } = fakeResponse();
    writeError(res, new PathEscapeError("../../etc/passwd"));
    expect(captured.status).toBe(403);
    expect(JSON.parse(captured.body).error.code).toBe("path_escape");
  });

  it("bilinmeyen hatayi 500 yapar", () => {
    const { res, captured } = fakeResponse();
    writeError(res, new Error("beklenmeyen"));
    expect(captured.status).toBe(500);
    expect(JSON.parse(captured.body).error.code).toBe("internal_error");
  });

  it("HttpError'un kendi durumunu korur", () => {
    const { res, captured } = fakeResponse();
    writeError(res, HttpError.notFound("yok"));
    expect(captured.status).toBe(404);
  });
});
