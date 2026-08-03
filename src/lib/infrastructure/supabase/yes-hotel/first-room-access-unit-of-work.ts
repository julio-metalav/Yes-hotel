import type { UnitOfWorkPort } from "../../../application/yes-hotel/first-room-access-ports";

/**
 * O client JS do Supabase NÃO oferece transação multi-statement entre tabelas.
 *
 * Atomicidade real:
 * - createTolerance → RPC `yes_hotel_create_access_tolerance` (tolerance + 3 itens)
 * - Demais passos (evento, correlação, outbox, markProcessed) permanecem
 *   chamadas separadas; se falharem após createTolerance, o orquestrador marca
 *   o evento como failed, mas a tolerância pode já existir (lacuna documentada).
 *
 * Este UoW apenas executa o callback; NÃO simula rollback multi-tabela.
 * Não usar múltiplos inserts independentes como se fossem transação.
 */
export class SupabasePassthroughUnitOfWork implements UnitOfWorkPort {
  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

export class SystemClock {
  now(): Date {
    return new Date();
  }
}
