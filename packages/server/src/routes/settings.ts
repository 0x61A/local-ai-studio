import { z } from "zod";
import { HttpError } from "../http/errors.js";
import type { Router } from "../http/router.js";
import { PROVIDERS, listProviderDescriptors } from "../providers/registry.js";
import { PROVIDER_IDS, type ProviderId } from "../providers/types.js";
import { deleteSecret, describeSecret, setSecret } from "../security/secrets.js";
import { getSetting, setSetting } from "../store/settings.js";

const SecretBody = z.object({
  provider: z.enum(PROVIDER_IDS),
  apiKey: z.string().min(1).max(500),
});

export const POWER_MODES = ["performance", "balanced", "eco", "custom"] as const;
export type PowerMode = (typeof POWER_MODES)[number];

const PreferencesBody = z
  .object({
    defaultProvider: z.enum(PROVIDER_IDS).optional(),
    defaultModel: z.string().max(200).optional(),
    systemPrompt: z.string().max(8000).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(200_000).optional(),
    powerMode: z.enum(POWER_MODES).optional(),
    cpuThreads: z.number().int().min(0).max(128).optional(),
    ubatchSize: z.number().int().min(32).max(1024).optional(),
    gpuOffload: z.boolean().optional(),
  })
  // .passthrough() YOK: bilinmeyen anahtarlar duserilir. Aksi halde
  // tercih deposuna keyfi JSON yazilabilirdi ve `Required<Preferences>`
  // dizin imzasi kazanip her alani `unknown` yapardi.
  .strict();
export type Preferences = z.infer<typeof PreferencesBody>;

const DEFAULT_PREFERENCES: Required<Preferences> = {
  defaultProvider: "llamacpp",
  defaultModel: "",
  systemPrompt: "",
  temperature: 0.7,
  maxTokens: 2048,
  powerMode: "balanced",
  cpuThreads: 0,
  ubatchSize: 256,
  gpuOffload: true,
};

export function getPreferences(): Required<Preferences> {
  return { ...DEFAULT_PREFERENCES, ...getSetting<Preferences>("preferences", {}) };
}

export function registerSettingsRoutes(router: Router): void {
  /** Sağlayıcı listesi. Anahtarın kendisi ASLA dönmez, yalnızca maskesi. */
  router.get("/api/providers", {}, () =>
    listProviderDescriptors().map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.label,
      capabilities: descriptor.capabilities,
      keyUrl: descriptor.keyUrl,
      hasKey: descriptor.hasKey,
      maskedKey: descriptor.secretName
        ? (describeSecret(descriptor.secretName)?.masked ?? null)
        : null,
    })),
  );

  router.post("/api/providers/key", { body: SecretBody }, ({ body }) => {
    const descriptor = PROVIDERS[body.provider as ProviderId];
    if (!descriptor.secretName) {
      throw HttpError.badRequest(
        "no_key_needed",
        `${descriptor.label} API anahtarı istemiyor.`,
      );
    }
    const info = setSecret(descriptor.secretName, body.apiKey);
    return { ok: true, provider: body.provider, masked: info.masked };
  });

  router.del("/api/providers/:id/key", {}, ({ params }) => {
    const id = params["id"] as ProviderId;
    const descriptor = PROVIDERS[id];
    if (!descriptor) throw HttpError.notFound("Bilinmeyen sağlayıcı.");
    if (descriptor.secretName) deleteSecret(descriptor.secretName);
    return { ok: true };
  });

  /** Hugging Face anahtarı sağlayıcı değil; kapılı depolar için ayrı tutulur. */
  router.post(
    "/api/settings/huggingface-key",
    { body: z.object({ apiKey: z.string().min(1).max(500) }) },
    ({ body }) => ({ ok: true, masked: setSecret("huggingface", body.apiKey).masked }),
  );

  router.get("/api/settings", {}, () => ({
    preferences: getPreferences(),
    huggingFace: describeSecret("huggingface"),
  }));

  router.post("/api/settings", { body: PreferencesBody }, ({ body }) => {
    const merged = { ...getPreferences(), ...body };
    setSetting("preferences", merged);
    return { ok: true, preferences: merged };
  });
}
