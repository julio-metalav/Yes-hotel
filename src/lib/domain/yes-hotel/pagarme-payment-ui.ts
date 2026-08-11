/**
 * Regras de apresentação da cobrança Pagar.me no painel operacional.
 * Fonte de verdade financeira continua no backend; isto só decide o que a UI mostra.
 */

export type PagarmeCobrancaUiStatus =
  | "created"
  | "pending"
  | "processing"
  | "paid"
  | "failed"
  | "expired"
  | "canceled"
  | "refunded"
  | "chargeback"
  | string;

export type PagarmeCobrancaUiRow = {
  id: string;
  reserva_id?: string;
  metodo?: string | null;
  status: PagarmeCobrancaUiStatus;
  valor_centavos?: number | null;
  pagarme_payment_link_url?: string | null;
  payment_link_url?: string | null;
  pagarme_status_raw?: string | null;
  requer_revisao_operacional?: boolean | null;
  requer_revisao_motivo?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

export type PagarmePagamentoUiRow = {
  id: string;
  cobranca_id: string;
  valor_centavos_recebido?: number | null;
  sincronizacao_hits_status?: string | null;
};

export type PagarmePaymentUiKind =
  | "none"
  | "hidden_perfil"
  | "classificar"
  | "comissionada"
  | "cobrar"
  | "aguardando"
  | "pago_pagarme_hits_pendente"
  | "nova_tentativa"
  | "revisao";

export type PagarmePaymentUiState = {
  kind: PagarmePaymentUiKind;
  listaLabel: string;
  detalheTexto: string;
  variant: "warn" | "info" | "success" | "danger" | "neutral" | "amber";
  ctaKind: string | null;
  ctaLabel: string | null;
  cobranca: PagarmeCobrancaUiRow | null;
  canOpenLink: boolean;
  canCopyLink: boolean;
  paymentLinkUrl: string | null;
  showValorInput: boolean;
  showGerarCartao: boolean;
  showClassificar: boolean;
  hintAnterior: string | null;
  /** Apresentação do card Situação (só quando distinta do HITS bruto). */
  situacaoLabel: string | null;
  situacaoSubtexto: string | null;
  /** Badge compacto da tabela (não substituir fonte HITS; só clareza). */
  statusBadgeLabel: string | null;
};

const BLOQUEANTES = new Set(["created", "pending", "processing"]);
const RETRYABLE = new Set(["failed", "expired", "canceled"]);
const REVISAO_STATUS = new Set(["refunded", "chargeback"]);
const PERFIS_FINANCEIROS = new Set(["admin", "recepcao"]);

function asStatus(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase();
}

function cobrancaTs(c: PagarmeCobrancaUiRow): number {
  const a = Date.parse(String(c.updated_at || c.created_at || ""));
  return Number.isFinite(a) ? a : 0;
}

function latestOf(rows: PagarmeCobrancaUiRow[]): PagarmeCobrancaUiRow | null {
  if (!rows.length) return null;
  return rows.slice().sort((a, b) => cobrancaTs(b) - cobrancaTs(a))[0] ?? null;
}

/**
 * Aceita somente https: via URL parser.
 * Bloqueia http:, javascript:, data:, vazio e strings inválidas.
 */
export function isSafeHttpsPaymentLinkUrl(value: unknown): boolean {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

export function paymentLinkUrlOf(c: PagarmeCobrancaUiRow | null | undefined): string | null {
  if (!c) return null;
  const url = String(c.payment_link_url || c.pagarme_payment_link_url || "").trim();
  if (!url || !isSafeHttpsPaymentLinkUrl(url)) return null;
  return url;
}

/** Escolhe a cobrança relevante para a UI (bloqueante > paid > revisão > retry). */
export function pickRelevantCobranca(
  cobrancas: PagarmeCobrancaUiRow[] | null | undefined,
): PagarmeCobrancaUiRow | null {
  const list = Array.isArray(cobrancas) ? cobrancas.filter(Boolean) : [];
  if (!list.length) return null;
  const blocking = list.filter((c) => BLOQUEANTES.has(asStatus(c.status)));
  if (blocking.length) return latestOf(blocking);
  const paid = list.filter((c) => asStatus(c.status) === "paid");
  if (paid.length) return latestOf(paid);
  const review = list.filter(
    (c) => REVISAO_STATUS.has(asStatus(c.status)) || c.requer_revisao_operacional === true,
  );
  if (review.length) return latestOf(review);
  const retry = list.filter((c) => RETRYABLE.has(asStatus(c.status)));
  if (retry.length) return latestOf(retry);
  return latestOf(list);
}

function baseState(
  partial: Partial<PagarmePaymentUiState> & Pick<PagarmePaymentUiState, "kind">,
): PagarmePaymentUiState {
  return {
    listaLabel: "",
    detalheTexto: "",
    variant: "neutral",
    ctaKind: null,
    ctaLabel: null,
    cobranca: null,
    canOpenLink: false,
    canCopyLink: false,
    paymentLinkUrl: null,
    showValorInput: false,
    showGerarCartao: false,
    showClassificar: false,
    hintAnterior: null,
    situacaoLabel: null,
    situacaoSubtexto: null,
    statusBadgeLabel: null,
    ...partial,
  };
}

/**
 * Feature flag fail-closed da UI Pagar.me.
 * Somente boolean literal `true` habilita. Qualquer outro valor/erro = desabilitado.
 */
export function isPagarmeUiEnabled(value: unknown): boolean {
  try {
    return value === true;
  } catch {
    return false;
  }
}

/** Gate operacional: sem flag true, não resolve estados de cobrança Pagar.me. */
export function resolveOperacionalPaymentUi(
  input: Parameters<typeof resolvePaymentUiState>[0] & {
    pagarmeUiEnabled?: unknown;
  },
): PagarmePaymentUiState {
  if (!isPagarmeUiEnabled(input.pagarmeUiEnabled)) {
    return baseState({
      kind: "none",
      listaLabel: "",
      detalheTexto: "",
    });
  }
  return resolvePaymentUiState(input);
}

/** Gate de batch: sem flag true, zero consultas às tabelas Pagar.me. */
export function shouldFetchPagarmeCobrancas(pagarmeUiEnabled: unknown): boolean {
  return isPagarmeUiEnabled(pagarmeUiEnabled);
}

export function resolvePaymentUiState(input: {
  pagamentoStatus: string | null | undefined;
  classificacaoComissionamento: string | null | undefined;
  cobrancas?: PagarmeCobrancaUiRow[] | null;
  pagamentos?: PagarmePagamentoUiRow[] | null;
  perfilUsuario?: string | null;
}): PagarmePaymentUiState {
  const perfil = String(input.perfilUsuario ?? "")
    .trim()
    .toLowerCase();
  if (perfil && !PERFIS_FINANCEIROS.has(perfil)) {
    return baseState({
      kind: "hidden_perfil",
      listaLabel: "—",
      detalheTexto: "Perfil sem acesso a cobrança.",
    });
  }

  const hitsPago = String(input.pagamentoStatus ?? "")
    .trim()
    .toLowerCase() === "pago";
  if (hitsPago) {
    return baseState({
      kind: "none",
      listaLabel: "",
      detalheTexto: "",
    });
  }

  const cobranca = pickRelevantCobranca(input.cobrancas);
  const status = cobranca ? asStatus(cobranca.status) : "";
  const link = paymentLinkUrlOf(cobranca);
  const classif = String(input.classificacaoComissionamento ?? "desconhecida")
    .trim()
    .toLowerCase();

  if (cobranca && (REVISAO_STATUS.has(status) || cobranca.requer_revisao_operacional === true)) {
    const motivo = String(cobranca.requer_revisao_motivo || status || "revisao").trim();
    return baseState({
      kind: "revisao",
      listaLabel: "Revisão necessária",
      detalheTexto: motivo
        ? `Revisão necessária (${motivo}). Não criar nova cobrança automaticamente.`
        : "Revisão necessária. Não criar nova cobrança automaticamente.",
      variant: "danger",
      ctaKind: "pagarme_revisao",
      ctaLabel: "Ver cobrança",
      cobranca,
      paymentLinkUrl: link,
    });
  }

  if (cobranca && status === "paid") {
    return baseState({
      kind: "pago_pagarme_hits_pendente",
      listaLabel: "Pago no Pagar.me",
      detalheTexto: "Pago no Pagar.me. Regularização no HITS pendente.",
      situacaoLabel: "Pago no Pagar.me",
      situacaoSubtexto: "HITS pendente de regularização",
      statusBadgeLabel: "Pago Pagar.me · HITS pendente",
      variant: "success",
      ctaKind: "pagarme_ver",
      ctaLabel: "Ver cobrança",
      cobranca,
      paymentLinkUrl: link,
      canOpenLink: Boolean(link),
      canCopyLink: Boolean(link),
    });
  }

  if (cobranca && BLOQUEANTES.has(status)) {
    const processing = status === "processing";
    return baseState({
      kind: "aguardando",
      listaLabel: processing ? "Pagamento em processamento" : "Aguardando pagamento",
      detalheTexto: processing
        ? "Pagamento em processamento. Não gerar nova cobrança."
        : link
          ? "Link de pagamento já gerado. Reutilize o mesmo link — não criar segunda cobrança."
          : "Há cobrança Pagar.me em andamento. Não criar segunda cobrança.",
      variant: "info",
      ctaKind: "pagarme_ver",
      ctaLabel: processing
        ? "Ver pagamento"
        : link
          ? "Abrir link de pagamento"
          : "Ver cobrança",
      cobranca,
      paymentLinkUrl: link,
      canOpenLink: Boolean(link) && String(cobranca.metodo || "") === "cartao",
      canCopyLink: Boolean(link) && String(cobranca.metodo || "") === "cartao",
    });
  }

  if (classif === "desconhecida" || !classif) {
    return baseState({
      kind: "classificar",
      listaLabel: "Classificar cobrança",
      detalheTexto: "Classifique se a reserva é comissionada antes de qualquer cobrança.",
      variant: "warn",
      ctaKind: "pagarme_classificar",
      ctaLabel: "Classificar cobrança",
      showClassificar: true,
      cobranca,
      hintAnterior: cobranca && RETRYABLE.has(status) ? "Última tentativa falhou" : null,
    });
  }

  if (classif === "comissionada") {
    return baseState({
      kind: "comissionada",
      listaLabel: "Comissionada — HITS",
      detalheTexto:
        "Reserva comissionada — pendente de regularização no HITS. Não cobrar o hóspede.",
      variant: "amber",
      ctaKind: "pagarme_ver",
      ctaLabel: "Ver orientação",
      cobranca,
    });
  }

  if (classif === "nao_comissionada") {
    const hint =
      cobranca && RETRYABLE.has(status)
        ? status === "canceled"
          ? "Última cobrança cancelada"
          : status === "expired"
            ? "Última cobrança expirou"
            : "Última tentativa falhou"
        : null;
    return baseState({
      kind: hint ? "nova_tentativa" : "cobrar",
      listaLabel: hint ? "Nova cobrança" : "Gerar e enviar link de pagamento",
      detalheTexto: hint
        ? `${hint}. Você pode gerar um novo link de pagamento.`
        : "Reserva não comissionada com pagamento pendente. Informe o valor e gere o link de pagamento.",
      variant: "warn",
      ctaKind: "pagarme_cobrar",
      ctaLabel: hint ? "Nova cobrança" : "Gerar e enviar link de pagamento",
      cobranca,
      showValorInput: true,
      showGerarCartao: true,
      hintAnterior: hint,
    });
  }

  return baseState({
    kind: "none",
    listaLabel: "Regularizar pagamento",
    detalheTexto: "Pagamento pendente no PMS.",
    variant: "warn",
  });
}

export function parseBRLToCentavos(
  input: string,
): { ok: true; centavos: number } | { ok: false; reason: string } {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, reason: "vazio" };
  let s = raw.replace(/R\$\s*/gi, "").replace(/\s/g, "");
  if (!s) return { ok: false, reason: "vazio" };
  if (s.startsWith("-")) return { ok: false, reason: "negativo" };
  if (!/^[\d.,]+$/.test(s)) return { ok: false, reason: "formato" };

  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, "");
  }

  const n = Number(s);
  if (!Number.isFinite(n) || Number.isNaN(n)) return { ok: false, reason: "nan" };
  if (n <= 0) return { ok: false, reason: "nao_positivo" };

  const centavos = Math.round(n * 100);
  if (!Number.isInteger(centavos) || centavos <= 0) return { ok: false, reason: "centavos" };
  return { ok: true, centavos };
}

