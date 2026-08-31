/**
 * Zaman uyumsuz olay kuyruğu.
 *
 * Ajan döngüsünde olayların kaynağı iki yerde: üretici akışı (dış döngü) ve
 * araçların içinden gelen onay istekleri (iç geri çağrı). Üretici bir async
 * generator olduğu için iç geri çağrıdan doğrudan `yield` edilemez; olaylar
 * bu kuyruğa yazılır, generator kuyruğu boşaltır.
 */
export class EventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Bekleyen tüketiciler serbest bırakılır.
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined as never, done: true });
    }
  }

  async *drain(): AsyncGenerator<T> {
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift() as T;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next.done) return;
      yield next.value;
    }
  }
}
