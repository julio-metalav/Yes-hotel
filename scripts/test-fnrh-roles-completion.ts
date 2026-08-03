/**
 * Testes PR4 — papéis FNRH, conclusão por papel, agregado, auditoria, adapter.
 */
import assert from "node:assert/strict";
import {
  evaluateFnrhCompletion,
  type FnrhCompletionPolicyInput,
  type GuestRoleDb,
} from "../src/lib/domain/yes-hotel/fnrh-completion-policy";
import { evaluateReservationFnrhState } from "../src/lib/domain/yes-hotel/reservation-fnrh-state";
import {
  assertAuditPayloadSafe,
  sanitizeFnrhAuditState,
} from "../src/lib/domain/yes-hotel/fnrh-audit-sanitize";
import { evaluateReservationPendingState } from "../src/lib/domain/yes-hotel/reservation-pending-state";
import {
  buildReservationPendingInputFromRows,
  FirstRoomAccessConfigurationError,
} from "../src/lib/infrastructure/supabase/yes-hotel/reservation-pending-mapper";

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

const G_PRIMARY = "11111111-1111-4111-8111-111111111111";
const G_COMPANION = "22222222-2222-4222-8222-222222222222";
const G_MINOR = "33333333-3333-4333-8333-333333333333";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function base(
  partial: Partial<FnrhCompletionPolicyInput> &
    Pick<FnrhCompletionPolicyInput, "guest_id" | "guest_role">,
): FnrhCompletionPolicyInput {
  return {
    fnrh_required: true,
    fnrh_status: "draft",
    has_required_core_fields: true,
    has_required_documents: true,
    has_contact_channel: true,
    has_facial: false,
    has_placa: false,
    ...partial,
  };
}

