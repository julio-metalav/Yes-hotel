/**
 * Quantas posições de hóspede faltam para cobrir a ocupação declarada pelo HITS.
 *
 * O HITS informa a ocupação em `rooms[].pax` (→ `SyncedReservation.totalGuests`)
 * mesmo quando só uma pessoa tem cadastro: reserva de 2 adultos com 1 PAX é o
 * caso comum. Sem completar, a segunda pessoa ficaria sem ficha.
 *
 * Função pura, isolada aqui só para ser testável fora do Deno.
 */

/** Teto defensivo: ocupação absurda vinda do PMS não vira dezenas de fichas. */
export const MAX_HOSPEDES_POR_RESERVA = 12;

export function calcularPosicoesFaltantes(
  totalDeclarado: unknown,
  hospedesAtivos: unknown,
): number {
  const bruto = Number(totalDeclarado);
  const declarado = Number.isFinite(bruto) ? Math.floor(bruto) : 1;
  const total = Math.min(MAX_HOSPEDES_POR_RESERVA, Math.max(1, declarado));
  const ativos = Math.max(0, Math.floor(Number(hospedesAtivos) || 0));
  // Nunca negativo: mais gente vinculada que o declarado não remove ninguém.
  return Math.max(0, total - ativos);
}
