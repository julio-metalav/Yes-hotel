/**
 * Cache curto da listagem de reservas.
 *
 * Existe por uma razão concreta: o HITS responde
 * `429 Too many calls for same reservation page 1` quando a mesma página é
 * consultada em sequência. F5 repetido na tela operacional derrubava a leitura.
 *
 * Só a listagem (GET) é cacheada. Nada de escrita, nada de erro.
 */

import type { HitsReservationSearchParams } from "../../../src/lib/integrations/hits/types.ts";

/**
 * Janela em que a entrada é servida direto, sem tocar no HITS.
 *
 * 120s e não 30s: os logs do HOMO mostram a HITS recusando a mesma página com
 * `Too many calls for same reservation page 1` já aos 31s do último 200. O TTL
 * curto fazia o gateway bater dentro da janela em que a HITS ainda recusa.
 * Custo aceito: uma alteração no HITS pode levar até 2min para refletir.
 */
export const RESERVATION_CACHE_TTL_MS = 120_000;
/** Além do TTL, ainda utilizável como stale — apenas quando o HITS responde 429. */
export const RESERVATION_CACHE_STALE_MS = 600_000;
/** Teto de chaves distintas; evita crescer sem limite com janelas variadas. */
export const RESERVATION_CACHE_MAX_ENTRIES = 64;

export type ReservationCacheEntry = {
  body: unknown;
  storedAt: number;
};

export type ReservationCacheLookup =
  | { state: "miss" }
  | { state: "fresh"; body: unknown; ageMs: number }
  | { state: "stale"; body: unknown; ageMs: number };

/**
 * Chave estável: mesmos filtros → mesma chave, independentemente da ordem em
 * que vieram na querystring. Params já passaram pela allowlist de `query.ts`.
 */
export function reservationCacheKey(params: HitsReservationSearchParams): string {
  return JSON.stringify([
    params.type ?? null,
    params.status ?? null,
    params.initialDate ?? null,
    params.finalDate ?? null,
    params.page ?? null,
    params.size ?? null,
    params.reservationIntegrationId ?? null,
  ]);
}

export class ReservationListCache {
  private readonly entries = new Map<string, ReservationCacheEntry>();
  private readonly ttlMs: number;
  private readonly staleMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(
    options: {
      ttlMs?: number;
      staleMs?: number;
      maxEntries?: number;
      now?: () => number;
    } = {},
  ) {
    this.ttlMs = options.ttlMs ?? RESERVATION_CACHE_TTL_MS;
    this.staleMs = options.staleMs ?? RESERVATION_CACHE_STALE_MS;
    this.maxEntries = options.maxEntries ?? RESERVATION_CACHE_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * `fresh` dentro do TTL; `stale` entre TTL e janela stale (só o chamador
   * decide usá-la, e apenas em 429); `miss` fora disso.
   */
  lookup(key: string): ReservationCacheLookup {
    const entry = this.entries.get(key);
    if (!entry) return { state: "miss" };

    const ageMs = this.now() - entry.storedAt;
    if (ageMs < 0) {
      // Relógio andou para trás: trata como ausente em vez de servir algo incerto.
      this.entries.delete(key);
      return { state: "miss" };
    }
    if (ageMs < this.ttlMs) {
      return { state: "fresh", body: entry.body, ageMs };
    }
    if (ageMs < this.staleMs) {
      return { state: "stale", body: entry.body, ageMs };
    }
    this.entries.delete(key);
    return { state: "miss" };
  }

  /** Só chamado com resposta 200 do HITS. */
  set(key: string, body: unknown): void {
    // Reinserir move a chave para o fim da ordem de iteração do Map.
    this.entries.delete(key);
    this.entries.set(key, { body, storedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
