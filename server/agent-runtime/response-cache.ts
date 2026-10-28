// Response cache: LRU cache for identical model requests. Keyed by a hash of
// (messages + tools + model + params). Skips streaming requests (or caches
// the final result). Reduces cost and latency for repeated identical turns.

export interface CacheEntry<T> {
  readonly value: T;
  readonly createdAt: number;
  readonly ttlMs: number;
}

export interface ResponseCacheOptions {
  readonly maxSize: number;
  readonly defaultTtlMs: number;
}

export function createResponseCache<T>(options: ResponseCacheOptions) {
  const store = new Map<string, CacheEntry<T>>();

  function evictIfNeeded(): void {
    if (store.size < options.maxSize) return;
    // Evict oldest entry (Map preserves insertion order).
    const firstKey = store.keys().next().value;
    if (firstKey !== undefined) store.delete(firstKey);
  }

  return {
    get(key: string): T | undefined {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() - entry.createdAt > entry.ttlMs) {
        store.delete(key);
        return undefined;
      }
      // Move to end (LRU refresh).
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },
    set(key: string, value: T, ttlMs?: number): void {
      evictIfNeeded();
      store.set(key, { value, createdAt: Date.now(), ttlMs: ttlMs ?? options.defaultTtlMs });
    },
    has(key: string): boolean {
      return this.get(key) !== undefined;
    },
    delete(key: string): boolean {
      return store.delete(key);
    },
    clear(): void {
      store.clear();
    },
    get size(): number {
      return store.size;
    },
  };
}

export function cacheKey(input: {
  readonly model: string;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>;
  readonly tools: ReadonlyArray<{ readonly name?: string; readonly id?: string }>;
}): string {
  const parts = [
    input.model,
    JSON.stringify(input.messages.map((m) => ({ r: m.role, c: m.content }))),
    JSON.stringify(input.tools.map((t) => t.name ?? t.id ?? "")),
  ];
  return parts.join("::");
}