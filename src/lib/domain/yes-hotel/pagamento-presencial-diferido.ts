/**
 * Regra travada: pagamento presencial diferido.
 * Sem I/O. NÃO marca como pago. NÃO altera Pagar.me.
 *
 * Fonte financeira vigente: operacional_reservas.pagamento_status (HITS/PMS).
 */

import { isCorumbaApplicableHoliday } from "./corumba-calendar.ts";
import {
  YES_HOTEL_TIMEZONE,
  YES_HOTEL_UTC_OFFSET_MINUTES,
  extractYmd,
  hotelLocalToUtcIso,
} from "./hotel-timezone.ts";

export const PAGAMENTO_PRESENCIAL_DIFERIDO_FEATURE = "pagamento_presencial_diferido";

/** Fail-closed: só boolean true (UI) ou env === "true" (server). */
export function isPagamentoPresencialDiferidoUiEnabled(value: unknown): boolean {
  return value === true;
}

export function isPagamentoPresencialDiferidoServerEnabled(
  env: Record<string, string | undefined> | null | undefined,
): boolean {
  return String(env?.YES_HOTEL_PAGAMENTO_PRESENCIAL_DIFERIDO_ENABLED ?? "").trim() === "true";
}

export type PresencialDiferidoRegra = "util_19h" | "fim_semana_feriado_15h";

export type PresencialDiferidoMarkInput = {
  nowIso: string;
  checkInYmd: string;
  statusReserva: string;
  pagamentoStatus: string;
  classificacaoComissionamento: string;
  /** Já autorizado anteriormente. */
  jaAutorizado?: boolean;
  perfilUsuario: string;
  featureEnabled: boolean;
};

export type PresencialDiferidoMarkDecision = {
  allowed: boolean;
  reason:
    | "ok"
    | "feature_off"
    | "perfil"
    | "reserva_inativa"
    | "ja_pago"
    | "comissionada"
    | "fora_do_dia_checkin"
    | "antes_das_08h"
    | "ja_autorizado"
    | "pagamento_nao_pendente";
};

export type HotelLocalParts = {
  ymd: string;
  hour: number;
  minute: number;
  second: number;
  /** 0=domingo … 6=sábado (calendário civil local). */
  weekday: number;
};

/** Converte instante UTC → partes civis em America/Campo_Grande. */
export function utcIsoToHotelLocalParts(iso: string): HotelLocalParts {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) throw new Error(`ISO inválido: ${iso}`);
  // Local CG = UTC + offset (−240 ⇒ subtrai 4h do UTC wall).
  const localMs = ms + YES_HOTEL_UTC_OFFSET_MINUTES * 60 * 1000;
  const d = new Date(localMs);
  const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return {
    ymd,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

export function addCalendarDaysYmd(ymd: string, days: number): string {
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`YMD inválido: ${ymd}`);
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days);
  const d = new Date(utc);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function isPaymentPendingStatus(status: string): boolean {
  const s = String(status || "").trim().toLowerCase();
  return s === "pendente" || s === "parcial" || s === "emergencial";
}

function allowsPresencialPayment(classif: string): boolean {
  const c = String(classif || "").trim().toLowerCase();
  // Comissionada: não cobrar hóspede. Demais modalidades com pendência financeira
  // podem autorizar presencial no hotel.
  return c !== "comissionada";
}

function isAuthorizedProfile(perfil: string): boolean {
  const p = String(perfil || "").trim().toLowerCase();
  return p === "admin" || p === "recepcao";
}

/**
 * Visibilidade do botão "Pagto presencial diferido".
 * Só no dia do check-in, a partir das 08:00 locais, com pendência financeira.
 */
export function canShowPresencialDiferidoButton(
  input: PresencialDiferidoMarkInput,
): PresencialDiferidoMarkDecision {
  if (!input.featureEnabled) {
    return { allowed: false, reason: "feature_off" };
  }
  if (!isAuthorizedProfile(input.perfilUsuario)) {
    return { allowed: false, reason: "perfil" };
  }
  if (String(input.statusReserva || "").trim().toLowerCase() !== "ativa") {
    return { allowed: false, reason: "reserva_inativa" };
  }
  if (String(input.pagamentoStatus || "").trim().toLowerCase() === "pago") {
    return { allowed: false, reason: "ja_pago" };
  }
  if (!isPaymentPendingStatus(input.pagamentoStatus)) {
    return { allowed: false, reason: "pagamento_nao_pendente" };
  }
  if (!allowsPresencialPayment(input.classificacaoComissionamento)) {
    return { allowed: false, reason: "comissionada" };
  }
  if (input.jaAutorizado) {
    return { allowed: false, reason: "ja_autorizado" };
  }

  const checkIn = extractYmd(input.checkInYmd);
  const local = utcIsoToHotelLocalParts(input.nowIso);
  if (local.ymd !== checkIn) {
    return { allowed: false, reason: "fora_do_dia_checkin" };
  }
  const minutes = local.hour * 60 + local.minute;
  if (minutes < 8 * 60) {
    return { allowed: false, reason: "antes_das_08h" };
  }
  return { allowed: true, reason: "ok" };
}

