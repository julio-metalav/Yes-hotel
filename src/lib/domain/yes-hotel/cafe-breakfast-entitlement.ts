/**
 * Classificação de direito ao café.
 *
 * BLOQUEIO DE MAPEAMENTO HITS (não inventar):
 * - Café incluído: existe apenas `rooms[].mealPlanDesc` (string livre, ex. "Cafe da manha"
 *   em fixtures/hits-real-sample-detail.json). Não há boolean/enum homologado no sync.
 * - Café avulso pago + quantidade: NÃO encontrado em tipos, fixtures, contrato tipado
 *   nem projeção operacional (`requirementReservation[]` / `chargeTags[]` opacos).
 *
 * Até homologação explícita desses campos, o resolvedor retorna `nao_mapeado`.
 * Regras de atendimento para incluido/sem_cafe/avulso_pago existem na policy e
 * aceitam classificação já resolvida (testes / futura homologação).
 */

export type CafeBreakfastKind =
  | "incluido"
  | "sem_cafe"
  | "avulso_pago"
  | "nao_mapeado";

export type CafeBreakfastEntitlement = {
  kind: CafeBreakfastKind;
  /** Quantidade com direito (incluído ou avulsos pagos). 0 se sem café / não mapeado. */
  entitledQty: number;
  /** Quantidade de hóspedes da reserva (HITS pax / totalGuests). */
  guestCount: number;
  /** Quantidade avulsa paga confirmada pelo HITS (quando kind=avulso_pago). */
  paidExtraQty: number;
  /** Texto bruto persistido — somente informativo. */
  mealPlanDesc: string | null;
  /** Motivo quando kind=nao_mapeado. */
  mappingGapReason: string | null;
};

export const CAFE_BREAKFAST_MAPPING_GAP =
  "HITS não homologou campo seguro para café incluído / café avulso pago. " +
  "Candidato bruto: rooms[].mealPlanDesc (string). Avulso/quantidade paga: ausente.";

/**
 * Resolvedor seguro atual: NÃO interpreta mealPlanDesc como incluído/excluído
 * e NÃO inventa avulso pago.
 */
export function resolveCafeBreakfastEntitlementFromHits(input: {
  guestCount: number;
  mealPlanDesc?: string | null;
  /** Reservado para futura quantidade avulsa oficial do HITS. */
  paidExtraQtyFromHits?: number | null;
}): CafeBreakfastEntitlement {
  const guestCount = Math.max(0, Number(input.guestCount) || 0);
  const mealPlanDesc =
    input.mealPlanDesc == null ? null : String(input.mealPlanDesc).trim() || null;

  return {
    kind: "nao_mapeado",
    entitledQty: 0,
    guestCount,
    paidExtraQty: 0,
    mealPlanDesc,
    mappingGapReason: CAFE_BREAKFAST_MAPPING_GAP,
  };
}

/**
 * Constrói entitlement já classificado (somente para testes / futura camada
 * homologada). Não usar com heurística inventada sobre mealPlanDesc.
 */
export function buildCafeBreakfastEntitlement(input: {
  kind: Exclude<CafeBreakfastKind, "nao_mapeado">;
  guestCount: number;
  paidExtraQty?: number;
  mealPlanDesc?: string | null;
}): CafeBreakfastEntitlement {
  const guestCount = Math.max(0, Number(input.guestCount) || 0);
  const paidExtraQty = Math.max(0, Number(input.paidExtraQty) || 0);

  if (input.kind === "incluido") {
    return {
      kind: "incluido",
      entitledQty: guestCount,
      guestCount,
      paidExtraQty: 0,
      mealPlanDesc: input.mealPlanDesc ?? null,
      mappingGapReason: null,
    };
  }

  if (input.kind === "avulso_pago") {
    return {
      kind: "avulso_pago",
      entitledQty: paidExtraQty,
      guestCount,
      paidExtraQty,
      mealPlanDesc: input.mealPlanDesc ?? null,
      mappingGapReason: null,
    };
  }

  return {
    kind: "sem_cafe",
    entitledQty: 0,
    guestCount,
    paidExtraQty: 0,
    mealPlanDesc: input.mealPlanDesc ?? null,
    mappingGapReason: null,
  };
}
