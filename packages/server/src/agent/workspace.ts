import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSetting, setSetting } from "../store/settings.js";

/**
 * Ajanın çalışma alanı.
 *
 * Tüm dosya araçları bu kökün içine kilitlidir. Kök seçilmeden dosya
 * araçları çalışmaz -- varsayılan olarak ev dizinini vermek, "dosyamı oku"
 * diyen bir istemin tüm diski gezebilmesi demek olurdu.
 */

const SETTING_KEY = "agent.workspace";

/** Kök olarak seçilmesi kabul edilmeyen dizinler. */
const FORBIDDEN = new Set(
  [
    "/",
    os.homedir(),
    "/Users",
    "/System",
    "/Library",
    "/etc",
    "/var",
    "/usr",
    "/bin",
    "/sbin",
    "/private",
  ].map((entry) => path.resolve(entry)),
);

export class WorkspaceError extends Error {}

export function getWorkspace(): string | null {
  const stored = getSetting<string | null>(SETTING_KEY, null);
  if (!stored) return null;
  // Klasör silinmiş olabilir; yoksa seçilmemiş sayılır.
  return isUsableDirectory(stored) ? realPath(stored) : null;
}

export function setWorkspace(requested: string): string {
  // Gerçek yola çevrilir. macOS'ta /tmp -> /private/tmp gibi sembolik bağlar
  // var; kökü ham hâlde saklarsak resolveInside() gerçek yolu döndürdüğü
  // için göreli yol hesabı "../../private/tmp/..." gibi çıkar ve onay
  // kartında kaçış denemesi gibi görünürdü.
  const resolved = realPath(path.resolve(expandHome(requested.trim())));

  if (!isUsableDirectory(resolved)) {
    throw new WorkspaceError(`Klasör bulunamadı veya okunamıyor: ${resolved}`);
  }
  if (FORBIDDEN.has(resolved)) {
    throw new WorkspaceError(
      `Bu klasör çalışma alanı olarak seçilemez: ${resolved}. ` +
        `Ajanın erişimini belirli bir proje klasörüyle sınırlayın.`,
    );
  }
  // Ev dizininin doğrudan altındaki geniş klasörler de fazla açık.
  const home = path.resolve(os.homedir());
  if (path.dirname(resolved) === home && isBroadHomeFolder(path.basename(resolved))) {
    throw new WorkspaceError(
      `"${path.basename(resolved)}" çok geniş bir alan. Onun içindeki belirli bir ` +
        `proje klasörünü seçin.`,
    );
  }

  setSetting(SETTING_KEY, resolved);
  return resolved;
}

export function clearWorkspace(): void {
  setSetting(SETTING_KEY, null);
}

export function requireWorkspace(): string {
  const workspace = getWorkspace();
  if (!workspace) {
    throw new WorkspaceError(
      "Çalışma alanı seçilmedi. Ajan sekmesinden bir proje klasörü seçin.",
    );
  }
  return workspace;
}

function isBroadHomeFolder(name: string): boolean {
  return ["Documents", "Desktop", "Downloads", "Library", "Movies", "Music", "Pictures"]
    .includes(name);
}

function expandHome(target: string): string {
  return target.startsWith("~") ? path.join(os.homedir(), target.slice(1)) : target;
}

/** Sembolik bağları çözer; çözemezse girdiyi olduğu gibi döner. */
function realPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

function isUsableDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