function main() {
  console.log("\n=== PR4 fnrh roles / completion ===\n");

  // 1 exatamente um principal — agregado
  {
    const r = evaluateReservationFnrhState([
      base({
        guest_id: G_PRIMARY,
        guest_role: "primary_adult",
        fnrh_status: "completed",
        confirmation_source: "guest",
        completed_by_guest_id: G_PRIMARY,
      }),
      base({
        guest_id: G_COMPANION,
        guest_role: "primary_adult",
        fnrh_status: "completed",
        confirmation_source: "guest",
        completed_by_guest_id: G_COMPANION,
      }),
    ]);
    assert.ok(r.configuration_errors.includes("multiple_primary_adults"));
    assert.equal(r.all_required_complete, false);
    ok("1/28 exatamente um principal — dois primary_adult → erro");
  }

  // 2 principal não pode ser menor (policy: role minor ≠ primary; domínio trata papéis separados)
  {
    const r = evaluateFnrhCompletion(
      base({
        guest_id: G_PRIMARY,
        guest_role: "primary_adult",
        // is_minor inconsistente seria barrado no SQL; aqui primary com status ok
        fnrh_status: "completed",
        confirmation_source: "guest",
        completed_by_guest_id: G_PRIMARY,
      }),
    );
    assert.equal(r.is_complete, true);
    ok("2 primary_adult completo (menor é papel separado)");
  }

  // 3 acompanhante exige confirmação individual
  {
    const r = evaluateFnrhCompletion(
      base({
        guest_id: G_COMPANION,
        guest_role: "adult_companion",
        fnrh_status: "awaiting_guest_confirmation",
        has_contact_channel: true,
      }),
    );
    assert.equal(r.is_pending, true);
    assert.ok(r.pending_reasons.includes("awaiting_guest_confirmation"));
    ok("3 acompanhante adulto exige confirmação individual");
  }

  // 4 preenchimento pelo principal não conclui acompanhante
  {
    const r = evaluateFnrhCompletion(
      base({
        guest_id: G_COMPANION,
        guest_role: "adult_companion",
        fnrh_status: "completed",
        confirmation_source: "responsible",
        completed_by_guest_id: G_PRIMARY,
        has_contact_channel: true,
      }),
    );
    assert.equal(r.is_complete, false);
    assert.ok(r.validation_errors.includes("adult_confirmed_by_responsible"));
    ok("4 preenchimento/confirmação pelo principal não conclui acompanhante");
  }

  // 5 acompanhante exige WhatsApp ou e-mail
  {
    const r = evaluateFnrhCompletion(
      base({
        guest_id: G_COMPANION,
        guest_role: "adult_companion",
        fnrh_status: "awaiting_guest_confirmation",
        has_contact_channel: false,
      }),
    );
    assert.ok(r.pending_reasons.includes("missing_contact_channel"));
    ok("5 acompanhante adulto exige canal de contato");
  }

  // 6 menor exige responsável
  {
    const r = evaluateFnrhCompletion(
      base({
        guest_id: G_MINOR,
        guest_role: "minor",
        responsible_guest_id: null,
        fnrh_status: "awaiting_responsible_confirmation",
        has_contact_channel: false,
      }),
    );
    assert.ok(r.pending_reasons.includes("minor_without_responsible"));
    ok("6 menor exige responsável");
  }

  // 7/8 responsável mesma reserva / adulto — coberto por trigger SQL; policy valida ator
  {
    const r = evaluateFnrhCompletion(
      base({
        guest_id: G_MINOR,
        guest_role: "minor",
        responsible_guest_id: G_PRIMARY,
        fnrh_status: "completed",
        confirmation_source: "responsible",
        completed_by_guest_id: G_COMPANION, // não é o responsável
      }),
    );
    assert.ok(r.validation_errors.includes("minor_confirmed_by_non_responsible"));
    ok("7/8/12 responsável deve ser o ator; não-responsável inválido");
  }

  // 9 menor não exige contato próprio
  {
    const r = evaluateFnrhCompletion(
      base({
        guest_id: G_MINOR,
        guest_role: "minor",
        responsible_guest_id: G_PRIMARY,
        fnrh_status: "completed",
        confirmation_source: "responsible",
        completed_by_guest_id: G_PRIMARY,
        has_contact_channel: false,
      }),
    );
    assert.equal(r.is_complete, true);
    assert.ok(!r.pending_reasons.includes("missing_contact_channel"));
    ok("9 menor não exige contato próprio");
  }

  // 10 menor não exige confirmação individual
  {
    const r = evaluateFnrhCompletion(
      base({
        guest_id: G_MINOR,
        guest_role: "minor",
        responsible_guest_id: G_PRIMARY,
        fnrh_status: "completed",
        confirmation_source: "guest",
        completed_by_guest_id: G_MINOR,
      }),
    );
    assert.equal(r.is_complete, false);
    assert.ok(r.validation_errors.includes("minor_cannot_self_confirm"));
    ok("10 menor não pode auto-confirmar");
  }

  // 11 menor concluído pelo responsável
  {
    const r = evaluateFnrhCompletion(
      base({
        guest_id: G_MINOR,
        guest_role: "minor",
        responsible_guest_id: G_PRIMARY,
        fnrh_status: "completed",
        confirmation_source: "responsible",
        completed_by_guest_id: G_PRIMARY,
      }),
    );
    assert.equal(r.is_complete, true);
    ok("11 menor concluído pelo responsável");
  }

  // 13/14 facial e placa não bloqueiam
  {
    const r = evaluateFnrhCompletion(
      base({
        guest_id: G_PRIMARY,
        guest_role: "primary_adult",
        fnrh_status: "completed",
        confirmation_source: "guest",
        completed_by_guest_id: G_PRIMARY,
        has_facial: false,
        has_placa: false,
      }),
    );
    assert.equal(r.is_complete, true);
    assert.ok(!r.pending_reasons.some((x) => x.includes("facial") || x.includes("placa")));
    ok("13/14 facial e placa ausentes não bloqueiam");
  }

  // 15-19 status
  for (const [status, pending] of [
    ["draft", true],
    ["awaiting_guest_confirmation", true],
    ["awaiting_responsible_confirmation", true],
    ["under_review", true],
    ["completed", false],
  ] as const) {
    const r = evaluateFnrhCompletion(
      base({
        guest_id: G_PRIMARY,
        guest_role: "primary_adult",
        fnrh_status: status,
        confirmation_source: status === "completed" ? "guest" : undefined,
        completed_by_guest_id: status === "completed" ? G_PRIMARY : undefined,
      }),
    );
    assert.equal(r.is_pending, pending);
    assert.equal(r.is_complete, !pending);
    ok(`15-19 ${status} → pending=${pending}`);
  }

  // 20 manually_completed com ator e justificativa
  {
    const r = evaluateFnrhCompletion(
      base({
        guest_id: G_COMPANION,
        guest_role: "adult_companion",
        fnrh_status: "manually_completed",
        completed_by_user_id: USER,
        manual_completion_reason: "Hóspede sem celular; recepção concluiu presencialmente.",
        confirmation_source: "reception",
        has_contact_channel: false,
      }),
    );
    assert.equal(r.is_complete, true);
    ok("20 manually_completed com auditoria é concluída");
  }

  // 21 manually_completed sem justificativa
  {
    const r = evaluateFnrhCompletion(
      base({
        guest_id: G_COMPANION,
        guest_role: "adult_companion",
        fnrh_status: "manually_completed",
        completed_by_user_id: USER,
        manual_completion_reason: "",
      }),
    );
    assert.equal(r.is_complete, false);
    assert.ok(r.validation_errors.includes("manual_completion_without_audit"));
    ok("21 manually_completed sem justificativa inválida");
  }

  // 22 waived com fundamento
  {
    const r = evaluateFnrhCompletion(
      base({
        guest_id: G_COMPANION,
        guest_role: "adult_companion",
        fnrh_status: "waived",
        waived_reason: "Dispensa legal documentada.",
        completed_by_user_id: USER,
      }),
    );
    assert.equal(r.is_complete, true);
    ok("22 waived com fundamento e auditoria");
  }

  // 23 waived sem fundamento
  {
    const r = evaluateFnrhCompletion(
      base({
        guest_id: G_COMPANION,
        guest_role: "adult_companion",
        fnrh_status: "waived",
        waived_reason: null,
        completed_by_user_id: USER,
      }),
    );
    assert.equal(r.is_complete, false);
    ok("23 waived sem fundamento inválido");
  }

  // 24 cancelled não é concluída
  {
    const r = evaluateFnrhCompletion(
      base({
        guest_id: G_COMPANION,
        guest_role: "adult_companion",
        fnrh_status: "cancelled",
      }),
    );
    assert.equal(r.is_required, false);
    assert.equal(r.is_complete, false);
    ok("24 cancelled não é concluída");
  }

  // 25 hóspede removido não conta
  {
    const r = evaluateReservationFnrhState([
      base({
        guest_id: G_PRIMARY,
        guest_role: "primary_adult",
        fnrh_status: "completed",
        confirmation_source: "guest",
        completed_by_guest_id: G_PRIMARY,
      }),
      base({
        guest_id: G_COMPANION,
        guest_role: "adult_companion",
        fnrh_status: "draft",
        is_removed_from_reservation: true,
      }),
    ]);
    assert.equal(r.required_fnrhs, 1);
    assert.equal(r.all_required_complete, true);
    ok("25 hóspede removido não conta como obrigatório");
  }

  // 26 sem papel → pendente
  {
    const r = evaluateReservationFnrhState([
      base({
        guest_id: G_PRIMARY,
        guest_role: null,
        requires_classification: true,
        fnrh_status: "draft",
      }),
    ]);
    assert.ok(r.unclassified_guests >= 1);
    assert.equal(r.all_required_complete, false);
    ok("26 hóspede sem papel deixa reserva pendente");
  }

  // 27 menor sem responsável
  {
    const r = evaluateReservationFnrhState([
      base({
        guest_id: G_PRIMARY,
        guest_role: "primary_adult",
        fnrh_status: "completed",
        confirmation_source: "guest",
        completed_by_guest_id: G_PRIMARY,
      }),
      base({
        guest_id: G_MINOR,
        guest_role: "minor",
        responsible_guest_id: null,
        fnrh_status: "awaiting_responsible_confirmation",
      }),
    ]);
    assert.ok(r.pending_fnrhs >= 1);
    assert.equal(r.all_required_complete, false);
    ok("27 menor sem responsável deixa reserva pendente");
  }

  // 29 adulto sem documento
  {
    const r = evaluateFnrhCompletion(
      base({
        guest_id: G_PRIMARY,
        guest_role: "primary_adult",
        fnrh_status: "awaiting_guest_confirmation",
        has_required_documents: false,
      }),
    );
    assert.ok(r.pending_reasons.includes("missing_required_documents"));
    ok("29 adulto sem documento obrigatório fica pendente");
  }

  // 30 menor sem documento
  {
    const r = evaluateFnrhCompletion(
      base({
        guest_id: G_MINOR,
        guest_role: "minor",
        responsible_guest_id: G_PRIMARY,
        fnrh_status: "awaiting_responsible_confirmation",
        has_required_documents: false,
      }),
    );
    assert.ok(r.pending_reasons.includes("missing_required_documents"));
    ok("30 menor sem documento legal aplicável fica pendente");
  }

  // 31 conclusão por responsável preserva ator
  {
    const r = evaluateFnrhCompletion(
      base({
        guest_id: G_MINOR,
        guest_role: "minor",
        responsible_guest_id: G_PRIMARY,
        fnrh_status: "completed",
        confirmation_source: "responsible",
        completed_by_guest_id: G_PRIMARY,
      }),
    );
    assert.equal(r.is_complete, true);
    ok("31 conclusão por responsável com ator identificado");
  }

  // 32 auditoria sanitizada
  {
    const sanitized = sanitizeFnrhAuditState({
      status: "completed",
      documento: "12345678901",
      token: "supersecrettokenvalue",
      nome: "Maria",
    });
    assert.equal(sanitized.documento, "[redacted]");
    assert.equal(sanitized.token, "[redacted]");
    assertAuditPayloadSafe(sanitized);
    ok("32 auditoria não contém dados sensíveis completos");
  }

  // 33-35 adapter mapeia papéis
  {
    const input = buildReservationPendingInputFromRows({
      pagamento_status: "pago",
      guests: [
        {
          id: G_PRIMARY,
          principal: true,
          guest_role: "primary_adult",
          fnrh_status: "confirmado_hospede",
          fnrh_lifecycle_status: "completed",
          confirmation_source: "guest",
          completed_by_guest_id: G_PRIMARY,
          has_required_core_fields: true,
          has_required_documents: true,
          has_whatsapp: true,
          requires_classification: false,
        },
        {
          id: G_COMPANION,
          principal: false,
          guest_role: "adult_companion",
          fnrh_status: "pendente",
          fnrh_lifecycle_status: "awaiting_guest_confirmation",
          has_required_core_fields: true,
          has_required_documents: true,
          has_email: true,
          requires_classification: false,
        },
        {
          id: G_MINOR,
          principal: false,
          guest_role: "minor",
          responsible_guest_id: G_PRIMARY,
          fnrh_status: "confirmado_hospede",
          fnrh_lifecycle_status: "completed",
          confirmation_source: "responsible",
          completed_by_guest_id: G_PRIMARY,
          has_required_core_fields: true,
          has_required_documents: true,
          requires_classification: false,
        },
      ],
    });
    assert.equal(input.guests[0]?.role, "principal_adulto");
    assert.equal(input.guests[1]?.role, "acompanhante_adulto");
    assert.equal(input.guests[2]?.role, "menor");
    assert.equal(input.guests[2]?.completed_by_guardian, true);
    const pending = evaluateReservationPendingState(input);
    assert.equal(pending.fnrh_pending, true); // companion awaiting
    ok("33-35 adapter mapeia principal, acompanhante e menor");
  }

  // 36 schema antigo → ConfigurationError
  {
    assert.throws(
      () =>
        buildReservationPendingInputFromRows({
          pagamento_status: "pago",
          guests: [{ id: "x", principal: true, fnrh_status: "pendente" }],
        }),
      (e: unknown) => e instanceof FirstRoomAccessConfigurationError,
    );
    ok("36 schema antigo retorna ConfigurationError");
  }

  // 37/38 agregado contagens + reserva completa
  {
    const complete = evaluateReservationFnrhState([
      base({
        guest_id: G_PRIMARY,
        guest_role: "primary_adult",
        fnrh_status: "completed",
        confirmation_source: "guest",
        completed_by_guest_id: G_PRIMARY,
      }),
      base({
        guest_id: G_COMPANION,
        guest_role: "adult_companion",
        fnrh_status: "completed",
        confirmation_source: "guest",
        completed_by_guest_id: G_COMPANION,
        has_contact_channel: true,
      }),
      base({
        guest_id: G_MINOR,
        guest_role: "minor",
        responsible_guest_id: G_PRIMARY,
        fnrh_status: "completed",
        confirmation_source: "responsible",
        completed_by_guest_id: G_PRIMARY,
        has_contact_channel: false,
      }),
    ]);
    assert.equal(complete.required_fnrhs, 3);
    assert.equal(complete.completed_fnrhs, 3);
    assert.equal(complete.pending_fnrhs, 0);
    assert.equal(complete.all_required_complete, true);
    ok("37/38 agregado contagens corretas; reserva completa");
  }

  // 39 under_review bloqueia
  {
    const r = evaluateReservationFnrhState([
      base({
        guest_id: G_PRIMARY,
        guest_role: "primary_adult",
        fnrh_status: "under_review",
        confirmation_source: "guest",
        completed_by_guest_id: G_PRIMARY,
      }),
    ]);
    assert.equal(r.under_review_fnrhs, 1);
    assert.equal(r.all_required_complete, false);
    ok("39 FNRH em revisão bloqueia o agregado");
  }

  // 40 facial/placa não em pending_reasons do agregado
  {
    const r = evaluateReservationFnrhState([
      base({
        guest_id: G_PRIMARY,
        guest_role: "primary_adult",
        fnrh_status: "draft",
        has_facial: false,
        has_placa: false,
      }),
    ]);
    const allReasons = r.pending_guests.flatMap((g) => g.pending_reasons);
    assert.ok(!allReasons.some((x) => x.includes("facial") || x.includes("placa")));
    ok("40 facial/placa não aparecem em pending_reasons");
  }

  // Role type guard
  const roles: GuestRoleDb[] = ["primary_adult", "adult_companion", "minor"];
  assert.equal(roles.length, 3);

  console.log(`\n${passed} asserções OK\n`);
}

main();
