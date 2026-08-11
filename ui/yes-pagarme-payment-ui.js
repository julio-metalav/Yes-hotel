/**
 * Policy browser: cobrança Pagar.me no painel operacional.
 * Espelha src/lib/domain/yes-hotel/pagarme-payment-ui.ts — manter sincronizado.
 */
(function (global) {
  "use strict";

  var BLOQUEANTES = { created: 1, pending: 1, processing: 1 };
  var RETRYABLE = { failed: 1, expired: 1, canceled: 1 };
  var REVISAO_STATUS = { refunded: 1, chargeback: 1 };
  var PERFIS_FINANCEIROS = { admin: 1, recepcao: 1 };

  function asStatus(raw) {
    return String(raw == null ? "" : raw)
      .trim()
      .toLowerCase();
  }

  function cobrancaTs(c) {
    var a = Date.parse(String((c && (c.updated_at || c.created_at)) || ""));
    return isFinite(a) ? a : 0;
  }

  function latestOf(rows) {
    if (!rows || !rows.length) return null;
    return rows.slice().sort(function (a, b) {
      return cobrancaTs(b) - cobrancaTs(a);
    })[0];
  }

  function isSafeHttpsPaymentLinkUrl(value) {
    var raw = String(value == null ? "" : value).trim();
    if (!raw) return false;
    try {
      var url = new URL(raw);
      return url.protocol === "https:";
    } catch (_e) {
      return false;
    }
  }

  function paymentLinkUrlOf(c) {
    if (!c) return null;
    var url = String(c.payment_link_url || c.pagarme_payment_link_url || "").trim();
    if (!url || !isSafeHttpsPaymentLinkUrl(url)) return null;
    return url;
  }

  function pickRelevantCobranca(cobrancas) {
    var list = Array.isArray(cobrancas) ? cobrancas.filter(Boolean) : [];
    if (!list.length) return null;
    var blocking = list.filter(function (c) {
      return BLOQUEANTES[asStatus(c.status)];
    });
    if (blocking.length) return latestOf(blocking);
    var paid = list.filter(function (c) {
      return asStatus(c.status) === "paid";
    });
    if (paid.length) return latestOf(paid);
    var review = list.filter(function (c) {
      return REVISAO_STATUS[asStatus(c.status)] || c.requer_revisao_operacional === true;
    });
    if (review.length) return latestOf(review);
    var retry = list.filter(function (c) {
      return RETRYABLE[asStatus(c.status)];
    });
    if (retry.length) return latestOf(retry);
    return latestOf(list);
  }

  function baseState(partial) {
    return Object.assign(
      {
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
      },
      partial || {},
    );
  }

  /** Somente boolean literal true habilita. Fail-closed. */
  function isPagarmeUiEnabled(value) {
    try {
      return value === true;
    } catch (_e) {
      return false;
    }
  }

  function shouldFetchPagarmeCobrancas(pagarmeUiEnabled) {
    return isPagarmeUiEnabled(pagarmeUiEnabled);
  }

  function resolveOperacionalPaymentUi(input) {
    input = input || {};
    if (!isPagarmeUiEnabled(input.pagarmeUiEnabled)) {
      return baseState({ kind: "none", listaLabel: "", detalheTexto: "" });
    }
    return resolvePaymentUiState(input);
  }

  function resolvePaymentUiState(input) {
    input = input || {};
    var perfil = String(input.perfilUsuario || "")
      .trim()
      .toLowerCase();
    if (perfil && !PERFIS_FINANCEIROS[perfil]) {
      return baseState({
        kind: "hidden_perfil",
        listaLabel: "—",
        detalheTexto: "Perfil sem acesso a cobrança.",
      });
    }

    var hitsPago =
      String(input.pagamentoStatus || "")
        .trim()
        .toLowerCase() === "pago";
    if (hitsPago) {
      return baseState({ kind: "none", listaLabel: "", detalheTexto: "" });
    }

    var cobranca = pickRelevantCobranca(input.cobrancas);
    var status = cobranca ? asStatus(cobranca.status) : "";
    var link = paymentLinkUrlOf(cobranca);
    var classif = String(input.classificacaoComissionamento || "desconhecida")
      .trim()
      .toLowerCase();

    if (cobranca && (REVISAO_STATUS[status] || cobranca.requer_revisao_operacional === true)) {
      var motivo = String(cobranca.requer_revisao_motivo || status || "revisao").trim();
      return baseState({
        kind: "revisao",
        listaLabel: "Revisão necessária",
        detalheTexto: motivo
          ? "Revisão necessária (" + motivo + "). Não criar nova cobrança automaticamente."
          : "Revisão necessária. Não criar nova cobrança automaticamente.",
        variant: "danger",
        ctaKind: "pagarme_revisao",
        ctaLabel: "Ver cobrança",
        cobranca: cobranca,
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
        cobranca: cobranca,
        paymentLinkUrl: link,
        canOpenLink: !!link,
        canCopyLink: !!link,
      });
    }

    if (cobranca && BLOQUEANTES[status]) {
      var processing = status === "processing";
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
        cobranca: cobranca,
        paymentLinkUrl: link,
        canOpenLink: !!link && String(cobranca.metodo || "") === "cartao",
        canCopyLink: !!link && String(cobranca.metodo || "") === "cartao",
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
        cobranca: cobranca,
        hintAnterior: cobranca && RETRYABLE[status] ? "Última tentativa falhou" : null,
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
        cobranca: cobranca,
      });
    }

    if (classif === "nao_comissionada") {
      var hint = null;
      if (cobranca && RETRYABLE[status]) {
        if (status === "canceled") hint = "Última cobrança cancelada";
        else if (status === "expired") hint = "Última cobrança expirou";
        else hint = "Última tentativa falhou";
      }
      return baseState({
        kind: hint ? "nova_tentativa" : "cobrar",
        listaLabel: hint ? "Nova cobrança" : "Gerar e enviar link de pagamento",
        detalheTexto: hint
          ? hint + ". Você pode gerar um novo link de pagamento."
          : "Reserva não comissionada com pagamento pendente. Informe o valor e gere o link de pagamento.",
        variant: "warn",
        ctaKind: "pagarme_cobrar",
        ctaLabel: hint ? "Nova cobrança" : "Gerar e enviar link de pagamento",
        cobranca: cobranca,
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

  function parseBRLToCentavos(input) {
    var raw = String(input == null ? "" : input).trim();
    if (!raw) return { ok: false, reason: "vazio" };
    var s = raw.replace(/R\$\s*/gi, "").replace(/\s/g, "");
    if (!s) return { ok: false, reason: "vazio" };
    if (s.charAt(0) === "-") return { ok: false, reason: "negativo" };
    if (!/^[\d.,]+$/.test(s)) return { ok: false, reason: "formato" };
    if (s.indexOf(",") >= 0) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
      s = s.replace(/\./g, "");
    }
    var n = Number(s);
    if (!isFinite(n) || isNaN(n)) return { ok: false, reason: "nan" };
    if (n <= 0) return { ok: false, reason: "nao_positivo" };
    var centavos = Math.round(n * 100);
    if (!isFinite(centavos) || centavos <= 0) return { ok: false, reason: "centavos" };
    return { ok: true, centavos: centavos };
  }

  function formatCentavosToBRL(centavos) {
    var n = Number(centavos);
    if (!isFinite(n)) return "R$ —";
    try {
      return (n / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
    } catch (_e) {
      return "R$ " + (n / 100).toFixed(2).replace(".", ",");
    }
  }

  /** Formatação visual do campo "Valor a cobrar" (blur). Inválido permanece como digitado. */
  function formatBRLInputDisplay(input) {
    var raw = String(input == null ? "" : input);
    if (!String(raw).trim()) return "";
    var parsed = parseBRLToCentavos(raw);
    if (!parsed.ok) return raw;
    try {
      return new Intl.NumberFormat("pt-BR", {
        style: "currency",
        currency: "BRL",
      }).format(parsed.centavos / 100);
    } catch (_e) {
      return formatCentavosToBRL(parsed.centavos);
    }
  }

  /** Valor mais simples para edição no focus (sem símbolo R$). */
  function toBRLInputEditValue(input) {
    var raw = String(input == null ? "" : input);
    if (!String(raw).trim()) return "";
    var parsed = parseBRLToCentavos(raw);
    if (!parsed.ok) return raw;
    try {
      return new Intl.NumberFormat("pt-BR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(parsed.centavos / 100);
    } catch (_e) {
      return (parsed.centavos / 100).toFixed(2).replace(".", ",");
    }
  }

  function mapPagarmeAdminError(input) {
    input = input || {};
    var code = String(input.code || "").trim();
    var http = Number(input.httpStatus || 0);
    var msg = String(input.message || "").trim();
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
      detail: code ? "Código: " + code : "Tente novamente após atualizar o status.",
      ambiguous: false,
    };
  }

  function isPagarmeDirectPaymentBadgeType(statusType) {
    var t = String(statusType == null ? "" : statusType).trim();
    return t === "pendente-pagamento" || t === "pagarme-pago-hits-pendente";
  }

  function resolvePagarmeModalPresentation(payUi) {
    payUi = payUi || {};
    var status = asStatus(payUi.cobranca && payUi.cobranca.status);
    var hasLink = !!payUi.paymentLinkUrl;
    var showLinkActions = !!(payUi.canOpenLink || payUi.canCopyLink);

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
        showLinkActions: showLinkActions,
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
        showLinkActions: showLinkActions,
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
          showLinkActions: showLinkActions,
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
        showLinkActions: showLinkActions,
        allowSendActions: hasLink,
      };
    }
    if (payUi.kind === "cobrar" || payUi.kind === "nova_tentativa") {
      return {
        title: "Pagamento pendente",
        subtitle: "Gerar e enviar link de pagamento",
        generateLabel: "Gerar link de pagamento",
        linkSectionTitle: null,
        showGenerate: !!payUi.showGerarCartao,
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

  var api = {
    isPagarmeUiEnabled: isPagarmeUiEnabled,
    shouldFetchPagarmeCobrancas: shouldFetchPagarmeCobrancas,
    resolveOperacionalPaymentUi: resolveOperacionalPaymentUi,
    resolvePaymentUiState: resolvePaymentUiState,
    pickRelevantCobranca: pickRelevantCobranca,
    paymentLinkUrlOf: paymentLinkUrlOf,
    isSafeHttpsPaymentLinkUrl: isSafeHttpsPaymentLinkUrl,
    isPagarmeDirectPaymentBadgeType: isPagarmeDirectPaymentBadgeType,
    resolvePagarmeModalPresentation: resolvePagarmeModalPresentation,
    parseBRLToCentavos: parseBRLToCentavos,
    formatCentavosToBRL: formatCentavosToBRL,
    formatBRLInputDisplay: formatBRLInputDisplay,
    toBRLInputEditValue: toBRLInputEditValue,
    mapPagarmeAdminError: mapPagarmeAdminError,
  };

  global.YesPagarmePaymentUi = api;
})(typeof window !== "undefined" ? window : globalThis);
