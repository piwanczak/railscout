type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

export class BoundedTtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(private readonly maximumEntries: number) {
    if (!Number.isInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error("maximumEntries must be a positive integer");
    }
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }

    // Refresh insertion order so the oldest entry is the least recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMilliseconds: number): void {
    const now = Date.now();
    for (const [candidate, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(candidate);
    }

    this.entries.delete(key);
    while (this.entries.size >= this.maximumEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }

    this.entries.set(key, {
      expiresAt: now + ttlMilliseconds,
      value,
    });
  }
}
