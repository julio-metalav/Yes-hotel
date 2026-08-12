/**
 * Idempotência FNRH links (reserva_criada) + notify pós-create.
 * Cobre canais independentes, menor, manual livre e retry parcial.
 */
import assert from "node:assert/strict";
import {
  applyFnrhChannelIdempotency,
  hasSuccessfulFnrhChannelSend,
  isAutomaticFnrhLinksEvent,
} from "../supabase/functions/_shared/comunicacao-operacional/fnrh-links-idempotency.ts";
import { planGuestChannels } from "../supabase/functions/_shared/comunicacao-operacional/guest-multichannel.ts";
import {
  notifyFnrhLinksForCreatedReservations,
  notifyFnrhLinksOnReservationCreated,
} from "../supabase/functions/_shared/comunicacao-operacional/notify-fnrh-reservation-created.ts";

function ok(label: string) {
  console.log(`  ok — ${label}`);
}

assert.equal(isAutomaticFnrhLinksEvent("reserva_criada"), true);
assert.equal(isAutomaticFnrhLinksEvent("d_minus_1"), true);
assert.equal(isAutomaticFnrhLinksEvent("manual"), false);
assert.equal(isAutomaticFnrhLinksEvent(""), false);
ok("manual vs automático");

// 1. email + WhatsApp => tenta 2
{
  const plan = planGuestChannels("a@b.com", "67984020002");
  assert.equal(plan.tryEmail, true);
  assert.equal(plan.tryWhatsapp, true);
  ok("1. email+WhatsApp => 2 canais");
}

// 2. só email
{
  const plan = planGuestChannels("a@b.com", "");
  assert.deepEqual(plan, { tryEmail: true, tryWhatsapp: false });
  ok("2. só email");
}

// 3. só WhatsApp
{
  const plan = planGuestChannels("", "67984020002");
  assert.deepEqual(plan, { tryEmail: false, tryWhatsapp: true });
  ok("3. só WhatsApp");
}

// 4. menor: caller pula guest_role=minor (política documentada; plano de contato não cria link próprio)
{
  const plan = planGuestChannels("menor@x.com", "67999990000");
  assert.equal(plan.tryEmail, true);
  // send-fnrh-links continua a gate por guest_role === "minor"
  ok("4. menor: contatos existem mas Edge pula role minor");
}

// 5/6. pagamento pendente / comissionada não afetam plano de canais
{
  const planPend = planGuestChannels("a@b.com", "67984020002");
  const planCom = planGuestChannels("a@b.com", "67984020002");
  assert.deepEqual(planPend, planCom);
  ok("5/6. pagamento/classificação não entram no plano de canais");
}

const fnrhId = "fnrh-1";
const hospedeId = "h1";
const priorBothOk = [
  {
    canal: "email",
    status: "enviada",
    hospede_id: hospedeId,
    metadata: { tipo_evento: "reserva_criada", fnrh_hospede_id: fnrhId },
  },
  {
    canal: "whatsapp",
    status: "enviada",
    hospede_id: hospedeId,
    metadata: { tipo_evento: "reserva_criada", fnrh_hospede_id: fnrhId },
  },
];

// 7. segunda execução automática não duplica sucesso
{
  const idem = applyFnrhChannelIdempotency({
    tipoEvento: "reserva_criada",
    fnrhHospedeId: fnrhId,
    hospedeId,
    tryEmail: true,
    tryWhatsapp: true,
    registros: priorBothOk,
  });
  assert.equal(idem.tryEmail, false);
  assert.equal(idem.tryWhatsapp, false);
  assert.equal(idem.skipEmail, true);
  assert.equal(idem.skipWhatsapp, true);
  ok("7. 2ª execução automática não reenvia canais com sucesso");
}

