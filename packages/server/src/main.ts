import { PREFERRED_PORT, SESSION_TOKEN, ensureDataDirs } from "./config.js";
import { HOST, startStudioServer } from "./app.js";

async function start(): Promise<void> {
  ensureDataDirs();
  const studio = await startStudioServer({ token: SESSION_TOKEN }, PREFERRED_PORT);

  const url = `http://${HOST}:${studio.port}/#t=${SESSION_TOKEN}`;
  // Launcher bu satiri stdout'tan okuyup tarayiciyi acar ve ekranda gostermez.
  console.log(`STUDIO_URL=${url}`);
  console.log(`  Local AI Studio  ->  http://${HOST}:${studio.port}`);
  console.log(`  Yalnizca ${HOST} dinleniyor. Ag uzerinden erisilemez.`);
  console.log(`  Durdurmak icin Ctrl+C.`);

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    console.log("\n  Kapatiliyor...");
    void studio.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((err) => {
  console.error("[main] baslatilamadi:", err);
  process.exit(1);
});
