import http from "node:http";
import net from "node:net";
import { WEB_DIST } from "./config.js";
import { assertAuthorized, assertSameOrigin } from "./http/auth.js";
import { HttpError } from "./http/errors.js";
import { Router, isPublicRoute, writeError } from "./http/router.js";
import { serveStatic } from "./http/static.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { registerAudioRoutes } from "./routes/audio.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerImageRoutes } from "./routes/images.js";
import { registerKnowledgeRoutes } from "./routes/knowledge.js";
import { registerModelRoutes } from "./routes/models.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerSystemRoutes } from "./routes/system.js";

/** Asla degistirilmez. Eski projedeki S1 (0.0.0.0 bind) acikliginin karsiligi. */
export const HOST = "127.0.0.1";

export interface StudioServerOptions {
  token: string;
  /** Statik kabugun okunacagi dizin. Testler bunu gecersiz kilar. */
  webDist?: string;
}

export interface StudioServer {
  readonly server: http.Server;
  readonly port: number;
  close(): Promise<void>;
}

export function buildRouter(): Router {
  const router = new Router();
  registerSystemRoutes(router);
  registerSettingsRoutes(router);
  registerConversationRoutes(router);
  registerModelRoutes(router);
  registerChatRoutes(router);
  registerAgentRoutes(router);
  registerKnowledgeRoutes(router);
  registerImageRoutes(router);
  registerAudioRoutes(router);
  return router;
}

export function createHandler(
  options: StudioServerOptions,
  getPort: () => number,
) {
  const router = buildRouter();
  const webDist = options.webDist ?? WEB_DIST;

  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const port = getPort();
    try {
      const url = new URL(req.url ?? "/", `http://${HOST}:${port}`);

      const handled = await router.dispatch(req, res, url, (route) => {
        if (isPublicRoute(route)) {
          assertSameOrigin(req, port);
        } else {
          assertAuthorized(req, options.token, port);
        }
      });
      if (handled) return;

      if (url.pathname.startsWith("/api/")) {
        throw HttpError.notFound("Bilinmeyen API ucu.");
      }

      // Statik kabuk token istemez: token URL fragment'inda gelir ve
      // sunucuya hic gonderilmez. Kabuk veri icermez.
      assertSameOrigin(req, port);
      await serveStatic(res, webDist, url.pathname);
    } catch (err) {
      writeError(res, err);
    }
  };
}

export async function startStudioServer(
  options: StudioServerOptions,
  preferredPort: number,
): Promise<StudioServer> {
  const port = await findFreePort(preferredPort);
  const server = http.createServer(createHandler(options, () => port));
  // Model yukleme/indirme uzun surer; soket zaman asimi kapatilir.
  server.timeout = 0;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export async function findFreePort(preferred: number, attempts = 20): Promise<number> {
  for (let port = preferred; port < preferred + attempts; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(
    `Bos port bulunamadi (${preferred}-${preferred + attempts - 1} denendi).`,
  );
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => tester.close(() => resolve(true)))
      .listen(port, HOST);
  });
}
