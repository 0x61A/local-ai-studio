/**
 * Tarayıcı tarafı SSE okuyucu.
 *
 * `EventSource` kullanılmıyor: o yalnızca GET yapar ve özel başlık
 * gönderemez; bizim sohbet ucumuz POST ve oturum anahtarı istiyor.
 */
export interface StreamEvent {
  event: string;
  data: unknown;
}

export async function* postEventStream(
  url: string,
  body: unknown,
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): AsyncGenerator<StreamEvent> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: JSON.stringify(body),
    signal: init.signal ?? null,
  });

  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(payload?.error?.message ?? `HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseBlock(block);
      if (parsed) yield parsed;
      boundary = buffer.indexOf("\n\n");
    }
  }
}

function parseBlock(block: string): StreamEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return { event, data: dataLines.join("\n") };
  }
}
