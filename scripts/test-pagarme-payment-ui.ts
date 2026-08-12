/**
 * Testes da policy de UI Pagar.me (Checkpoint 3).
 */
import assert from "node:assert/strict";
import {
  formatBRLInputDisplay,
  formatCentavosToBRL,
  isPagarmeDirectPaymentBadgeType,
  isPagarmeUiEnabled,
  isSafeHttpsPaymentLinkUrl,
  mapPagarmeAdminError,
  parseBRLToCentavos,
  parseReservationBalanceDue,
  pickRelevantCobranca,
  resolveChargePrefillCentavos,
  resolveOperacionalPaymentUi,
  resolvePagarmeModalPresentation,
  resolvePaymentUiState,
  shouldFetchPagarmeCobrancas,
  toBRLInputEditValue,
  validateChargeAmountAgainstBalance,
} from "../src/lib/domain/yes-hotel/pagarme-payment-ui";

/** Intl pt-BR usa NBSP entre R$ e o valor; normaliza para assert estável. */
function normMoneyDisplay(s: string): string {
  return String(s).replace(/\u00a0/g, " ");
}

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  OK ", name);
}

function baseReserva(
  over: Partial<{
    pagamentoStatus: string;
    classificacaoComissionamento: string;
    perfilUsuario: string;
    reservationBalanceDue: unknown;
    cobrancas: Parameters<typeof resolvePaymentUiState>[0]["cobrancas"];
  }> = {},
) {
  return resolvePaymentUiState({
    pagamentoStatus: "pendente",
    classificacaoComissionamento: "desconhecida",
    perfilUsuario: "recepcao",
    cobrancas: [],
    ...over,
  });
}

{
  const s = baseReserva({ pagamentoStatus: "pago" });
  assert.equal(s.kind, "none");
  assert.equal(s.ctaKind, null);
  assert.equal(s.showGerarCartao, false);
  ok("1. HITS pago => sem cobrar");
}

{
  const s = baseReserva({ classificacaoComissionamento: "desconhecida" });
  assert.equal(s.kind, "classificar");
  assert.equal(s.ctaKind, "pagarme_classificar");
  assert.equal(s.showClassificar, true);
  ok("2. desconhecida => classificar");
}

{
  const s = baseReserva({ classificacaoComissionamento: "comissionada" });
  assert.equal(s.kind, "comissionada");
  assert.match(s.detalheTexto, /Não cobrar/);
  assert.equal(s.showGerarCartao, false);
  ok("3. comissionada => aviso / sem cobrar");
}

{
  const s = baseReserva({ classificacaoComissionamento: "nao_comissionada" });
  assert.equal(s.kind, "cobrar");
  assert.equal(s.ctaKind, "pagarme_cobrar");
  assert.equal(s.showGerarCartao, true);
  assert.equal(s.showValorInput, true);
  ok("4. nao_comissionada pendente => cobrar");
}

{
  for (const status of ["created", "pending", "processing"] as const) {
    const s = baseReserva({
      classificacaoComissionamento: "nao_comissionada",
      cobrancas: [
        {
          id: "c1",
          status,
          metodo: "cartao",
          payment_link_url: "https://payment-link-v3-sdx.pagar.me/pl_x",
        },
      ],
    });
    assert.equal(s.kind, "aguardando", status);
    assert.equal(s.canOpenLink, true, status);
    assert.equal(s.showGerarCartao, false, status);
  }
  ok("5-7. created/pending/processing => aguardando");
}

{
  const s = baseReserva({
    pagamentoStatus: "pendente",
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [{ id: "c1", status: "paid", metodo: "cartao" }],
  });
  assert.equal(s.kind, "pago_pagarme_hits_pendente");
  assert.match(s.detalheTexto, /HITS pendente/);
  assert.equal(s.showGerarCartao, false);
  assert.equal(s.situacaoLabel, "Pago no Pagar.me");
  assert.match(String(s.situacaoSubtexto || ""), /HITS pendente/);
  assert.match(String(s.statusBadgeLabel || ""), /Pago Pagar\.me/);
  assert.match(String(s.statusBadgeLabel || ""), /HITS pendente/);
  assert.notEqual(s.situacaoLabel, "Pendente pagamento");
  assert.notEqual(s.statusBadgeLabel, "Pendente pagamento");
  assert.equal(s.ctaLabel, "Ver cobrança");
  ok("8. paid + HITS pendente => pago Pagar.me / HITS pendente");
}

