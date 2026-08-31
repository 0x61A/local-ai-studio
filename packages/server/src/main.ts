import { PREFERRED_PORT, SESSION_TOKEN, ensureDataDirs } from "./config.js";
import { HOST, startStudioServer } from "./app.js";
import { reapOrphans } from "./engines/supervisor.js";
import { stopEmbedding } from "./engines/embedding.js";
import { stopLlama } from "./engines/llama.js";
import { stopSd } from "./engines/sd.js";
import { disconnectAll } from "./agent/mcp.js";

async function start(): Promise<void> {
  ensureDataDirs();
  // Önceki oturum çökmüşse motor süreçleri sahipsiz kalmış olabilir; bellek
  // tutmaya devam ederler. Yalnızca kendi ikili dosyamızı çalıştıranlar
  // toplanır (kimlik doğrulaması ps çıktısıyla yapılır).
  reapOrphans();

  const studio = await startStudioServer({ token: SESSION_TOKEN }, PREFERRED_PORT);

  const url = `http://${HOST}:${studio.port}/#t=${SESSION_TOKEN}`;
  // Launcher bu satırı stdout'tan okuyup tarayıcıyı açar ve ekranda göstermez.
  console.log(`STUDIO_URL=${url}`);
  console.log(`  Local AI Studio  ->  http://${HOST}:${studio.port}`);
  console.log(`  Yalnizca ${HOST} dinleniyor. Ag uzerinden erisilemez.`);
  console.log(`  Durdurmak icin Ctrl+C.`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log("\n  Kapatiliyor...");
    // Motor ve MCP süreçleri önce: aksi hâlde sahipsiz kalıp belleği
    // tutmaya devam ederler.
    await Promise.allSettled([
      stopLlama(),
      stopEmbedding(),
      stopSd(),
      disconnectAll(),
      studio.close(),
    ]);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  // Beklenmeyen çıkışta da çocukları bırakmamaya çalış.
  process.on("beforeExit", () => void shutdown());
}

start().catch((err) => {
  console.error("[main] baslatilamadi:", err);
  process.exit(1);
});
