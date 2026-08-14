/**
 * Regras puras de atendimento do café (limites, KPIs, mark-all, permissões).
 * Sem I/O.
 */

import type { CafeBreakfastEntitlement } from "./cafe-breakfast-entitlement.ts";
import { canRegisterCafeAttendanceForDate } from "./cafe-operational-date.ts";

export type CafeWritableRole = "cafe";

export type CafeCardModel = {
  reservationId: string;
  apartmentCode: string;
  mainGuestName: string;
  entitlement: CafeBreakfastEntitlement;
  attendedQty: number;
};

export function clampCafeAttendedQty(
  nextValue: number,
  entitledQty: number,
): number {
  const max = Math.max(0, entitledQty);
  if (!Number.isFinite(nextValue)) return 0;
  return Math.max(0, Math.min(Math.trunc(nextValue), max));
}

export function cafeMissingQty(card: Pick<CafeCardModel, "entitlement" | "attendedQty">): number {
  return Math.max(0, card.entitlement.entitledQty - card.attendedQty);
}

export function canRoleWriteCafeAttendance(role: string | null | undefined): boolean {
  return String(role || "").trim().toLowerCase() === "cafe";
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
  if (input.entitlement.kind === "nao_mapeado") {
    return { ok: false, error: "cafe_write_forbidden_unmapped_entitlement" };
  }
  if (input.entitlement.kind === "sem_cafe" || input.entitlement.entitledQty <= 0) {
    return { ok: false, error: "cafe_write_forbidden_no_entitlement" };
  }
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
    // Sem café / não mapeado: aparece na lista, mas não distorce previstos/faltantes.
    if (entitled <= 0) continue;
    expectedGuests += entitled;
    const attended = clampCafeAttendedQty(card.attendedQty, entitled);
    attendedGuests += attended;
    if (attended >= entitled) completeApartments += 1;
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
