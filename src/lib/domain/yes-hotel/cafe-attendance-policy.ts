/**
 * Regras puras de atendimento do café (limites, KPIs, mark-all, permissões).
 * Sem I/O.
 */

import type { CafeBreakfastEntitlement } from "./cafe-breakfast-entitlement.ts";
import { canRegisterCafeAttendanceForDate } from "./cafe-operational-date.ts";

export type CafeWritableRole = "cafe" | "recepcao" | "admin";

export type CafeCardModel = {
  reservationId: string;
  apartmentCode: string;
  mainGuestName: string;
  entitlement: CafeBreakfastEntitlement;
  attendedQty: number;
};

/**
 * Piso 0. O direito deixou de ser TETO do atendimento (migration
 * 20260928090000_cafe_controle_operacional): enquanto meal_plan_desc não
 * estiver homologado ele vale 0 e o operador precisa contar mesmo assim.
 * O parâmetro continua na assinatura porque as chamadas o informam.
 */
export function clampCafeAttendedQty(
  nextValue: number,
  _entitledQty?: number,
): number {
  if (!Number.isFinite(nextValue)) return 0;
  return Math.max(0, Math.trunc(nextValue));
}

export function cafeMissingQty(card: Pick<CafeCardModel, "entitlement" | "attendedQty">): number {
  return Math.max(0, card.entitlement.entitledQty - card.attendedQty);
}

/** Mesma lista da RPC operacional_cafe_set_atendimento. */
export function canRoleWriteCafeAttendance(role: string | null | undefined): boolean {
  const r = String(role || "").trim().toLowerCase();
  return r === "cafe" || r === "recepcao" || r === "admin";
}

/**
 * "Marcar todos" só existe com total oficial: sem direito apurado não há
 * "todos" a marcar, e direito a café não se presume. A UI desabilita o botão
 * por aqui; a RPC recusa pelo mesmo motivo.
 */
export function canMarkAllCafeAttendance(
  entitlement: Pick<CafeBreakfastEntitlement, "kind" | "entitledQty"> | null | undefined,
): boolean {
  if (!entitlement) return false;
  if (entitlement.kind !== "incluido" && entitlement.kind !== "avulso_pago") return false;
  return Math.max(0, entitlement.entitledQty) > 0;
}

export function assertCanWriteCafeAttendance(input: {
  role: string | null | undefined;
  cafeDateYmd: string;
  entitlement: CafeBreakfastEntitlement;
  now?: Date;
}): { ok: true } | { ok: false; error: string } {
  if (!canRoleWriteCafeAttendance(input.role)) {
    return { ok: false, error: "cafe_write_forbidden_role" };
  }
  if (!canRegisterCafeAttendanceForDate(input.cafeDateYmd, input.now)) {
    return { ok: false, error: "cafe_write_forbidden_future_date" };
  }
  // O direito NÃO barra mais o + / −: registrar quem tomou café é contagem
  // operacional, não cobrança. Espelha a RPC.
  return { ok: true };
}

export function summarizeCafeKpis(cards: CafeCardModel[]): {
  apartments: number;
  expectedGuests: number;
  attendedGuests: number;
  missingGuests: number;
  completeApartments: number;
} {
  let expectedGuests = 0;
  let attendedGuests = 0;
  let completeApartments = 0;

  for (const card of cards) {
    const entitled = Math.max(0, card.entitlement.entitledQty);
    // Atendidos é contagem real do operador: vale mesmo sem direito apurado.
    attendedGuests += clampCafeAttendedQty(card.attendedQty, entitled);
    // Previstos e "atendimento completo" continuam presos ao direito oficial:
    // sem ele não há total a comparar e nada é presumido.
    if (entitled <= 0) continue;
    expectedGuests += entitled;
    if (clampCafeAttendedQty(card.attendedQty, entitled) >= entitled) completeApartments += 1;
  }

  return {
    apartments: cards.length,
    expectedGuests,
    attendedGuests,
    missingGuests: Math.max(0, expectedGuests - attendedGuests),
    completeApartments,
  };
}

/**
 * Candidatos a “Marcar todos” na UI (otimização de UX).
 * NÃO autoriza nem define limite — a RPC calcula o teto server-side.
 * Retorna só IDs estáveis; o navegador não envia direito/limite.
 */
export function planMarkAllCafeAttended(cards: CafeCardModel[]): Array<{
  reservationId: string;
}> {
  const out: Array<{ reservationId: string }> = [];
  for (const card of cards) {
    const entitled = Math.max(0, card.entitlement.entitledQty);
    if (entitled <= 0) continue;
    if (card.entitlement.kind === "sem_cafe" || card.entitlement.kind === "nao_mapeado") {
      continue;
    }
    const previousQty = clampCafeAttendedQty(card.attendedQty, entitled);
    if (previousQty === entitled) continue;
    out.push({ reservationId: card.reservationId });
  }
  return out;
}

export function cafeStatusLabel(entitlement: CafeBreakfastEntitlement): string {
  if (entitlement.kind === "avulso_pago") {
    const n = entitlement.paidExtraQty;
    return n === 1 ? "1 café avulso pago" : `${n} cafés avulsos pagos`;
  }
  return "";
}

export function cafeGuestLine(entitlement: CafeBreakfastEntitlement): string {
  const n = entitlement.guestCount;
  const base = n === 1 ? "1 hóspede" : `${n} hóspedes`;
  if (entitlement.kind === "avulso_pago") {
    return `${base} · ${cafeStatusLabel(entitlement)}`;
  }
  return base;
}

export function cafeAlertLabel(
  entitlement: CafeBreakfastEntitlement,
): string | null {
  return entitlement.kind === "sem_cafe" ? "SEM CAFÉ" : null;
}

export function cafeOperationalStatusLabel(
  entitlement: CafeBreakfastEntitlement,
  attendedQty: number,
): string {
  if (entitlement.kind === "sem_cafe" || entitlement.kind === "nao_mapeado") {
    return "";
  }
  const attended = clampCafeAttendedQty(attendedQty, entitlement.entitledQty);
  return attended >= entitlement.entitledQty
    ? "Atendimento completo"
    : "Aguardando atendimento";
}
