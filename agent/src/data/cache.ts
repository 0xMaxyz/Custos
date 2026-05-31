/**
 * Minimal in-memory TTL cache for ingestion reads. Keeps the agent from hammering
 * RPC/1delta within a single decision cycle. Single-process, no eviction beyond
 * TTL expiry — sufficient for the demo's read volume.
 */

interface Entry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export interface TtlCacheOptions {
  /** Default time-to-live in milliseconds for entries without an explicit ttl. */
  readonly defaultTtlMs: number;
  /** Clock injection for deterministic tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

export class TtlCache {
  private readonly store = new Map<string, Entry<unknown>>();
  private readonly defaultTtlMs: number;
  private readonly now: () => number;

  constructor(options: TtlCacheOptions) {
    this.defaultTtlMs = options.defaultTtlMs;
    this.now = options.now ?? Date.now;
  }

  /** Read a live (non-expired) value, or `undefined` if missing/expired. */
  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  /** Store a value with an optional per-entry ttl (falls back to defaultTtlMs). */
  set<T>(key: string, value: T, ttlMs?: number): void {
    const ttl = ttlMs ?? this.defaultTtlMs;
    this.store.set(key, { value, expiresAt: this.now() + ttl });
  }

  /**
   * Return the cached value, or compute it via `fn`, cache it, and return it.
   * Concurrent callers within the same tick share the in-flight promise so a
   * cache miss never fans out into duplicate upstream calls.
   */
  async getOrSet<T>(key: string, fn: () => Promise<T>, ttlMs?: number): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;

    const inflight = this.inflight.get(key);
    if (inflight !== undefined) return inflight as Promise<T>;

    const promise = fn()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  /** Drop a single key (e.g. to force a refresh). */
  delete(key: string): void {
    this.store.delete(key);
  }

  /** Clear all entries. */
  clear(): void {
    this.store.clear();
    this.inflight.clear();
  }

  private readonly inflight = new Map<string, Promise<unknown>>();
}