{
  for (const status of ["failed", "expired", "canceled"] as const) {
    const s = baseReserva({
      classificacaoComissionamento: "nao_comissionada",
      cobrancas: [{ id: "c1", status, metodo: "cartao" }],
    });
    assert.equal(s.kind, "nova_tentativa", status);
    assert.equal(s.showGerarCartao, true, status);
    assert.ok(s.hintAnterior, status);
  }
  ok("9-11. failed/expired/canceled => pode nova tentativa");
}

{
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [{ id: "c1", status: "refunded" }],
  });
  assert.equal(s.kind, "revisao");
  assert.equal(s.showGerarCartao, false);
  ok("12. refunded => revisão / bloqueado");
}

{
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [{ id: "c1", status: "chargeback" }],
  });
  assert.equal(s.kind, "revisao");
  ok("13. chargeback => revisão / bloqueado");
}

{
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [
      {
        id: "c1",
        status: "pending",
        requer_revisao_operacional: true,
        requer_revisao_motivo: "underpaid",
      },
    ],
  });
  // revisão tem prioridade sobre bloqueante quando flag true
  assert.equal(s.kind, "revisao");
  assert.match(s.detalheTexto, /underpaid/);
  ok("14. requer_revisao_operacional => revisão");
}

{
  const s = baseReserva({ perfilUsuario: "cafe" });
  assert.equal(s.kind, "hidden_perfil");
  assert.equal(s.showGerarCartao, false);
  ok("15. perfil cafe => sem controles");
}

{
  const s = baseReserva({
    perfilUsuario: "admin",
    classificacaoComissionamento: "nao_comissionada",
  });
  assert.equal(s.kind, "cobrar");
  ok("16. admin => controles");
}

{
  const s = baseReserva({
    perfilUsuario: "recepcao",
    classificacaoComissionamento: "nao_comissionada",
  });
  assert.equal(s.kind, "cobrar");
  ok("17. recepcao => controles");
}

{
  assert.deepEqual(parseBRLToCentavos("R$ 1.800,00"), { ok: true, centavos: 180000 });
  assert.deepEqual(parseBRLToCentavos("R$ 17,50"), { ok: true, centavos: 1750 });
  assert.equal(parseBRLToCentavos("R$ 0").ok, false);
  assert.equal(parseBRLToCentavos("0").ok, false);
  assert.equal(parseBRLToCentavos("-10").ok, false);
  assert.equal(parseBRLToCentavos("").ok, false);
  assert.match(formatCentavosToBRL(180000), /1\.800,00/);
  ok("moeda BRL => centavos");
}

{
  assert.equal(normMoneyDisplay(formatBRLInputDisplay("1800,00")), "R$ 1.800,00");
  assert.equal(normMoneyDisplay(formatBRLInputDisplay("17,50")), "R$ 17,50");
  assert.equal(normMoneyDisplay(formatBRLInputDisplay("R$ 1.800,00")), "R$ 1.800,00");
  assert.equal(formatBRLInputDisplay(""), "");
  assert.equal(formatBRLInputDisplay("   "), "");
  assert.equal(formatBRLInputDisplay("abc"), "abc");
  assert.equal(formatBRLInputDisplay("R$ 0"), "R$ 0");
  const display1800 = formatBRLInputDisplay("1800,00");
  assert.deepEqual(parseBRLToCentavos(display1800), { ok: true, centavos: 180000 });
  assert.equal(toBRLInputEditValue("R$ 1.800,00"), "1.800,00");
  ok("display BRL input 1800,00 / 17,50 + parse formatado");
}

{
  const e = mapPagarmeAdminError({ code: "obrigacao_ja_paga", httpStatus: 409 });
  assert.match(e.title, /já confirmado/i);
  const amb = mapPagarmeAdminError({ code: "resultado_ambiguo", httpStatus: 502 });
  assert.equal(amb.ambiguous, true);
  ok("map erros admin");
}

