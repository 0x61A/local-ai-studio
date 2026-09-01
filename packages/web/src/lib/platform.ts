/**
 * Kurulum komutlarini kullanicinin isletim sistemine gore yazar.
 *
 * Sunucu her zaman kullanicinin kendi makinesinde calisiyor (127.0.0.1),
 * dolayisiyla tarayicinin gordugu isletim sistemi sunucununkiyle ayni.
 * Sistem bilgisini bunun icin ta arayuzun dibine kadar tasimak gereksiz.
 */
export function setupCommand(component: string): string {
  const agent = globalThis.navigator?.userAgent ?? "";
  return /windows/i.test(agent)
    ? `powershell -ExecutionPolicy Bypass -File scripts\\setup\\fetch.ps1 ${component}`
    : `bash scripts/setup/fetch.sh ${component}`;
}
