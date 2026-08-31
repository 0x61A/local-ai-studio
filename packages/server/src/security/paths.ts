import fs from "node:fs";
import path from "node:path";

export class PathEscapeError extends Error {
  constructor(requested: string) {
    super(`Yol izin verilen kokun disinda: ${requested}`);
    this.name = "PathEscapeError";
  }
}

/**
 * Kullanicidan gelen HER yol buradan gecer. `path.join` dogrudan kullanilmaz.
 *
 * Iki asamali dogrulama yapar:
 *  1. Sozdizimsel: birlestirilmis yol normalize edildikten sonra kok icinde mi?
 *  2. Fizikselsel: hedef (ya da en yakin mevcut atasi) gercek yola cozuldugunde
 *     hala kok icinde mi? Bu, sembolik baglarla kacmayi engeller.
 */
export function resolveInside(root: string, requested: string): string {
  const realRoot = safeRealpath(path.resolve(root));
  const candidate = path.resolve(realRoot, stripLeadingSeparators(requested));

  if (!isInside(realRoot, candidate)) {
    throw new PathEscapeError(requested);
  }
  // Sembolik bag kontrolu: var olan en yakin ata uzerinden gercek yolu al.
  const resolved = path.resolve(
    safeRealpath(nearestExistingAncestor(candidate)),
    path.relative(nearestExistingAncestor(candidate), candidate),
  );
  if (!isInside(realRoot, resolved)) {
    throw new PathEscapeError(requested);
  }
  return resolved;
}

function stripLeadingSeparators(value: string): string {
  // "/etc/passwd" gibi mutlak gorunumlu girdiler koke gore yorumlanir.
  return value.replace(/^[/\\]+/, "");
}

function isInside(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function nearestExistingAncestor(target: string): string {
  let dir = target;
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
  return dir;
}

function safeRealpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}
