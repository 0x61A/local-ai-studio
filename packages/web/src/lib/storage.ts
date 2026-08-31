/**
 * Güvenli tarayıcı deposu erişimi.
 *
 * `localStorage` her ortamda kullanılabilir değildir ve erişimin kendisi
 * istisna atabilir: site verisi engellenmiş tarayıcılar, gizli sekme
 * kısıtlamaları, gömülü görünümler. Doğrudan çağrı yapmak uygulamanın
 * ilk boyamada beyaz ekrana düşmesi demektir -- bu yüzden her okuma ve
 * yazma buradan geçer.
 */

function store(kind: "local" | "session"): Storage | null {
  try {
    const candidate = kind === "local" ? globalThis.localStorage : globalThis.sessionStorage;
    if (!candidate) return null;
    // Bazı ortamlarda nesne var ama erişim atıyor; bir kez deneriz.
    const probe = "__studio_probe__";
    candidate.setItem(probe, "1");
    candidate.removeItem(probe);
    return candidate;
  } catch {
    return null;
  }
}

export function readLocal(key: string): string | null {
  try {
    return store("local")?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeLocal(key: string, value: string): void {
  try {
    store("local")?.setItem(key, value);
  } catch {
    // Kalıcılık kaybolur; oturum içi durum yine de çalışır.
  }
}

export function readSession(key: string): string | null {
  try {
    return store("session")?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeSession(key: string, value: string): void {
  try {
    store("session")?.setItem(key, value);
  } catch {
    // Yoksayılır: oturum anahtarı bellekte tutulmaya devam eder.
  }
}
