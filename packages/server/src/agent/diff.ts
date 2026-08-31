/**
 * Küçük birleşik fark üreteci.
 *
 * Onay kartında "ne değişecek" göstermek için yeterli. Tam bir diff
 * kütüphanesi (Myers algoritması) getirmek yerine ortak önek/sonek kırpıp
 * arada kalanı gösteriyoruz: onay ekranında okunması gereken şey zaten
 * değişen bölge.
 */

const CONTEXT_LINES = 3;
const MAX_LINES = 200;

export function unifiedDiff(before: string, after: string, filename: string): string {
  if (before === after) return `${filename}: değişiklik yok`;

  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  // Ortak önek
  let start = 0;
  while (
    start < beforeLines.length &&
    start < afterLines.length &&
    beforeLines[start] === afterLines[start]
  ) {
    start += 1;
  }

  // Ortak sonek
  let endBefore = beforeLines.length - 1;
  let endAfter = afterLines.length - 1;
  while (
    endBefore >= start &&
    endAfter >= start &&
    beforeLines[endBefore] === afterLines[endAfter]
  ) {
    endBefore -= 1;
    endAfter -= 1;
  }

  const from = Math.max(0, start - CONTEXT_LINES);
  const lines: string[] = [
    `--- ${filename}`,
    `+++ ${filename}`,
    `@@ -${start + 1},${endBefore - start + 1} +${start + 1},${endAfter - start + 1} @@`,
  ];

  for (let index = from; index < start; index += 1) {
    lines.push(` ${beforeLines[index] ?? ""}`);
  }
  for (let index = start; index <= endBefore; index += 1) {
    lines.push(`-${beforeLines[index] ?? ""}`);
  }
  for (let index = start; index <= endAfter; index += 1) {
    lines.push(`+${afterLines[index] ?? ""}`);
  }
  for (
    let index = endBefore + 1;
    index < Math.min(beforeLines.length, endBefore + 1 + CONTEXT_LINES);
    index += 1
  ) {
    lines.push(` ${beforeLines[index] ?? ""}`);
  }

  if (lines.length > MAX_LINES) {
    return [
      ...lines.slice(0, MAX_LINES),
      `… (${lines.length - MAX_LINES} satır daha)`,
    ].join("\n");
  }
  return lines.join("\n");
}

/** Yeni dosya için "tamamı eklendi" görünümü. */
export function newFileDiff(content: string, filename: string): string {
  const lines = content.split("\n");
  const shown = lines.slice(0, MAX_LINES).map((line) => `+${line}`);
  if (lines.length > MAX_LINES) {
    shown.push(`… (${lines.length - MAX_LINES} satır daha)`);
  }
  return [`--- /dev/null`, `+++ ${filename}`, ...shown].join("\n");
}