/** Weekday civil do YMD (0=domingo … 6=sábado). Independente de fuso para data civil. */
export function weekdayOfYmd(ymd: string): number {
  const m = extractYmd(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`YMD inválido: ${ymd}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

/** Dia útil = seg–sex e NÃO feriado aplicável a Corumbá/MS. */
export function isDiaUtilCorumba(ymd: string): boolean {
  const y = extractYmd(ymd);
  const wd = weekdayOfYmd(y);
  if (wd === 0 || wd === 6) return false;
  return !isCorumbaApplicableHoliday(y);
}

export function resolvePresencialDiferidoRegra(ymd: string): PresencialDiferidoRegra {
  return isDiaUtilCorumba(ymd) ? "util_19h" : "fim_semana_feriado_15h";
}

export type PresencialDiferidoEffectivenessInput = {
  autorizado: boolean;
  firstAccessAtIso: string;
};

export type PresencialDiferidoEffectiveness = {
  efetivada: boolean;
  regra: PresencialDiferidoRegra;
  firstAccessLocalYmd: string;
  firstAccessLocalHour: number;
  firstAccessLocalMinute: number;
  thresholdHour: number;
  /** ISO UTC do deadline 09:00 do dia seguinte ao primeiro acesso. */
  deadlineIso: string;
  reason:
    | "nao_autorizado"
    | "antes_ou_igual_limite"
    | "efetivada_util_19h"
    | "efetivada_fim_semana_feriado_15h";
};

/**
 * Avalia se o PRIMEIRO ACESSO efetiva a exceção.
 * Limites: >19:00 dia útil; >15:00 sábado/domingo/feriado.
 * 19:00 e 15:00 exatos NÃO efetivam.
 */
export function evaluatePresencialDiferidoOnFirstAccess(
  input: PresencialDiferidoEffectivenessInput,
): PresencialDiferidoEffectiveness {
  const local = utcIsoToHotelLocalParts(input.firstAccessAtIso);
  const regra = resolvePresencialDiferidoRegra(local.ymd);
  const thresholdHour = regra === "util_19h" ? 19 : 15;
  const nextDay = addCalendarDaysYmd(local.ymd, 1);
  const deadlineIso = hotelLocalToUtcIso(nextDay, 9, 0, 0);

  if (!input.autorizado) {
    return {
      efetivada: false,
      regra,
      firstAccessLocalYmd: local.ymd,
      firstAccessLocalHour: local.hour,
      firstAccessLocalMinute: local.minute,
      thresholdHour,
      deadlineIso,
      reason: "nao_autorizado",
    };
  }

  const minutes = local.hour * 60 + local.minute;
  const thresholdMinutes = thresholdHour * 60;
  if (minutes <= thresholdMinutes) {
    return {
      efetivada: false,
      regra,
      firstAccessLocalYmd: local.ymd,
      firstAccessLocalHour: local.hour,
      firstAccessLocalMinute: local.minute,
      thresholdHour,
      deadlineIso,
      reason: "antes_ou_igual_limite",
    };
  }

  return {
    efetivada: true,
    regra,
    firstAccessLocalYmd: local.ymd,
    firstAccessLocalHour: local.hour,
    firstAccessLocalMinute: local.minute,
    thresholdHour,
    deadlineIso,
    reason:
      regra === "util_19h" ? "efetivada_util_19h" : "efetivada_fim_semana_feriado_15h",
  };
}

export type PresencialDiferidoUiStateInput = {
  autorizado: boolean;
  efetivado: boolean;
  deadlineIso?: string | null;
  pagamentoStatus: string;
  graceStatus?: string | null;
  nowIso: string;
};

export type PresencialDiferidoUiLabel =
  | null
  | "Presencial diferido autorizado"
  | "Pagamento presencial até 09:00"
  | "Pagamento vencido — acesso suspenso";

export function resolvePresencialDiferidoUiLabel(
  input: PresencialDiferidoUiStateInput,
): PresencialDiferidoUiLabel {
  if (String(input.pagamentoStatus || "").toLowerCase() === "pago") {
    return null;
  }
  if (!input.autorizado) return null;

  const suspended =
    input.graceStatus === "suspended" ||
    input.graceStatus === "suspension_pending" ||
    input.graceStatus === "partial_failure";

  if (input.efetivado && suspended) {
    return "Pagamento vencido — acesso suspenso";
  }
  if (input.efetivado) {
    return "Pagamento presencial até 09:00";
  }
  return "Presencial diferido autorizado";
}

export const PRESENCIAL_DIFERIDO_INTERNAL_MSG =
  "Primeiro acesso realizado. Pagamento presencial diferido ativo. Regularização obrigatória até 09:00 de amanhã.";

export const PRESENCIAL_DIFERIDO_WELCOME_MSG =
  "Bem-vindo ao Yes Hotel. O pagamento presencial da sua reserva foi autorizado com prazo até 09:00 de amanhã. Regularize até esse horário para evitar a suspensão das senhas de acesso.";

export { YES_HOTEL_TIMEZONE };
