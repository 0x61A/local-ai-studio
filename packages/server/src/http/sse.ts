import type { ServerResponse } from "node:http";

/** Sunucu tarafli olay akisi. Faz 1 sohbet stream'i ve faz 2 agent
 *  olaylari bunu kullanir. */
export class EventStream {
  private closed = false;

  constructor(private readonly res: ServerResponse) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    res.socket?.setNoDelay(true);
    res.flushHeaders?.();
    res.on("close", () => {
      this.closed = true;
    });
  }

  get isClosed(): boolean {
    return this.closed || this.res.writableEnded;
  }

  send(event: string, data: unknown): void {
    if (this.isClosed) return;
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  close(): void {
    if (this.res.writableEnded) return;
    this.res.end();
  }
}
