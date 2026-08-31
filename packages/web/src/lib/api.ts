import { TOKEN_FRAGMENT_KEY } from "@studio/shared/constants";
import type { SystemInfo, Telemetry, HealthStatus } from "@studio/shared";

const TOKEN_STORAGE_KEY = "studio.session-token";

/**
 * Token launcher tarafindan URL fragment'inda verilir (#t=...). Fragment
 * sunucuya gonderilmez, gecmise/loglara sizmasin diye okunur okunmaz
 * adres cubugundan temizlenir.
 */
function claimToken(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  const fromUrl = new URLSearchParams(hash).get(TOKEN_FRAGMENT_KEY);
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
    history.replaceState(null, "", window.location.pathname);
    return fromUrl;
  }
  return sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

let token = claimToken();

export function hasToken(): boolean {
  return token !== null;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");

  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    throw new ApiRequestError(
      res.status,
      payload?.error?.code ?? "unknown",
      payload?.error?.message ?? `HTTP ${res.status}`,
    );
  }
  return (await res.json()) as T;
}

export const api = {
  system: () => request<SystemInfo>("/api/system"),
  telemetry: () => request<Telemetry>("/api/telemetry"),
  health: () => request<HealthStatus>("/api/health"),
};
