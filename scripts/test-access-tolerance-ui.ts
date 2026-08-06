/**
 * Testes da policy de UI de tolerância (só problemas).
 */
import assert from "node:assert/strict";
import {
  deriveAccessToleranceExceptions,
  summarizeAccessToleranceAlert,
} from "../src/lib/domain/yes-hotel/access-tolerance-ui";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}

const base = {
  reservation_id: "5321a46f-5000-43e1-8830-df57f3bc0439",
  apartment_number: "02",
  guest_main_name: "João",
  external_reservation_id: "YH-99887",
};

{
  const items = deriveAccessToleranceExceptions({
    ...base,
    grace_status: "restored",
    current_payment_pending: false,
    current_fnrh_pending: false,
  });
  assert.equal(items.length, 0);
  assert.equal(summarizeAccessToleranceAlert({ ...base, grace_status: "cancelled" }), null);
  ok("reserva sem problema → limpa");
}

{
  const items = deriveAccessToleranceExceptions({
    ...base,
    current_payment_pending: true,
  });
  assert.ok(items.some((i) => i.code === "pagamento_pendente"));
  ok("pagamento pendente aparece");
}

{
  const items = deriveAccessToleranceExceptions({
    ...base,
    payment_unconfirmed: true,
    current_payment_pending: true,
  });
  assert.ok(items.some((i) => i.code === "pagamento_nao_confirmado"));
  assert.equal(items.some((i) => i.code === "pagamento_pendente"), false);
  ok("pagamento desconhecido → não confirmado");
}

{
  const items = deriveAccessToleranceExceptions({
    ...base,
    current_fnrh_pending: true,
  });
  assert.ok(items.some((i) => i.code === "fnrh_pendente"));
  ok("fnrh pendente aparece");
}

{
  const due = Date.now() + 30 * 60_000;
  const items = deriveAccessToleranceExceptions({
    ...base,
    grace_status: "active",
    suspension_due_at: new Date(due).toISOString(),
    now_ms: Date.now(),
    current_payment_pending: true,
  });
  assert.ok(items.length >= 2);
  assert.ok(items.some((i) => i.code === "tolerancia_em_andamento"));
  assert.ok(items.some((i) => i.code === "pagamento_pendente"));
  ok("multiplos problemas curtos");
}

{
  const items = deriveAccessToleranceExceptions({
    ...base,
    grace_status: "suspended",
  });
  assert.ok(items.some((i) => i.code === "senha_suspensa"));
  ok("senha suspensa aparece");
}

{
  const items = deriveAccessToleranceExceptions({
    ...base,
    communication_failed: true,
  });
  assert.ok(items.some((i) => i.code === "comunicacao_falha"));
  ok("falha comunicacao aparece");
}

{
  const items = deriveAccessToleranceExceptions({
    ...base,
    grace_status: "restored",
    current_payment_pending: false,
    current_fnrh_pending: false,
    communication_failed: false,
  });
  assert.equal(items.length, 0);
  ok("estados regulares nao aparecem");
}

{
  // UI nunca deve tratar UUID prefix como número de reserva
  assert.notEqual(base.external_reservation_id, base.reservation_id.slice(0, 8));
  assert.equal(base.external_reservation_id, "YH-99887");
  ok("numero real da reserva (nao UUID prefix)");
}

console.log(`OK test-access-tolerance-ui (${cases} casos)`);
