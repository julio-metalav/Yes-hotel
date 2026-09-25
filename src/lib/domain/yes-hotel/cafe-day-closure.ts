/**
 * Fechamento operacional do café por DATA (espelho das RPCs
 * `operacional_cafe_fechar_dia` / `operacional_cafe_reabrir_dia`).
 *
 * O fechamento é um FATO, não uma inferência: atendidos = previstos não
 * conclui nada. Quem encerra o serviço é o operador, e isso fica persistido.
 *
 * Sem I/O.
 */

import { canRegisterCafeAttendanceForDate } from "./cafe-operational-date.ts";
import { canRoleWriteCafeAttendance } from "./cafe-attendance-policy.ts";

export type CafeDayStatus = "aberto" | "concluido";

export type CafeDayClosure = {
  dateYmd: string;
  status: CafeDayStatus;
  /** ISO do carimbo de conclusão; null enquanto aberto. */
  closedAt: string | null;
  closedByName: string | null;
  reopenedAt: string | null;
};

/** Dia sem registro é dia aberto. Ausência nunca vira conclusão. */
export function buildOpenCafeDay(dateYmd: string): CafeDayClosure {
  return {
    dateYmd,
    status: "aberto",
    closedAt: null,
    closedByName: null,
    reopenedAt: null,
  };
}

/** Normaliza a linha vinda de `operacional_cafe_status_dia`. */
export function parseCafeDayClosure(
  dateYmd: string,
  row: {
    status?: string | null;
    concluido_em?: string | null;
    concluido_por_nome?: string | null;
    reaberto_em?: string | null;
  } | null | undefined,
): CafeDayClosure {
  const status = String(row?.status || "aberto").trim().toLowerCase();
  // Só o valor explícito "concluido" fecha. Qualquer outra coisa — inclusive
  // lixo ou ausência — é dia aberto: na dúvida, o operador continua podendo
  // registrar, que é o estado seguro.
  if (status !== "concluido") return buildOpenCafeDay(dateYmd);
  return {
    dateYmd,
    status: "concluido",
    closedAt: row?.concluido_em ?? null,
    closedByName: (row?.concluido_por_nome ?? "").trim() || null,
    reopenedAt: row?.reaberto_em ?? null,
  };
}

export function isCafeDayClosed(
  closure: Pick<CafeDayClosure, "status"> | null | undefined,
): boolean {
  return closure?.status === "concluido";
}

/**
 * Quem pode encerrar o serviço: os mesmos perfis que operam o café.
 * Nunca em data futura, e nunca num dia já concluído.
 * NÃO depende de atendidos = previstos — o serviço acaba no horário.
 */
export function canCloseCafeDay(input: {
  role: string | null | undefined;
  cafeDateYmd: string;
  closure: Pick<CafeDayClosure, "status"> | null | undefined;
  now?: Date;
}): boolean {
  if (!canRoleWriteCafeAttendance(input.role)) return false;
  if (!canRegisterCafeAttendanceForDate(input.cafeDateYmd, input.now)) return false;
  return !isCafeDayClosed(input.closure);
}

/**
 * Reabrir é exclusivo de admin. Café e recepção não desfazem fechamento —
 * é a diferença entre operar e corrigir a operação.
 */
export function canReopenCafeDay(input: {
  role: string | null | undefined;
  closure: Pick<CafeDayClosure, "status"> | null | undefined;
}): boolean {
  if (String(input.role || "").trim().toLowerCase() !== "admin") return false;
  return isCafeDayClosed(input.closure);
}

/**
 * Autorização de escrita de atendimento considerando o fechamento.
 * Espelha a guarda `cafe_write_forbidden_dia_concluido` da RPC.
 */
export function assertCafeDayAcceptsAttendance(input: {
  closure: Pick<CafeDayClosure, "status"> | null | undefined;
}): { ok: true } | { ok: false; error: string } {
  if (isCafeDayClosed(input.closure)) {
    return { ok: false, error: "cafe_write_forbidden_dia_concluido" };
  }
  return { ok: true };
}

export function cafeDayStatusLabel(
  closure: Pick<CafeDayClosure, "status"> | null | undefined,
): string {
  return isCafeDayClosed(closure) ? "Concluído" : "Em andamento";
}

/** Hora local do hotel, para o texto "Concluído às 10:32". */
export function formatCafeClosureTime(
  isoTimestamp: string | null | undefined,
): string {
  if (!isoTimestamp) return "";
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Campo_Grande",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

/**
 * Linha de confirmação do fechamento. Omite em silêncio o que não souber:
 * sem hora e sem nome, ainda assim informa que o dia foi concluído.
 */
export function cafeClosureSummaryLine(
  closure: CafeDayClosure | null | undefined,
): string {
  if (!isCafeDayClosed(closure)) return "";
  const hora = formatCafeClosureTime(closure?.closedAt);
  const nome = (closure?.closedByName ?? "").trim();
  if (hora && nome) return `Concluído às ${hora} por ${nome}`;
  if (hora) return `Concluído às ${hora}`;
  if (nome) return `Concluído por ${nome}`;
  return "Serviço concluído";
}
