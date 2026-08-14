'use strict';

/**
 * Tiny in-memory TTL cache for JSON-serializable results.
 * One global instance per call key (coalesce burst reads of the same resource).
 */
class TTLCache {
  constructor() {
    this.store = new Map(); // key -> { value, expiresAt }
  }

  get(key) {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key, value, ttlMs) {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    // Opportunistic GC: if map grows large, drop expired entries.
    if (this.store.size > 500) this.gc();
  }

  gc() {
    const now = Date.now();
    for (const [k, e] of this.store) {
      if (e.expiresAt < now) this.store.delete(k);
    }
  }

  /**
   * Coalesce: if a fetch for `key` is in flight, return the same promise.
   * Otherwise call `loader()`, store its result under `key` for `ttlMs`, and
   * return it. On error, do not cache.
   */
  async getOrLoad(key, ttlMs, loader) {
    const cached = this.get(key);
    if (cached !== undefined) {
      return { value: cached, hit: true };
    }
    if (this.store.has(key + ':pending')) {
      const v = await this.store.get(key + ':pending').promise;
      return { value: v, hit: true };
    }
    let resolveOuter, rejectOuter;
    const pending = new Promise((res, rej) => { resolveOuter = res; rejectOuter = rej; });
    this.store.set(key + ':pending', { promise: pending });
    try {
      const value = await loader();
      this.set(key, value, ttlMs);
      resolveOuter(value);
      return { value, hit: false };
    } catch (e) {
      rejectOuter(e);
      throw e;
    } finally {
      this.store.delete(key + ':pending');
    }
  }
}

const singleton = new TTLCache();
module.exports = { TTLCache, cache: singleton };
