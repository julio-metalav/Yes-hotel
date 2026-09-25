/**
 * Classificação de direito ao café.
 *
 * Café incluído / sem café: HOMOLOGADO a partir de `rooms[].mealPlanDesc` por
 * lista fechada de valores reais do HITS (ver `cafe-meal-plan.ts`). Valor fora
 * da lista, nulo ou vazio → `nao_mapeado` (a tela mostra NÃO IDENTIFICADO);
 * ausência de informação nunca vira "sem café".
 *
 * Café avulso pago + quantidade: continua SEM campo homologado no HITS
 * (`requirementReservation[]` / `chargeTags[]` seguem opacos). Só entra por
 * quantidade oficial informada ao resolvedor — nunca inferida de texto.
 */

import { classifyMealPlanDesc } from "./cafe-meal-plan.ts";

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
  "mealPlanDesc fora da lista homologada do HITS (ver cafe-meal-plan.ts). " +
  "Sem classificação segura: tratado como NÃO IDENTIFICADO, com direito 0.";

/**
 * Resolvedor oficial: classifica pelo `mealPlanDesc` homologado e conta o
 * direito pela população declarada pelo HITS. Não interpreta texto livre e não
 * inventa avulso pago — avulso só com quantidade oficial no input.
 */
export function resolveCafeBreakfastEntitlementFromHits(input: {
  guestCount: number;
  mealPlanDesc?: string | null;
  /** Quantidade avulsa oficial do HITS (hoje sempre ausente/0). */
  paidExtraQtyFromHits?: number | null;
}): CafeBreakfastEntitlement {
  const guestCount = Math.max(0, Number(input.guestCount) || 0);
  const mealPlanDesc =
    input.mealPlanDesc == null ? null : String(input.mealPlanDesc).trim() || null;
  const paidExtraQty = Math.max(0, Number(input.paidExtraQtyFromHits) || 0);
  const plano = classifyMealPlanDesc(mealPlanDesc);

  if (plano === "incluido") {
    return {
      kind: "incluido",
      entitledQty: guestCount,
      guestCount,
      paidExtraQty: 0,
      mealPlanDesc,
      mappingGapReason: null,
    };
  }

  // Avulso pago só existe com quantidade oficial; independe do plano do quarto.
  if (paidExtraQty > 0) {
    return {
      kind: "avulso_pago",
      entitledQty: paidExtraQty,
      guestCount,
      paidExtraQty,
      mealPlanDesc,
      mappingGapReason: null,
    };
  }

  if (plano === "sem_cafe") {
    return {
      kind: "sem_cafe",
      entitledQty: 0,
      guestCount,
      paidExtraQty: 0,
      mealPlanDesc,
      mappingGapReason: null,
    };
  }

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
