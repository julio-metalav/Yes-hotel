/**
 * Testes: access-grace-messages (sem I/O).
 */
import assert from "node:assert/strict";
import {
  assertMessageHasNoTechnicalJargon,
  buildAccessRestoredMessage,
  buildWelcomePendingMessage,
} from "../src/lib/domain/yes-hotel/access-grace-messages";

// 25) somente pagamento
{
  const m = buildWelcomePendingMessage({ payment_pending: true, fnrh_pending: false });
  assert.ok(m);
  assert.equal(m!.kind, "welcome_payment_only");
  assert.equal(
    m!.body,
    "Bem-vindo ao Yes Hotel. O pagamento da sua reserva ainda está pendente. Regularize em até 1 hora para evitar a suspensão temporária das senhas de acesso ao quarto e aos portões.",
  );
  assertMessageHasNoTechnicalJargon(m!.body);
}

// 26) somente FNRH
{
  const m = buildWelcomePendingMessage({ payment_pending: false, fnrh_pending: true });
  assert.ok(m);
  assert.equal(m!.kind, "welcome_fnrh_only");
  assert.equal(
    m!.body,
    "Bem-vindo ao Yes Hotel. Ainda existem fichas de hóspedes pendentes nesta reserva. Regularize em até 1 hora para evitar a suspensão temporária das senhas de acesso ao quarto e aos portões.",
  );
}

// 27) ambas
{
  const m = buildWelcomePendingMessage({ payment_pending: true, fnrh_pending: true });
  assert.ok(m);
  assert.equal(m!.kind, "welcome_payment_and_fnrh");
  assert.equal(
    m!.body,
    "Bem-vindo ao Yes Hotel. O pagamento e o preenchimento das fichas de hóspedes ainda estão pendentes. Regularize em até 1 hora para evitar a suspensão temporária das senhas de acesso ao quarto e aos portões.",
  );
}

// sem pendência → sem mensagem de cobrança
{
  const m = buildWelcomePendingMessage({ payment_pending: false, fnrh_pending: false });
  assert.equal(m, null);
}

// restauração
{
  const m = buildAccessRestoredMessage();
  assert.equal(
    m.body,
    "As pendências da sua reserva foram regularizadas e seus acessos foram restabelecidos.",
  );
}

// 28) nenhuma mensagem contém TTLock
{
  const all = [
    buildWelcomePendingMessage({ payment_pending: true, fnrh_pending: false })!.body,
    buildWelcomePendingMessage({ payment_pending: false, fnrh_pending: true })!.body,
    buildWelcomePendingMessage({ payment_pending: true, fnrh_pending: true })!.body,
    buildAccessRestoredMessage().body,
  ];
  for (const body of all) {
    assert.equal(/ttlock/i.test(body), false);
    assertMessageHasNoTechnicalJargon(body);
  }
}

console.log("OK test-access-grace-messages");
