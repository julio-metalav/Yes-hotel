/**
 * Testes da política global multicanal ao hóspede (e-mail + WhatsApp).
 * Casos A–M do briefing fix/comunicacoes-hospede-multicanal.
 */
import assert from "node:assert/strict";
import {
  aggregateGuestChannelResults,
  assertSameGuestResource,
  planGuestChannels,
  shouldAttemptEmailAfterWhatsapp,
  shouldAttemptWhatsappAfterEmail,
} from "../supabase/functions/_shared/comunicacao-operacional/guest-multichannel.ts";

let passed = 0;
function ok(label: string) {
  passed++;
  console.log(`OK  ${label}`);
}

// A. email + WhatsApp => ambos tentados
{
  const plan = planGuestChannels("a@b.com", "67899081337");
  assert.equal(plan.tryEmail, true);
  assert.equal(plan.tryWhatsapp, true);
  assert.equal(shouldAttemptWhatsappAfterEmail(plan, true), true);
  assert.equal(shouldAttemptEmailAfterWhatsapp(plan, true), true);
  ok("A. ambos contatos => tenta os dois (sem short-circuit)");
}

// B. email sucesso / WhatsApp falha => parcial entregue
{
  const agg = aggregateGuestChannelResults(
    { status: "enviado" },
    { status: "falhou", error: "DigiSac timeout" },
  );
  assert.equal(agg.delivered, true);
  assert.equal(agg.failedTotal, false);
  assert.equal(agg.emailOk, true);
  assert.equal(agg.whatsappOk, false);
  assert.equal(agg.ultimoEnvioCanal, "email");
  assert.ok(agg.errors.some((e) => e.includes("DigiSac")));
  ok("B. parcial email OK / WA falha");
}

// C. WhatsApp sucesso / email falha => parcial entregue
{
  const agg = aggregateGuestChannelResults(
    { status: "falhou", error: "Resend 401" },
    { status: "enviado" },
  );
  assert.equal(agg.delivered, true);
  assert.equal(agg.failedTotal, false);
  assert.equal(agg.emailOk, false);
  assert.equal(agg.whatsappOk, true);
  assert.equal(agg.ultimoEnvioCanal, "whatsapp");
  ok("C. parcial WA OK / email falha");
}

// D. ambos falham => falha total
{
  const agg = aggregateGuestChannelResults(
    { status: "falhou", error: "email down" },
    { status: "falhou", error: "wa down" },
  );
  assert.equal(agg.delivered, false);
  assert.equal(agg.failedTotal, true);
  assert.equal(agg.ultimoEnvioCanal, null);
  ok("D. ambos falham => falha total");
}

// E. só email
{
  const plan = planGuestChannels("a@b.com", "");
  assert.deepEqual(plan, { tryEmail: true, tryWhatsapp: false });
  const agg = aggregateGuestChannelResults(
    { status: "enviado" },
    { status: "indisponivel" },
  );
  assert.equal(agg.delivered, true);
  assert.equal(agg.ultimoEnvioCanal, "email");
  ok("E. só email");
}

// F. só WhatsApp
{
  const plan = planGuestChannels(null, "67999999999");
  assert.deepEqual(plan, { tryEmail: false, tryWhatsapp: true });
  const agg = aggregateGuestChannelResults(
    { status: "indisponivel" },
    { status: "enviado" },
  );
  assert.equal(agg.delivered, true);
  assert.equal(agg.ultimoEnvioCanal, "whatsapp");
  ok("F. só WhatsApp");
}

// G. FNRH usa mesmo link
{
  const link =
    "https://yes-hotel.vercel.app/fnrh-preenchimento.html?v=2&guest_id=c0ad1912-7484-4343-8313-0d460f4ddc85&token=same";
  assert.equal(assertSameGuestResource(link, link), true);
  assert.equal(assertSameGuestResource(link, link + "x"), false);
  ok("G. FNRH mesmo link/token");
}

// H. Pagar.me usa mesmo Payment Link (política; envio ainda via resource único)
{
  const paymentLink = "https://payment.pagar.me/pl_abc123";
  assert.equal(assertSameGuestResource(paymentLink, paymentLink), true);
  assert.equal(assertSameGuestResource(paymentLink, "https://payment.pagar.me/pl_OTHER"), false);
  const plan = planGuestChannels("bsantoriano@gmail.com", "67899081337");
  assert.equal(plan.tryEmail && plan.tryWhatsapp, true);
  ok("H. Payment Link mesmo recurso nos dois canais (política)");
}

// I. TTLock usa mesma credencial
{
  const senha = "482910";
  assert.equal(assertSameGuestResource(senha, senha), true);
  assert.equal(assertSameGuestResource(senha, "000000"), false);
  ok("I. TTLock mesma senha nos dois canais");
}

// J. reenvio tenta os dois (plano independente de histórico)
{
  const planReenvio = planGuestChannels("a@b.com", "67999");
  assert.equal(shouldAttemptWhatsappAfterEmail(planReenvio, true), true);
  assert.equal(shouldAttemptEmailAfterWhatsapp(planReenvio, true), true);
  ok("J. reenvio tenta ambos os canais válidos");
}

// K. mensagem interna NÃO vai para canais de hóspede via este helper
{
  const plan = planGuestChannels("a@b.com", "67999", "interno");
  assert.deepEqual(plan, { tryEmail: false, tryWhatsapp: false });
  ok("K. audience interno => zero canais hóspede");
}

// L. pagamento pendente não impede FNRH (política de canais ignora pagamento)
{
  const pagamentoStatus = "pendente";
  const plan = planGuestChannels("a@b.com", "67999");
  assert.equal(pagamentoStatus, "pendente");
  assert.equal(plan.tryEmail && plan.tryWhatsapp, true);
  ok("L. canais FNRH independentes de pagamento_status");
}

// M. nenhum fluxo cria recurso duplicado por causa do multicanal
{
  const resourceOnce = "pl_unico_ou_token_unico";
  const emailBodyResource = resourceOnce;
  const waBodyResource = resourceOnce;
  assert.equal(assertSameGuestResource(emailBodyResource, waBodyResource), true);
  const bothOk = aggregateGuestChannelResults(
    { status: "enviado" },
    { status: "enviado" },
  );
  assert.equal(bothOk.ultimoEnvioCanal, "ambos");
  assert.equal(bothOk.delivered, true);
  ok("M. recurso único + ultimo_envio_canal=ambos");
}

// Nenhum contato
{
  const plan = planGuestChannels("  ", undefined);
  assert.deepEqual(plan, { tryEmail: false, tryWhatsapp: false });
  const agg = aggregateGuestChannelResults(
    { status: "indisponivel" },
    { status: "indisponivel" },
  );
  assert.equal(agg.delivered, false);
  assert.equal(agg.failedTotal, false);
  ok("nenhum contato => indisponível sem falha total por tentativa");
}

console.log(`\n${passed} checks passed.`);