export function formatCentavosToBRL(centavos: number): string {
  const n = Number(centavos);
  if (!Number.isFinite(n)) return "R$ —";
  return (n / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/**
 * Formatação visual do campo "Valor a cobrar" (blur).
 * Não altera parseBRLToCentavos: usa o parse só para validar; inválido permanece como digitado.
 */
export function formatBRLInputDisplay(input: string): string {
  const raw = String(input ?? "");
  if (!raw.trim()) return "";
  const parsed = parseBRLToCentavos(raw);
  if (!parsed.ok) return raw;
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(parsed.centavos / 100);
}

/** Valor mais simples para edição no focus (sem símbolo R$). Inválido permanece como está. */
export function toBRLInputEditValue(input: string): string {
  const raw = String(input ?? "");
  if (!raw.trim()) return "";
  const parsed = parseBRLToCentavos(raw);
  if (!parsed.ok) return raw;
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(parsed.centavos / 100);
}

/** Badge da tabela que abre o fluxo financeiro direto (sem drawer geral). */
export function isPagarmeDirectPaymentBadgeType(statusType: unknown): boolean {
  const t = String(statusType ?? "").trim();
  return t === "pendente-pagamento" || t === "pagarme-pago-hits-pendente";
}

export type PagarmeModalPresentation = {
  title: string;
  subtitle: string | null;
  generateLabel: string;
  linkSectionTitle: string | null;
  showGenerate: boolean;
  showLinkActions: boolean;
  allowSendActions: boolean;
};

/**
 * Textos do modal financeiro compacto (UX operacional).
 * Não muda regras de negócio — só apresentação.
 */
export function resolvePagarmeModalPresentation(
  payUi: Pick<
    PagarmePaymentUiState,
    | "kind"
    | "cobranca"
    | "paymentLinkUrl"
    | "showGerarCartao"
    | "canOpenLink"
    | "canCopyLink"
  >,
): PagarmeModalPresentation {
  const status = asStatus(payUi.cobranca?.status);
  const hasLink = Boolean(payUi.paymentLinkUrl);
  const showLinkActions = Boolean(payUi.canOpenLink || payUi.canCopyLink);

  if (payUi.kind === "classificar") {
    return {
      title: "Classificar cobrança",
      subtitle: "Defina se a reserva é comissionada antes de gerar pagamento.",
      generateLabel: "Gerar link de pagamento",
      linkSectionTitle: null,
      showGenerate: false,
      showLinkActions: false,
      allowSendActions: false,
    };
  }
  if (payUi.kind === "comissionada") {
    return {
      title: "Reserva comissionada",
      subtitle: "Pendente de regularização no HITS. Não cobrar o hóspede.",
      generateLabel: "Gerar link de pagamento",
      linkSectionTitle: null,
      showGenerate: false,
      showLinkActions: false,
      allowSendActions: false,
    };
  }
  if (payUi.kind === "pago_pagarme_hits_pendente") {
    return {
      title: "Pago no Pagar.me",
      subtitle: "HITS pendente de regularização",
      generateLabel: "Gerar link de pagamento",
      linkSectionTitle: hasLink ? "Link do pagamento" : null,
      showGenerate: false,
      showLinkActions,
      allowSendActions: false,
    };
  }
  if (payUi.kind === "revisao") {
    return {
      title: "Revisão necessária",
      subtitle: "Não gerar nova cobrança automaticamente.",
      generateLabel: "Gerar link de pagamento",
      linkSectionTitle: hasLink ? "Link existente" : null,
      showGenerate: false,
      showLinkActions,
      allowSendActions: false,
    };
  }
  if (payUi.kind === "aguardando") {
    if (status === "processing") {
      return {
        title: "Pagamento em processamento",
        subtitle: "Aguarde a confirmação. Não gerar nova cobrança.",
        generateLabel: "Gerar link de pagamento",
        linkSectionTitle: hasLink ? "Link de pagamento" : null,
        showGenerate: false,
        showLinkActions,
        allowSendActions: false,
      };
    }
    return {
      title: "Pagamento pendente",
      subtitle: hasLink
        ? "Link de pagamento já gerado"
        : "Cobrança em andamento — não criar segunda cobrança.",
      generateLabel: "Gerar link de pagamento",
      linkSectionTitle: hasLink ? "Link de pagamento já gerado" : null,
      showGenerate: false,
      showLinkActions,
      allowSendActions: hasLink,
    };
  }
  if (payUi.kind === "cobrar" || payUi.kind === "nova_tentativa") {
    return {
      title: "Pagamento pendente",
      subtitle: "Gerar e enviar link de pagamento",
      generateLabel: "Gerar link de pagamento",
      linkSectionTitle: null,
      showGenerate: Boolean(payUi.showGerarCartao),
      showLinkActions: false,
      allowSendActions: false,
    };
  }
  return {
    title: "Pagamento pendente",
    subtitle: "Gerar e enviar link de pagamento",
    generateLabel: "Gerar link de pagamento",
    linkSectionTitle: null,
    showGenerate: false,
    showLinkActions: false,
    allowSendActions: false,
  };
}

export function mapPagarmeAdminError(input: {
  code?: string | null;
  message?: string | null;
  httpStatus?: number | null;
}): { title: string; detail: string; ambiguous: boolean } {
  const code = String(input.code || "").trim();
  const http = Number(input.httpStatus || 0);
  const msg = String(input.message || "").trim();

  if (code === "classificacao_desconhecida") {
    return {
      title: "Classifique a reserva antes de cobrar.",
      detail: msg || "Cobrança bloqueada até classificação explícita.",
      ambiguous: false,
    };
  }
  if (code === "comissionada_bloqueada" || code === "reserva_comissionada") {
    return {
      title: "Reserva comissionada — não cobrar o hóspede.",
      detail: msg || "Regularize no HITS.",
      ambiguous: false,
    };
  }
  if (code === "obrigacao_ja_paga" || code === "reserva_ja_paga") {
    return {
      title: "Pagamento já confirmado.",
      detail: msg || "Atualize o painel para ver o status.",
      ambiguous: false,
    };
  }
  if (code === "conflito_cobranca_ativa" || code === "cobranca_ativa_existente") {
    return {
      title: "Já existe cobrança em andamento.",
      detail: msg || "Use a cobrança existente.",
      ambiguous: false,
    };
  }
  if (code === "resultado_ambiguo" || code === "cancelamento_ambiguo" || http === 502) {
    return {
      title: "Não foi possível confirmar o resultado.",
      detail: "Atualize o status antes de tentar novamente.",
      ambiguous: true,
    };
  }
  if (http === 401) {
    return {
      title: "Sessão inválida ou expirada.",
      detail: "Faça login novamente.",
      ambiguous: false,
    };
  }
  if (http === 403 || code === "forbidden") {
    return {
      title: "Sem permissão para esta ação.",
      detail: msg || "Perfil não autorizado.",
      ambiguous: false,
    };
  }
  if (http === 409) {
    return {
      title: "Conflito de negócio.",
      detail: msg || code || "Não foi possível concluir a ação.",
      ambiguous: false,
    };
  }
  if (http >= 500 || code === "internal_error") {
    return {
      title: "Não foi possível confirmar o resultado.",
      detail: "Atualize o status antes de tentar novamente.",
      ambiguous: true,
    };
  }
  return {
    title: msg || "Não foi possível concluir a ação.",
    detail: code ? `Código: ${code}` : "Tente novamente após atualizar o status.",
    ambiguous: false,
  };
}