{
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [
      { id: "old-failed", status: "failed", updated_at: "2026-08-01T10:00:00.000Z" },
      { id: "cur-paid", status: "paid", updated_at: "2026-08-10T10:00:00.000Z" },
    ],
  });
  assert.equal(s.kind, "pago_pagarme_hits_pendente");
  assert.notEqual(s.kind, "nova_tentativa");
  assert.equal(s.cobranca?.id, "cur-paid");
  ok("multi A: failed antiga + paid atual => pago_pagarme");
}

{
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [
      { id: "old-canceled", status: "canceled", updated_at: "2026-08-01T10:00:00.000Z" },
      { id: "cur-pending", status: "pending", updated_at: "2026-08-10T10:00:00.000Z" },
    ],
  });
  assert.equal(s.kind, "aguardando");
  assert.equal(s.cobranca?.id, "cur-pending");
  ok("multi B: canceled antiga + pending atual => aguardando");
}

{
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [
      { id: "old-failed", status: "failed", updated_at: "2026-08-01T10:00:00.000Z" },
      { id: "cur-processing", status: "processing", updated_at: "2026-08-10T10:00:00.000Z" },
    ],
  });
  assert.equal(s.kind, "aguardando");
  assert.equal(s.cobranca?.id, "cur-processing");
  ok("multi C: failed antiga + processing atual => aguardando");
}

{
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [
      { id: "old-failed", status: "failed", updated_at: "2026-08-01T10:00:00.000Z" },
      { id: "cur-refunded", status: "refunded", updated_at: "2026-08-10T10:00:00.000Z" },
    ],
  });
  assert.equal(s.kind, "revisao");
  assert.equal(s.cobranca?.id, "cur-refunded");
  ok("multi D: failed antiga + refunded atual => revisao");
}

{
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [
      { id: "old-canceled", status: "canceled", updated_at: "2026-08-01T10:00:00.000Z" },
      { id: "cur-chargeback", status: "chargeback", updated_at: "2026-08-10T10:00:00.000Z" },
    ],
  });
  assert.equal(s.kind, "revisao");
  assert.equal(s.cobranca?.id, "cur-chargeback");
  ok("multi E: canceled antiga + chargeback atual => revisao");
}

{
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [
      { id: "old-paid", status: "paid", updated_at: "2026-08-01T10:00:00.000Z" },
      { id: "new-failed", status: "failed", updated_at: "2026-08-10T10:00:00.000Z" },
    ],
  });
  assert.equal(s.kind, "pago_pagarme_hits_pendente");
  assert.equal(s.cobranca?.id, "old-paid");
  assert.notEqual(s.kind, "nova_tentativa");
  ok("multi F: failed mais recente + paid antiga => paid prevalece");
}

{
  const picked = pickRelevantCobranca([
    { id: "c-canceled", status: "canceled", updated_at: "2026-08-01T10:00:00.000Z" },
    { id: "c-failed", status: "failed", updated_at: "2026-08-10T12:00:00.000Z" },
  ]);
  assert.equal(picked?.id, "c-failed");
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    cobrancas: [
      { id: "c-canceled", status: "canceled", updated_at: "2026-08-01T10:00:00.000Z" },
      { id: "c-failed", status: "failed", updated_at: "2026-08-10T12:00:00.000Z" },
    ],
  });
  assert.equal(s.kind, "nova_tentativa");
  assert.equal(s.cobranca?.id, "c-failed");
  assert.notEqual(s.kind, "pago_pagarme_hits_pendente");
  assert.notEqual(s.kind, "aguardando");
  assert.notEqual(s.kind, "revisao");
  ok("multi G: canceled+failed => tentativa terminal mais recente");
}

{
  assert.equal(
    isSafeHttpsPaymentLinkUrl("https://payment-link-v3-sdx.pagar.me/abc"),
    true,
  );
  assert.equal(isSafeHttpsPaymentLinkUrl("https://exemplo.com/abc"), true);
  assert.equal(isSafeHttpsPaymentLinkUrl("http://exemplo.com/abc"), false);
  assert.equal(isSafeHttpsPaymentLinkUrl("javascript:alert(1)"), false);
  assert.equal(isSafeHttpsPaymentLinkUrl("data:text/html,hi"), false);
  assert.equal(isSafeHttpsPaymentLinkUrl("texto qualquer"), false);
  assert.equal(isSafeHttpsPaymentLinkUrl(""), false);
  assert.equal(isSafeHttpsPaymentLinkUrl(null), false);
  ok("URL https segura / protocolos bloqueados");
}

