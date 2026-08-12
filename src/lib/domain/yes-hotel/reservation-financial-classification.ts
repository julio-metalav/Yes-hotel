/**
 * Classificação financeira oficial da reserva operacional (HITS).
 *
 * Status financeiro visível:
 * - pago
 * - pendente
 * - pendente_comissionado
 *
 * Independente de elegibilidade de acesso:
 * pendente_comissionado permanece financeiramente pendente, mas está
 * financeiramente liberado para acesso (não gera Pagar.me).
 *
 * Ordem defensiva (comissão):
 * 1) B2BRESERVAS → comissionada
 * 2) canal OTA explícito (lista fechada) → comissionada
 * 3) Booking Engine / Motor / Particular → direta (não comissionada)
 * 4) gestor/canal vazios → direta manual HITS (não comissionada)
 * 5) desconhecido → não comissionada (nunca assumir comissionada)
 *
 * PROIBIDO: matching frágil por substring "booking" (ex.: includes) ou regex
 * que confunda Booking Engine com Booking OTA.
 */

export type FinancialStatusVisible =
  | "pago"
  | "pendente"
  | "pendente_comissionado";

export type ClassificacaoComissionamento =
  | "nao_comissionada"
  | "comissionada"
  | "desconhecida";

export type SyncedPaymentStatus = "pago" | "pendente" | "parcial" | "desconhecido";

export type ClassificationReason =
  | "b2b_channel_manager"
  | "ota_channel"
  | "ota_channel_id"
  | "booking_engine_direta"
  | "particular_motor"
  | "manual_hits_direta"
  | "default_nao_comissionada";

/** IDs/códigos estáveis conhecidos — expandir quando HITS confirmar catálogo. */
export const KNOWN_OTA_CHANNEL_IDS = {
  // Reservado: sem IDs oficiais autenticados no contrato atual.
} as const;

const B2B_CHANNEL_MANAGERS = new Set(["B2BRESERVAS"]);

/**
 * Canais OTA reconhecidos nesta fase (lista fechada).
 * Tokens após upperCompact (sem acento/espaço; ponto e barra preservados).
 * NÃO incluir BOOKINGENGINE.
 */
const OTA_EXACT_TOKENS = new Set([
  "BOOKING",
  "BOOKING.COM",
  "BOOKINGCOM",
  "EXPEDIA",
  "EXPEDIA/HOTELS.COM",
  "EXPEDIA/HOTELSCOM",
  "EXPEDIAHOTELS.COM",
  "EXPEDIAHOTELSCOM",
  "HOTELS.COM",
  "HOTELSCOM",
  "AIRBNB",
]);

const OTA_TOKEN_TO_ID: Record<string, string> = {
  BOOKING: "booking",
  "BOOKING.COM": "booking",
  BOOKINGCOM: "booking",
  EXPEDIA: "expedia",
  "EXPEDIA/HOTELS.COM": "expedia",
  "EXPEDIA/HOTELSCOM": "expedia",
  "EXPEDIAHOTELS.COM": "expedia",
  EXPEDIAHOTELSCOM: "expedia",
  "HOTELS.COM": "hotels_com",
  HOTELSCOM: "hotels_com",
  AIRBNB: "airbnb",
};

