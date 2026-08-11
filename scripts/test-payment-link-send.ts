/**
 * Testes — envio Payment Link multicanal (política + guest-multichannel).
 * Casos A–F do briefing CP5.
 */
import assert from "node:assert/strict";
import {
  aggregateGuestChannelResults,
  assertSameGuestResource,
  planGuestChannels,
  shouldAttemptWhatsappAfterEmail,
} from "../supabase/functions/_shared/comunicacao-operacional/guest-multichannel.ts";
import {
  extractPaymentLinkUrl,
  paidMustNotCreateNewPaymentLink,
  resolvePaymentLinkForSend,
  sendMustNotCreateCobranca,
} from "../src/lib/domain/yes-hotel/payment-link-send-policy.ts";

let passed = 0;
function ok(label: string) {
  passed++;
  console.log(`OK  ${label}`);
}

const LINK = "https://payment-link.pagar.me/pl_abc123";
const LINK_OTHER = "https://payment-link.pagar.me/pl_OTHER";

const cobPending = {
  id: "cob-1",
  status: "pending",
  pagarme_payment_link_url: LINK,
};

// A. Payment Link + dois contatos => ambos canais tentados
{
  const plan = planGuestChannels("bsantoriano@gmail.com", "67999081337");
  assert.equal(plan.tryEmail && plan.tryWhatsapp, true);
  assert.equal(shouldAttemptWhatsappAfterEmail(plan, true), true);
  const resolved = resolvePaymentLinkForSend({ cobrancas: [cobPending] });
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.paymentLinkUrl, LINK);
  ok("A. dois contatos + link => ambos canais");
}

// B. mesmo URL nos dois
{
  assert.equal(assertSameGuestResource(LINK, LINK), true);
  assert.equal(assertSameGuestResource(LINK, LINK_OTHER), false);
  ok("B. mesmo Payment Link nos dois canais");
}

// C. exatamente uma cobrança/link para envio
{
  const resolved = resolvePaymentLinkForSend({
    cobrancas: [
      cobPending,
      { id: "cob-old", status: "canceled", pagarme_payment_link_url: LINK_OTHER },
    ],
  });
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.cobrancaId, "cob-1");
    assert.equal(resolved.paymentLinkUrl, LINK);
  }
  ok("C. resolve uma cobrança ativa com 1 link");
}

// D. falha parcial não cria novo link
{
  const before = extractPaymentLinkUrl(cobPending);
  const agg = aggregateGuestChannelResults(
    { status: "enviado" },
    { status: "falhou", error: "DigiSac 400" },
  );
  assert.equal(agg.delivered, true);
  assert.equal(sendMustNotCreateCobranca(), true);
  assert.equal(extractPaymentLinkUrl(cobPending), before);
  ok("D. parcial não cria novo link");
}

// E. reenvio reutiliza o mesmo Payment Link
{
  const first = resolvePaymentLinkForSend({ cobrancas: [cobPending] });
  const second = resolvePaymentLinkForSend({
    cobrancas: [cobPending],
    cobrancaId: "cob-1",
  });
  assert.equal(first.ok && second.ok, true);
  if (first.ok && second.ok) {
    assert.equal(first.paymentLinkUrl, second.paymentLinkUrl);
    assert.equal(first.cobrancaId, second.cobrancaId);
  }
  ok("E. reenvio reutiliza o mesmo link");
}

// F. paid nunca gera novo link (envio recusa status paid)
{
  assert.equal(paidMustNotCreateNewPaymentLink("paid"), true);
  const paid = resolvePaymentLinkForSend({
    cobrancas: [
      {
        id: "cob-paid",
        status: "paid",
        pagarme_payment_link_url: LINK,
      },
    ],
  });
  assert.equal(paid.ok, false);
  if (!paid.ok) assert.equal(paid.error, "cobranca_nao_encontrada");
  const paidExplicit = resolvePaymentLinkForSend({
    cobrancas: [
      {
        id: "cob-paid",
        status: "paid",
        pagarme_payment_link_url: LINK,
      },
    ],
    cobrancaId: "cob-paid",
  });
  assert.equal(paidExplicit.ok, false);
  if (!paidExplicit.ok) assert.equal(paidExplicit.error, "status_nao_permite_envio");
  ok("F. paid não permite envio/criação via resolve");
}

console.log(`\n${passed} checks passed.`);