{
  assert.equal(isPagarmeUiEnabled(undefined), false);
  assert.equal(isPagarmeUiEnabled(null), false);
  assert.equal(isPagarmeUiEnabled(false), false);
  assert.equal(isPagarmeUiEnabled("true"), false);
  assert.equal(isPagarmeUiEnabled(1), false);
  assert.equal(isPagarmeUiEnabled({}), false);
  assert.equal(isPagarmeUiEnabled(true), true);
  ok("flag A-D: somente boolean true habilita (fail-closed)");
}

{
  const off = resolveOperacionalPaymentUi({
    pagarmeUiEnabled: false,
    pagamentoStatus: "pendente",
    classificacaoComissionamento: "desconhecida",
    perfilUsuario: "recepcao",
    cobrancas: [],
  });
  assert.equal(off.kind, "none");
  assert.notEqual(off.kind, "classificar");
  assert.equal(off.ctaKind, null);
  assert.equal(off.showClassificar, false);
  assert.equal(off.showGerarCartao, false);

  const absent = resolveOperacionalPaymentUi({
    pagamentoStatus: "pendente",
    classificacaoComissionamento: "desconhecida",
    perfilUsuario: "recepcao",
    cobrancas: [{ id: "c1", status: "paid", metodo: "cartao" }],
  });
  assert.equal(absent.kind, "none");
  assert.notEqual(absent.kind, "pago_pagarme_hits_pendente");
  assert.notEqual(absent.listaLabel, "Classificar cobrança");
  assert.notEqual(absent.listaLabel, "Pago no Pagar.me");
  ok("flag E: desligada + HITS pendente => sem Classificar/Cobrar/Pago Pagar.me");
}

{
  assert.equal(shouldFetchPagarmeCobrancas(undefined), false);
  assert.equal(shouldFetchPagarmeCobrancas(false), false);
  assert.equal(shouldFetchPagarmeCobrancas("true"), false);
  assert.equal(shouldFetchPagarmeCobrancas(true), true);
  ok("flag F: attach/batch só consulta com flag true");
}

{
  const onClassificar = resolveOperacionalPaymentUi({
    pagarmeUiEnabled: true,
    pagamentoStatus: "pendente",
    classificacaoComissionamento: "desconhecida",
    perfilUsuario: "recepcao",
    cobrancas: [],
  });
  assert.equal(onClassificar.kind, "classificar");
  assert.equal(onClassificar.ctaKind, "pagarme_classificar");

  const onPago = resolveOperacionalPaymentUi({
    pagarmeUiEnabled: true,
    pagamentoStatus: "pendente",
    classificacaoComissionamento: "nao_comissionada",
    perfilUsuario: "recepcao",
    cobrancas: [{ id: "c1", status: "paid", metodo: "cartao" }],
  });
  assert.equal(onPago.kind, "pago_pagarme_hits_pendente");
  assert.equal(onPago.situacaoLabel, "Pago no Pagar.me");
  assert.match(String(onPago.situacaoSubtexto || ""), /HITS pendente/);
  assert.equal(onPago.ctaLabel, "Ver cobrança");

  const onCobrar = resolveOperacionalPaymentUi({
    pagarmeUiEnabled: true,
    pagamentoStatus: "pendente",
    classificacaoComissionamento: "nao_comissionada",
    perfilUsuario: "recepcao",
    cobrancas: [],
  });
  assert.equal(onCobrar.kind, "cobrar");
  assert.equal(onCobrar.showGerarCartao, true);
  ok("flag G: true preserva estados CP3 homologados");
}