function normText(v: unknown): string {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/** Compacta para comparação exata: remove espaços; mantém `.` e `/`. */
export function upperCompact(v: unknown): string {
  return normText(v).toUpperCase().replace(/\s+/g, "");
}

function trimOrEmpty(v: unknown): string {
  return String(v ?? "").trim();
}

export function parseHitsMoney(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).trim().replace(/\s/g, "").replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function mapPaymentStatusFromBalanceDue(
  balanceDue: unknown,
  fallback: SyncedPaymentStatus = "desconhecido",
): SyncedPaymentStatus {
  const n = parseHitsMoney(balanceDue);
  if (n == null) return fallback;
  if (n <= 0) return "pago";
  return "pendente";
}

export function isB2bChannelManager(channelManager: unknown): boolean {
  const compact = upperCompact(channelManager);
  if (!compact) return false;
  return compact === "B2BRESERVAS" || compact.startsWith("B2BRESERVAS");
}

/** Booking Engine = motor próprio Omnibees — NUNCA OTA Booking. */
export function isBookingEngineChannel(value: unknown): boolean {
  return upperCompact(value) === "BOOKINGENGINE";
}

export function isMotorDeReservasChannel(value: unknown): boolean {
  return upperCompact(value) === "MOTORADERESERVAS";
}

export function matchOtaExactToken(value: unknown): string | null {
  const compact = upperCompact(value);
  if (!compact) return null;
  // Defesa: Booking Engine nunca é OTA.
  if (compact === "BOOKINGENGINE") return null;
  if (!OTA_EXACT_TOKENS.has(compact)) return null;
  return OTA_TOKEN_TO_ID[compact] ?? null;
}

export function matchOtaFromTexts(texts: unknown[]): string | null {
  for (const raw of texts) {
    const id = matchOtaExactToken(raw);
    if (id) return id;
  }
  return null;
}

export function matchOtaFromChannelId(channelId: unknown): string | null {
  const id = String(channelId ?? "").trim();
  if (!id) return null;
  const known = KNOWN_OTA_CHANNEL_IDS as Record<string, string>;
  return known[id] ?? null;
}

export function isDirectBookingEngineOrMotor(input: {
  channelManager?: unknown;
  salesChannel?: unknown;
  companyName?: unknown;
  billingEntity?: unknown;
  groupName?: unknown;
}): boolean {
  const channels = [
    input.salesChannel,
    input.companyName,
    input.billingEntity,
    input.groupName,
  ];
  for (const c of channels) {
    if (isBookingEngineChannel(c)) return true;
    if (isMotorDeReservasChannel(c)) return true;
  }
  const blobs = channels.map(normText).join(" | ").toLowerCase();
  if (/\bparticular\b/.test(blobs)) return true;
  return false;
}

/** @deprecated prefer isDirectBookingEngineOrMotor — mantido para espelho UI. */
export function isParticularMotorReservation(input: {
  channelManager?: unknown;
  salesChannel?: unknown;
  companyName?: unknown;
  billingEntity?: unknown;
  groupName?: unknown;
}): boolean {
  return isDirectBookingEngineOrMotor(input);
}

export function isManualHitsDirectReservation(input: {
  channelManager?: unknown;
  salesChannel?: unknown;
  companyName?: unknown;
  billingEntity?: unknown;
  groupName?: unknown;
  reservationChannelId?: unknown;
  integrator?: unknown;
}): boolean {
  const manager = trimOrEmpty(input.channelManager) || trimOrEmpty(input.integrator);
  const channel =
    trimOrEmpty(input.salesChannel) ||
    trimOrEmpty(input.companyName) ||
    trimOrEmpty(input.billingEntity) ||
    trimOrEmpty(input.groupName);
  const channelId = trimOrEmpty(input.reservationChannelId);
  return !manager && !channel && !channelId;
}

export function classifyCommissionFromHits(input: {
  channelManager?: unknown;
  salesChannel?: unknown;
  companyName?: unknown;
  billingEntity?: unknown;
  groupName?: unknown;
  reservationChannelId?: unknown;
  integrator?: unknown;
}): {
  classificacao: Exclude<ClassificacaoComissionamento, "desconhecida">;
  reason: ClassificationReason;
  matchedOtaId: string | null;
  originKind: "b2b" | "ota" | "booking_engine" | "motor_particular" | "manual_hits" | "unknown";
} {
  // 2) B2B
  if (isB2bChannelManager(input.channelManager ?? input.integrator)) {
    return {
      classificacao: "comissionada",
      reason: "b2b_channel_manager",
      matchedOtaId: null,
      originKind: "b2b",
    };
  }

  // Preferir ID estável quando existir.
  const byId = matchOtaFromChannelId(input.reservationChannelId);
  if (byId) {
    return {
      classificacao: "comissionada",
      reason: "ota_channel_id",
      matchedOtaId: byId,
      originKind: "ota",
    };
  }

  // 3) OTA explícita (lista fechada; Booking Engine não entra)
  const channelCandidates = [
    input.salesChannel,
    input.companyName,
    input.billingEntity,
    input.groupName,
  ];
  const ota = matchOtaFromTexts(channelCandidates);
  if (ota) {
    return {
      classificacao: "comissionada",
      reason: "ota_channel",
      matchedOtaId: ota,
      originKind: "ota",
    };
  }

  // 4) Booking Engine / Motor / Particular
  if (channelCandidates.some(isBookingEngineChannel)) {
    return {
      classificacao: "nao_comissionada",
      reason: "booking_engine_direta",
      matchedOtaId: null,
      originKind: "booking_engine",
    };
  }
  if (isDirectBookingEngineOrMotor(input)) {
    return {
      classificacao: "nao_comissionada",
      reason: "particular_motor",
      matchedOtaId: null,
      originKind: "motor_particular",
    };
  }

  // 5) gestor/canal vazios → direta manual HITS
  if (isManualHitsDirectReservation(input)) {
    return {
      classificacao: "nao_comissionada",
      reason: "manual_hits_direta",
      matchedOtaId: null,
      originKind: "manual_hits",
    };
  }

  // 6) desconhecido → nunca assumir comissionada
  return {
    classificacao: "nao_comissionada",
    reason: "default_nao_comissionada",
    matchedOtaId: null,
    originKind: "unknown",
  };
}

export function resolveFinancialStatusVisible(input: {
  pagamentoStatus?: unknown;
  balanceDue?: unknown;
  classificacao?: unknown;
}): FinancialStatusVisible {
  const pay = String(input.pagamentoStatus ?? "")
    .trim()
    .toLowerCase();
  const balance = parseHitsMoney(input.balanceDue);
  const cls = String(input.classificacao ?? "")
    .trim()
    .toLowerCase();

  // 1) saldo <= 0 / pago → Pago
  const isPaid = pay === "pago" || (balance != null && balance <= 0);
  if (isPaid) return "pago";

  const hasDue =
    (balance != null && balance > 0) ||
    pay === "pendente" ||
    pay === "parcial" ||
    pay === "desconhecido" ||
    pay === "";

  if (hasDue && cls === "comissionada") return "pendente_comissionado";
  return "pendente";
}

export function financialStatusLabel(status: FinancialStatusVisible): string {
  if (status === "pago") return "Pago";
  if (status === "pendente_comissionado") return "Pendente (comissionado)";
  return "Pendente";
}

export function isFinanceiramenteLiberadoParaAcesso(input: {
  pagamentoStatus?: unknown;
  balanceDue?: unknown;
  classificacao?: unknown;
}): boolean {
  const status = resolveFinancialStatusVisible(input);
  if (status === "pago") return true;
  if (status === "pendente_comissionado") return true;
  const cls = String(input.classificacao ?? "")
    .trim()
    .toLowerCase();
  if (cls === "desconhecida") return true;
  return false;
}

export function shouldCreatePagarmeCharge(input: {
  pagamentoStatus?: unknown;
  balanceDue?: unknown;
  classificacao?: unknown;
}): { allowed: boolean; reason: string } {
  const status = resolveFinancialStatusVisible(input);
  if (status === "pago") {
    return { allowed: false, reason: "reserva_ja_paga" };
  }
  if (status === "pendente_comissionado") {
    return { allowed: false, reason: "comissionada_bloqueada" };
  }
  const cls = String(input.classificacao ?? "")
    .trim()
    .toLowerCase();
  if (cls === "desconhecida" || !cls) {
    return { allowed: false, reason: "classificacao_desconhecida" };
  }
  if (cls !== "nao_comissionada") {
    return { allowed: false, reason: "classificacao_invalida" };
  }
  return { allowed: true, reason: "ok" };
}

export function nextFinancialActionLabel(status: FinancialStatusVisible): string | null {
  if (status === "pendente") return "Gerar e enviar link de pagamento";
  if (status === "pendente_comissionado") return "Regularizar pagamento no HITS";
  return null;
}

export function extractHitsCommercialFields(raw: Record<string, unknown> | null | undefined): {
  channelManager: string | null;
  salesChannel: string | null;
  billingEntity: string | null;
  reservationChannelId: string | null;
  companyName: string | null;
  requesterCompanyName: string | null;
  groupName: string | null;
  integrator: string | null;
  reservationBalanceDue: number | null;
  reservationTotalAmount: number | null;
} {
  const r = raw ?? {};
  const trim = (v: unknown): string | null => {
    const s = String(v ?? "").trim();
    return s || null;
  };
  const integrator = trim(r.integrator);
  const companyName = trim(r.companyName);
  const requesterCompanyName = trim(r.requesterCompanyName);
  const groupName = trim(r.groupName);
  const channelManager = integrator ?? null;
  const salesChannel = companyName ?? requesterCompanyName ?? groupName ?? null;
  const billingEntity = requesterCompanyName ?? companyName ?? null;
  const reservationChannelId =
    r.reservationChannelId != null && String(r.reservationChannelId).trim() !== ""
      ? String(r.reservationChannelId).trim()
      : null;

  return {
    channelManager,
    salesChannel,
    billingEntity,
    reservationChannelId,
    companyName,
    requesterCompanyName,
    groupName,
    integrator,
    reservationBalanceDue: parseHitsMoney(r.reservationBalanceDue),
    reservationTotalAmount: parseHitsMoney(r.reservationTotalAmount),
  };
}
