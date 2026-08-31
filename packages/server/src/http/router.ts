import type { IncomingMessage, ServerResponse } from "node:http";
import type { ZodType } from "zod";
import { PathEscapeError } from "../security/paths.js";
import { HttpError } from "./errors.js";

export interface RequestContext<B = unknown, Q = unknown> {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly body: B;
  readonly query: Q;
  readonly params: Readonly<Record<string, string>>;
  readonly url: URL;
}

/** Handler bir deger dondururse JSON olarak yazilir. `undefined` donerse
 *  yaniti kendisi yazmis sayilir (SSE, dosya akisi vb.). */
export type Handler<B, Q> = (
  ctx: RequestContext<B, Q>,
) => Promise<unknown> | unknown;

export interface RouteSpec<B, Q> {
  body?: ZodType<B>;
  query?: ZodType<Q>;
  /** Oturum token'i aranmaz. Sadece istisnai uclar icin. */
  public?: boolean;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface Route {
  method: Method;
  segments: string[];
  spec: RouteSpec<unknown, unknown>;
  handler: Handler<unknown, unknown>;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024;

export class Router {
  private readonly routes: Route[] = [];

  add<B = undefined, Q = undefined>(
    method: Method,
    pattern: string,
    spec: RouteSpec<B, Q>,
    handler: Handler<B, Q>,
  ): this {
    this.routes.push({
      method,
      segments: splitPath(pattern),
      spec: spec as RouteSpec<unknown, unknown>,
      handler: handler as Handler<unknown, unknown>,
    });
    return this;
  }

  get<Q = undefined>(p: string, s: RouteSpec<undefined, Q>, h: Handler<undefined, Q>) {
    return this.add("GET", p, s, h);
  }
  post<B = undefined, Q = undefined>(p: string, s: RouteSpec<B, Q>, h: Handler<B, Q>) {
    return this.add("POST", p, s, h);
  }
  del<Q = undefined>(p: string, s: RouteSpec<undefined, Q>, h: Handler<undefined, Q>) {
    return this.add("DELETE", p, s, h);
  }

  match(method: string, pathname: string) {
    const segments = splitPath(pathname);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchSegments(route.segments, segments);
      if (params) return { route, params };
    }
    return null;
  }

  /**
   * Eslesen rotayi calistirir. Eslesme yoksa null doner; cagiran taraf
   * statik dosyaya duser.
   */
  async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    authorize: (route: Route) => void,
  ): Promise<boolean> {
    const found = this.match(req.method ?? "GET", url.pathname);
    if (!found) return false;

    const { route, params } = found;
    authorize(route);

    const body = route.spec.body
      ? parseOrThrow(route.spec.body, await readJsonBody(req), "body")
      : undefined;
    const query = route.spec.query
      ? parseOrThrow(
          route.spec.query,
          Object.fromEntries(url.searchParams),
          "query",
        )
      : undefined;

    const result = await route.handler({ req, res, body, query, params, url });
    if (result !== undefined && !res.writableEnded) {
      writeJson(res, 200, result);
    }
    return true;
  }
}

export function isPublicRoute(route: { spec: RouteSpec<unknown, unknown> }) {
  return route.spec.public === true;
}

function splitPath(value: string): string[] {
  return value.split("/").filter(Boolean);
}

function matchSegments(
  pattern: string[],
  actual: string[],
): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const p = pattern[i] as string;
    const a = actual[i] as string;
    if (p.startsWith(":")) {
      params[p.slice(1)] = decodeURIComponent(a);
    } else if (p !== a) {
      return null;
    }
  }
  return params;
}

function parseOrThrow<T>(schema: ZodType<T>, value: unknown, where: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw HttpError.badRequest(
      "invalid_request",
      `Gecersiz istek ${where}'si.`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw HttpError.badRequest("body_too_large", "Istek govdesi cok buyuk.");
    }
    chunks.push(buf);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw HttpError.badRequest("invalid_json", "Istek govdesi gecerli JSON degil.");
  }
}

export function writeJson(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    // Bilerek CORS basligi YOK. Bkz. http/auth.ts
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

export function writeError(res: ServerResponse, err: unknown) {
  // Kok disina cikan yol bir sunucu hatasi degil, reddedilmis bir istektir.
  // Tek tek rotalarda yakalamak yerine burada ceviririz: dosyaya dokunan her
  // uc ayni cevabi versin ve deneme her seferinde gunluge yigilmasin.
  const normalized =
    err instanceof PathEscapeError
      ? HttpError.forbidden("path_escape", "Gecersiz dosya yolu.")
      : err;

  const http =
    normalized instanceof HttpError
      ? normalized
      : new HttpError(500, "internal_error", "Beklenmeyen sunucu hatasi.");
  if (!(normalized instanceof HttpError)) {
    console.error("[http] islenmeyen hata:", err);
  }
  if (res.writableEnded) return;
  writeJson(res, http.status, {
    error: { code: http.code, message: http.message, details: http.details },
  });
}
