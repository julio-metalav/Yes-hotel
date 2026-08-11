/**
 * Testes estáticos do wiring UX: badge "Pendente pagamento" => cobrança direta.
 * Não abre browser; valida contratos no HTML/JS do painel operacional.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const js = readFileSync(resolve(root, "ui/checkin-operacional-mvp.js"), "utf8");
const html = readFileSync(resolve(root, "ui/checkin-operacional-mvp.html"), "utf8");
const css = readFileSync(resolve(root, "ui/checkin-operacional-mvp.css"), "utf8");
const mirror = readFileSync(resolve(root, "ui/yes-pagarme-payment-ui.js"), "utf8");

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  OK ", name);
}

{
  assert.match(js, /data-payment-badge/);
  assert.match(js, /function renderOperacionalStatusBadgeHtml/);
  assert.match(js, /openPagarmeCobrancaModal\(id\)/);
  assert.match(js, /isPagarmeDirectPaymentBadgeType/);
  // Clique no badge NÃO deve chamar openDetail no handler do badge
  const badgeHandler = js.slice(
    js.indexOf('querySelectorAll("[data-payment-badge]")'),
    js.indexOf('querySelectorAll(".op-next-action-btn")'),
  );
  assert.match(badgeHandler, /openPagarmeCobrancaModal/);
  assert.doesNotMatch(badgeHandler, /openDetail\(/);
  ok("G/A wiring: badge => openPagarmeCobrancaModal (sem openDetail)");
}

{
  const verHandler = js.slice(
    js.indexOf('querySelectorAll(".op-btn-ver, .op-btn-more")'),
    js.indexOf('querySelectorAll("[data-payment-badge]")'),
  );
  assert.match(verHandler, /openDetail\(id\)/);
  assert.doesNotMatch(verHandler, /openPagarmeCobrancaModal/);
  ok("G/H wiring: Ver / ... => openDetail preservado");
}

{
  assert.match(js, /kind === "pagarme_cobrar"/);
  assert.match(
    js,
    /openDetailAndRunCta[\s\S]*?openPagarmeCobrancaModal\(reservaId\)/,
  );
  ok("I wiring: CTA pagarme_* abre modal financeiro direto");
}

{
  assert.match(html, /id="modal-pagarme-subtitle"/);
  assert.match(html, /Gerar e enviar link de pagamento/);
  assert.match(js, /resolvePagarmeModalPresentation/);
  assert.match(js, /Gerar link de pagamento/);
  assert.match(js, /Cadastre um contato para enviar o link/);
  assert.match(js, /Enviar por WhatsApp/);
  assert.match(js, /Enviar por e-mail/);
  assert.match(js, /disabled title="Envio DigiSac/);
  ok("modal: título/subtítulo + send prepared/disabled");
}

{
  assert.match(js, /function isPagarmeUiEnabledInPainel/);
  assert.match(js, /if \(!isPagarmeUiEnabledInPainel\(\)\) return;/);
  // Badge só vira botão com UI ON
  assert.match(
    js,
    /isPagarmeUiEnabledInPainel\(\)\s*&&[\s\S]*?isPagarmeDirectPaymentBadgeType/,
  );
  ok("J wiring: pagarmeUiEnabled OFF => badge não clicável / modal gated");
}

{
  assert.match(css, /\.op-badge--clickable/);
  assert.match(css, /\.modal-pagarme-subtitle/);
  assert.match(mirror, /resolvePagarmeModalPresentation/);
  assert.match(mirror, /isPagarmeDirectPaymentBadgeType/);
  ok("CSS/mirror: clickable + presentation espelhados");
}

{
  // Texto do status na tabela permanece "Pendente pagamento"
  assert.match(js, /label:\s*"Pendente pagamento"/);
  assert.match(js, /type:\s*"pendente-pagamento"/);
  ok("status visual: Pendente pagamento preservado");
}

console.log(`\n[test-pagarme-payment-badge-wiring] ${cases} assertions OK`);
