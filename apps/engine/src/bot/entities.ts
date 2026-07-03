/**
 * Cached team/player name dictionary for the deterministic prefilter.
 * Rebuilt from the fixtures/players tables on a TTL — the prefilter must be
 * cheap enough to run on every group message.
 */

import type { EngineDb, EntityHints } from '../ports.js';
import { ENGINE } from '../engineConstants.js';

export class EntityCache {
  private cached: EntityHints = { teamNames: [], playerNames: [] };
  private fetchedAtMs = -Infinity;
  private inflight: Promise<EntityHints> | null = null;

  constructor(
    private readonly db: EngineDb,
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = ENGINE.ENTITY_CACHE_TTL_MS,
  ) {}

  async get(): Promise<EntityHints> {
    if (this.now() - this.fetchedAtMs < this.ttlMs) return this.cached;
    this.inflight ??= this.db
      .entityNames()
      .then((names) => {
        this.cached = names;
        this.fetchedAtMs = this.now();
        return names;
      })
      .catch(() => this.cached)
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}
