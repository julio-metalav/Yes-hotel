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

/** IDs/códigos estáveis conhecidos — expandir quando HITS confirmar catálogo. */
export const KNOWN_OTA_CHANNEL_IDS = {
  // Reservado: sem IDs oficiais autenticados no contrato atual.
} as const;

const B2B_CHANNEL_MANAGERS = new Set(["B2BRESERVAS"]);

const OTA_NAME_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: "booking", re: /\bbooking(?:\.com)?\b/i },
  { id: "expedia", re: /\bexpedia\b/i },
  { id: "hotels_com", re: /\bhotels\.?\s*com\b/i },
  { id: "airbnb", re: /\bairbnb\b/i },
];

function normText(v: unknown): string {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function upperCompact(v: unknown): string {
  return normText(v).toUpperCase().replace(/\s+/g, "");
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
  for (const known of B2B_CHANNEL_MANAGERS) {
    if (compact === known || compact.includes(known)) return true;
  }
  return false;
}

export function matchOtaFromTexts(texts: unknown[]): string | null {
  for (const raw of texts) {
    const t = normText(raw);
    if (!t) continue;
    for (const p of OTA_NAME_PATTERNS) {
      // Expedia/Hotels.com composto
      if (/expedia\s*\/\s*hotels/i.test(t)) return "expedia";
      if (p.re.test(t)) return p.id;
    }
  }
  return null;
}

export function matchOtaFromChannelId(channelId: unknown): string | null {
  const id = String(channelId ?? "").trim();
  if (!id) return null;
  const known = KNOWN_OTA_CHANNEL_IDS as Record<string, string>;
  return known[id] ?? null;
}

export function isParticularMotorReservation(input: {
  channelManager?: unknown;
  salesChannel?: unknown;
  companyName?: unknown;
  billingEntity?: unknown;
  groupName?: unknown;
}): boolean {
  const blobs = [
    input.channelManager,
    input.salesChannel,
    input.companyName,
    input.billingEntity,
    input.groupName,
  ].map(normText);
  const joined = blobs.join(" | ").toLowerCase();
  const hasMotor = /motor\s+de\s+reservas/.test(joined);
  const hasParticular = /\bparticular\b/.test(joined);
  // Particular vendido pelo site/motor próprio.
  if (hasParticular && hasMotor) return true;
  if (hasParticular && /sem\s+documento/.test(joined)) return true;
  if (hasMotor && hasParticular) return true;
  // Canal só "Motor de Reservas" sem OTA/B2B → particular operacional.
  if (hasMotor && !isB2bChannelManager(input.channelManager) && !matchOtaFromTexts(blobs)) {
    return true;
  }
  return false;
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
  reason:
    | "b2b_channel_manager"
    | "ota_channel"
    | "ota_channel_id"
    | "particular_motor"
    | "default_nao_comissionada";
  matchedOtaId: string | null;
} {
  if (isB2bChannelManager(input.channelManager ?? input.integrator)) {
    return {
      classificacao: "comissionada",
      reason: "b2b_channel_manager",
      matchedOtaId: null,
    };
  }

  const byId = matchOtaFromChannelId(input.reservationChannelId);
  if (byId) {
    return {
      classificacao: "comissionada",
      reason: "ota_channel_id",
      matchedOtaId: byId,
    };
  }

  const texts = [
    input.salesChannel,
    input.companyName,
    input.billingEntity,
    input.groupName,
    input.channelManager,
    input.integrator,
  ];
  const ota = matchOtaFromTexts(texts);
  if (ota) {
    return {
      classificacao: "comissionada",
      reason: "ota_channel",
      matchedOtaId: ota,
    };
  }

  if (isParticularMotorReservation(input)) {
    return {
      classificacao: "nao_comissionada",
      reason: "particular_motor",
      matchedOtaId: null,
    };
  }

  // Provider/canal desconhecido + saldo > 0 → Pendente normal (não comissionada).
  return {
    classificacao: "nao_comissionada",
    reason: "default_nao_comissionada",
    matchedOtaId: null,
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
  // desconhecida legada: manter liberação defensiva já existente no painel.
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
  // Gestor: preferir integrator (lista HITS); fallback groupName só se parecer gestor.
  const channelManager = integrator ?? null;
  // Canal de vendas: companyName costuma carregar OTA/agência; requester como fallback.
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