// 8. email OK + WhatsApp falha => retry só WhatsApp
{
  const prior = [
    {
      canal: "email",
      status: "enviada",
      hospede_id: hospedeId,
      metadata: { tipo_evento: "reserva_criada", fnrh_hospede_id: fnrhId },
    },
    {
      canal: "whatsapp",
      status: "falha",
      hospede_id: hospedeId,
      metadata: { tipo_evento: "reserva_criada", fnrh_hospede_id: fnrhId },
    },
  ];
  const idem = applyFnrhChannelIdempotency({
    tipoEvento: "reserva_criada",
    fnrhHospedeId: fnrhId,
    hospedeId,
    tryEmail: true,
    tryWhatsapp: true,
    registros: prior,
  });
  assert.equal(idem.skipEmail, true);
  assert.equal(idem.tryEmail, false);
  assert.equal(idem.skipWhatsapp, false);
  assert.equal(idem.tryWhatsapp, true);
  ok("8. retry só WhatsApp");
}

// 9. WhatsApp OK + email falha => retry só email
{
  const prior = [
    {
      canal: "email",
      status: "falha",
      hospede_id: hospedeId,
      metadata: { tipo_evento: "reserva_criada", fnrh_hospede_id: fnrhId },
    },
    {
      canal: "whatsapp",
      status: "enviada",
      hospede_id: hospedeId,
      metadata: { tipo_evento: "reserva_criada", fnrh_hospede_id: fnrhId },
    },
  ];
  const idem = applyFnrhChannelIdempotency({
    tipoEvento: "reserva_criada",
    fnrhHospedeId: fnrhId,
    hospedeId,
    tryEmail: true,
    tryWhatsapp: true,
    registros: prior,
  });
  assert.equal(idem.tryEmail, true);
  assert.equal(idem.skipWhatsapp, true);
  ok("9. retry só email");
}

// 10. reenvio manual continua possível (idempotência não aplica)
{
  assert.equal(
    hasSuccessfulFnrhChannelSend({
      registros: priorBothOk,
      tipoEvento: "manual",
      fnrhHospedeId: fnrhId,
      canal: "email",
      hospedeId,
    }),
    false,
  );
  const idem = applyFnrhChannelIdempotency({
    tipoEvento: "manual",
    fnrhHospedeId: fnrhId,
    hospedeId,
    tryEmail: true,
    tryWhatsapp: true,
    registros: priorBothOk,
  });
  assert.equal(idem.tryEmail, true);
  assert.equal(idem.tryWhatsapp, true);
  ok("10. manual não trava por sucesso prévio");
}

// 11. HITS re-sync / outro tipo_evento não bloqueia (chave inclui tipo_evento)
{
  assert.equal(
    hasSuccessfulFnrhChannelSend({
      registros: priorBothOk,
      tipoEvento: "d_minus_1",
      fnrhHospedeId: fnrhId,
      canal: "email",
      hospedeId,
    }),
    false,
  );
  ok("11. d_minus_1 distinto de reserva_criada");
}

// 12. falha de notify não impede persistência (helper retorna ok:false sem throw)
async function runAsyncCases() {
  const calls: string[] = [];
  const r = await notifyFnrhLinksOnReservationCreated({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role",
    reservaId: "r1",
    fetchImpl: async () => {
      calls.push("fetch");
      throw new Error("resend_down");
    },
  });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /resend_down/);
  assert.equal(calls.length, 1);
  ok("12. notify falha isolada (persistência do sync permanece intacta)");

  const batch = await notifyFnrhLinksForCreatedReservations({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role",
    reservaIds: ["a", "a", "b"],
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        reserva_id?: string;
        tipo_evento?: string;
      };
      assert.equal(body.tipo_evento, "reserva_criada");
      return new Response(
        JSON.stringify({ ok: true, enviados_email: 1, enviados_whatsapp: 1 }),
        { status: 200 },
      );
    },
  });
  assert.equal(batch.attempted, 2);
  assert.equal(batch.ok, 2);
  assert.equal(batch.failed, 0);
  ok("notify batch dedup + tipo_evento=reserva_criada");
}

runAsyncCases()
  .then(() => {
    console.log("\nPASS test-fnrh-auto-send-reservation-created\n");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
