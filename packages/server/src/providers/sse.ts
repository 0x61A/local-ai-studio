/**
 * Artımlı Server-Sent Events ayrıştırıcısı.
 *
 * Ağdan gelen parçalar olay sınırlarına saygı duymaz: tek bir `data:` satırı
 * iki TCP parçasına bölünebilir, bir parça da birden çok olay taşıyabilir.
 * Bu yüzden ayrıştırma tampon üzerinden yürür, parça başına değil.
 *
 * Saf yapı olarak yazılır (girdi: metin parçaları) -- ağ olmadan test edilir.
 */

export interface SseEvent {
  /** `event:` alanı; verilmemişse "message". */
  event: string;
  /** Birden çok `data:` satırı satır sonuyla birleştirilir (SSE şartnamesi). */
  data: string;
  id?: string;
}

export class SseParser {
  private buffer = "";

  /** Parçayı yutar, tamamlanan olayları döner. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];

    // Olaylar boş satırla ayrılır. \r\n, \n ve \r hepsi kabul edilir.
    const separator = /\r\n\r\n|\n\n|\r\r/;
    let match: RegExpExecArray | null;
    while ((match = separator.exec(this.buffer)) !== null) {
      const raw = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const parsed = parseBlock(raw);
      if (parsed) events.push(parsed);
    }
    return events;
  }

  /** Akış bittiğinde tamponda kalan yarım olayı verir. */
  flush(): SseEvent[] {
    const rest = this.buffer;
    this.buffer = "";
    const parsed = rest.trim() ? parseBlock(rest) : null;
    return parsed ? [parsed] : [];
  }
}

function parseBlock(block: string): SseEvent | null {
  const dataLines: string[] = [];
  let event = "message";
  let id: string | undefined;

  for (const line of block.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(":")) continue; // yorum satırı / keepalive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // Şartname: iki noktadan sonraki tek boşluk atılır.
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") dataLines.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
  }

  if (dataLines.length === 0 && event === "message") return null;
  return id === undefined
    ? { event, data: dataLines.join("\n") }
    : { event, data: dataLines.join("\n"), id };
}

/**
 * `fetch` yanıt gövdesini SSE olaylarına çevirir.
 * UTF-8 çok baytlı karakterler parça sınırında bölünebilir; TextDecoder
 * `stream: true` ile bunu doğru birleştirir.
 */
export async function* readSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = new SseParser();

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        yield event;
      }
    }
    for (const event of parser.push(decoder.decode())) yield event;
    for (const event of parser.flush()) yield event;
  } finally {
    reader.releaseLock();
  }
}
