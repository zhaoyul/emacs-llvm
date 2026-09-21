export type Clock = () => number;

export class IdempotencyCache<T> {
  private readonly values = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly maxEntries = 1000,
    private readonly now: Clock = Date.now
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("ttlMs must be > 0");
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new RangeError("maxEntries must be a positive integer");
  }

  private pruneExpired(now: number): void {
    for (const [key, entry] of this.values) {
      if (now >= entry.expiresAt) this.values.delete(key);
    }
  }

  get(key: string): T | undefined {
    const hit = this.values.get(key);
    if (!hit) return undefined;
    if (this.now() >= hit.expiresAt) {
      this.values.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    const now = this.now();
    this.pruneExpired(now);

    // Updating a key refreshes its expiry and insertion order without evicting an
    // unrelated entry simply because the cache happened to be at capacity.
    if (this.values.has(key)) this.values.delete(key);

    while (this.values.size >= this.maxEntries) {
      const first = this.values.keys().next().value as string | undefined;
      if (first === undefined) break;
      this.values.delete(first);
    }
    this.values.set(key, { value, expiresAt: now + this.ttlMs });
  }
}