{
  assert.equal(isPagarmeDirectPaymentBadgeType("pendente-pagamento"), true);
  assert.equal(isPagarmeDirectPaymentBadgeType("pagarme-pago-hits-pendente"), true);
  assert.equal(isPagarmeDirectPaymentBadgeType("ok"), false);
  assert.equal(isPagarmeDirectPaymentBadgeType("fnrh-pendente"), false);
  ok("UX A0: badge types diretos de pagamento");

  // A. pending sem link => modal gerar
  {
    const s = baseReserva({ classificacaoComissionamento: "nao_comissionada" });
    assert.equal(s.kind, "cobrar");
    assert.equal(s.showGerarCartao, true);
    const p = resolvePagarmeModalPresentation(s);
    assert.equal(p.title, "Pagamento pendente");
    assert.equal(p.subtitle, "Gerar e enviar link de pagamento");
    assert.equal(p.generateLabel, "Gerar link de pagamento");
    assert.equal(p.showGenerate, true);
    assert.equal(p.showLinkActions, false);
    assert.equal(p.allowSendActions, false);
    assert.doesNotMatch(s.ctaLabel || "", /credenciais/i);
    ok("UX A: pending sem link => Gerar link");
  }

  // B. pending com link existente => reutilizar, zero create
  {
    const s = baseReserva({
      classificacaoComissionamento: "nao_comissionada",
      cobrancas: [
        {
          id: "c-link",
          status: "pending",
          metodo: "cartao",
          payment_link_url: "https://payment-link-v3.pagar.me/pl_existente",
        },
      ],
    });
    assert.equal(s.kind, "aguardando");
    assert.equal(s.showGerarCartao, false);
    assert.equal(s.canOpenLink, true);
    assert.equal(s.canCopyLink, true);
    assert.equal(s.cobranca?.id, "c-link");
    const p = resolvePagarmeModalPresentation(s);
    assert.equal(p.title, "Pagamento pendente");
    assert.equal(p.subtitle, "Link de pagamento já gerado");
    assert.equal(p.linkSectionTitle, "Link de pagamento já gerado");
    assert.equal(p.showGenerate, false);
    assert.equal(p.showLinkActions, true);
    assert.equal(p.allowSendActions, true);
    ok("UX B: pending com link => reutilizar / zero create");
  }

  // C. processing => zero nova cobrança
  {
    const s = baseReserva({
      classificacaoComissionamento: "nao_comissionada",
      cobrancas: [
        {
          id: "c-proc",
          status: "processing",
          metodo: "cartao",
          payment_link_url: "https://payment-link-v3.pagar.me/pl_proc",
        },
      ],
    });
    assert.equal(s.kind, "aguardando");
    assert.equal(s.showGerarCartao, false);
    const p = resolvePagarmeModalPresentation(s);
    assert.equal(p.title, "Pagamento em processamento");
    assert.equal(p.showGenerate, false);
    assert.equal(p.showLinkActions, true);
    assert.equal(p.allowSendActions, false);
    ok("UX C: processing => zero nova cobrança");
  }

  // D. paid => zero ação de cobrança
  {
    const s = baseReserva({
      classificacaoComissionamento: "nao_comissionada",
      cobrancas: [{ id: "c-paid", status: "paid", metodo: "cartao" }],
    });
    assert.equal(s.kind, "pago_pagarme_hits_pendente");
    assert.equal(s.showGerarCartao, false);
    const p = resolvePagarmeModalPresentation(s);
    assert.equal(p.title, "Pago no Pagar.me");
    assert.match(String(p.subtitle || ""), /HITS pendente/);
    assert.equal(p.showGenerate, false);
    assert.equal(p.allowSendActions, false);
    ok("UX D: paid => zero ação de cobrança");
  }

  // E. comissionada => bloqueia
  {
    const s = baseReserva({ classificacaoComissionamento: "comissionada" });
    assert.equal(s.kind, "comissionada");
    assert.equal(s.showGerarCartao, false);
    assert.match(s.detalheTexto, /Não cobrar o hóspede/);
    const p = resolvePagarmeModalPresentation(s);
    assert.equal(p.title, "Reserva comissionada");
    assert.match(String(p.subtitle || ""), /Não cobrar o hóspede/);
    assert.equal(p.showGenerate, false);
    ok("UX E: comissionada bloqueada");
  }

  // F. desconhecida => exige classificação
  {
    const s = baseReserva({ classificacaoComissionamento: "desconhecida" });
    assert.equal(s.kind, "classificar");
    assert.equal(s.showClassificar, true);
    assert.equal(s.showGerarCartao, false);
    const p = resolvePagarmeModalPresentation(s);
    assert.equal(p.title, "Classificar cobrança");
    assert.equal(p.showGenerate, false);
    ok("UX F: desconhecida exige classificação");
  }

  // I. CTA financeiro (não credenciais) para pending cobrável
  {
    const s = baseReserva({ classificacaoComissionamento: "nao_comissionada" });
    assert.equal(s.ctaKind, "pagarme_cobrar");
    assert.match(String(s.ctaLabel || ""), /link de pagamento/i);
    assert.doesNotMatch(String(s.ctaLabel || ""), /credenciais/i);
    ok("UX I: CTA financeiro prioriza link (não credenciais)");
  }

  // J. flag OFF fail-closed (já coberto acima; reforço presentation)
  {
    const off = resolveOperacionalPaymentUi({
      pagarmeUiEnabled: false,
      pagamentoStatus: "pendente",
      classificacaoComissionamento: "nao_comissionada",
      perfilUsuario: "recepcao",
      cobrancas: [],
    });
    assert.equal(off.kind, "none");
    assert.equal(off.showGerarCartao, false);
    assert.equal(off.ctaKind, null);
    const p = resolvePagarmeModalPresentation(off);
    assert.equal(p.showGenerate, false);
    ok("UX J: pagarmeUiEnabled OFF => fail-closed sem controles");
  }
}

// --- Prefill saldo / validação parcial ---
{
  assert.equal(resolveChargePrefillCentavos(10), 1000);
  assert.equal(normMoneyDisplay(formatCentavosToBRL(1000)), "R$ 10,00");
  assert.equal(resolveChargePrefillCentavos(250.75), 25075);
  assert.equal(normMoneyDisplay(formatCentavosToBRL(25075)), "R$ 250,75");
  assert.equal(resolveChargePrefillCentavos(null), null);
  assert.equal(resolveChargePrefillCentavos(0), null);
  ok("A. saldo 10.00 → prefill R$ 10,00 (dinamico)");
}

{
  const ok5 = validateChargeAmountAgainstBalance({ amountCentavos: 500, balanceDue: 10 });
  assert.equal(ok5.ok, true);
  const ok10 = validateChargeAmountAgainstBalance({ amountCentavos: 1000, balanceDue: 10 });
  assert.equal(ok10.ok, true);
  const rej = validateChargeAmountAgainstBalance({ amountCentavos: 1001, balanceDue: 10 });
  assert.equal(rej.ok, false);
  if (!rej.ok) assert.equal(rej.reason, "valor_acima_saldo");
  const zero = validateChargeAmountAgainstBalance({ amountCentavos: 0, balanceDue: 10 });
  assert.equal(zero.ok, false);
  const neg = parseBRLToCentavos("-1,00");
  assert.equal(neg.ok, false);
  const nullBal = validateChargeAmountAgainstBalance({ amountCentavos: 100, balanceDue: null });
  assert.equal(nullBal.ok, false);
  if (!nullBal.ok) assert.equal(nullBal.reason, "saldo_indisponivel");
  ok("C-H. validacao amount vs saldo (parcial/max/zero/neg/null)");
}

{
  const s = baseReserva({
    classificacaoComissionamento: "comissionada",
    reservationBalanceDue: 10,
  });
  assert.equal(s.kind, "comissionada");
  assert.equal(s.showGerarCartao, false);
  ok("I. comissionada bloqueada mesmo com saldo");
}

{
  const s = baseReserva({
    classificacaoComissionamento: "nao_comissionada",
    reservationBalanceDue: 300,
    cobrancas: [{ id: "c-paid", status: "paid", metodo: "cartao", valor_centavos: 20000 }],
  });
  assert.equal(s.kind, "nova_tentativa");
  assert.equal(s.showGerarCartao, true);
  assert.equal(s.showValorInput, true);
  assert.match(String(s.hintAnterior || ""), /parcial/i);
  ok("M. paid + saldo restante => pode segunda cobranca");
}

{
  assert.equal(parseReservationBalanceDue(10).ok, true);
  if (parseReservationBalanceDue(10).ok) {
    assert.equal(parseReservationBalanceDue(10).centavos, 1000);
  }
  ok("parseReservationBalanceDue: 10.00 → 1000 centavos");
}

console.log(`\n[test-pagarme-payment-ui] ${cases} assertions OK`);
