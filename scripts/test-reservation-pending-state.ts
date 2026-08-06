/**
 * Testes: reservation-pending-state (sem I/O).
 */
import assert from "node:assert/strict";
import {
  evaluateReservationPendingState,
  type ExpectedGuestFnrhInput,
} from "../src/lib/domain/yes-hotel/reservation-pending-state";

function adultPrincipal(overrides: Partial<ExpectedGuestFnrhInput> = {}): ExpectedGuestFnrhInput {
  return {
    id: "g-principal",
    role: "principal_adulto",
    fnrh_status: "completed",
    individual_confirmation: true,
    has_facial: false,
    has_placa: false,
    ...overrides,
  };
}

function adultCompanion(overrides: Partial<ExpectedGuestFnrhInput> = {}): ExpectedGuestFnrhInput {
  return {
    id: "g-comp",
    role: "acompanhante_adulto",
    fnrh_status: "completed",
    individual_confirmation: true,
    ...overrides,
  };
}

function minor(overrides: Partial<ExpectedGuestFnrhInput> = {}): ExpectedGuestFnrhInput {
  return {
    id: "g-menor",
    role: "menor",
    fnrh_status: "completed",
    completed_by_guardian: true,
    has_phone: false,
    has_email: false,
    individual_confirmation: false,
    ...overrides,
  };
}

// all clear
{
  const r = evaluateReservationPendingState({
    payment_status: "pago",
    guests: [adultPrincipal(), adultCompanion(), minor()],
  });
  assert.equal(r.all_clear, true);
  assert.equal(r.payment_pending, false);
  assert.equal(r.fnrh_pending, false);
  assert.equal(r.fnrh_summary.required, 3);
  assert.equal(r.fnrh_summary.completed, 3);
  assert.equal(r.fnrh_summary.pending, 0);
}

// 12/21/22 pagamento pendente / parcial / emergencial → payment_pending
{
  for (const status of ["pendente", "parcial", "emergencial"] as const) {
    const r = evaluateReservationPendingState({
      payment_status: status,
      guests: [adultPrincipal()],
    });
    assert.equal(r.payment_pending, true, status);
    assert.equal(r.payment_unknown, false, status);
    assert.equal(r.all_clear, false, status);
  }
}

// desconhecido: NÃO é pendência confirmada; fail-safe
{
  const r = evaluateReservationPendingState({
    payment_status: "desconhecido",
    guests: [adultPrincipal()],
  });
  assert.equal(r.payment_pending, false);
  assert.equal(r.payment_unknown, true);
  assert.equal(r.all_clear, true);
  assert.ok(r.pending_reasons.includes("pagamento_desconhecido"));
}

// desconhecido + FNRH pendente → tolerância pode iniciar pela FNRH
{
  const r = evaluateReservationPendingState({
    payment_status: "desconhecido",
    guests: [adultPrincipal({ fnrh_status: "pending" })],
  });
  assert.equal(r.payment_pending, false);
  assert.equal(r.payment_unknown, true);
  assert.equal(r.fnrh_pending, true);
  assert.equal(r.all_clear, false);
}

// 13) FNRH principal pendente
{
  const r = evaluateReservationPendingState({
    payment_status: "pago",
    guests: [adultPrincipal({ fnrh_status: "pending" })],
  });
  assert.equal(r.fnrh_pending, true);
  assert.ok(r.pending_reasons.includes("fnrh"));
}

// 14) acompanhante adulto pendente
{
  const r = evaluateReservationPendingState({
    payment_status: "pago",
    guests: [adultPrincipal(), adultCompanion({ fnrh_status: "not_started" })],
  });
  assert.equal(r.fnrh_pending, true);
  assert.equal(r.fnrh_summary.completed, 1);
  assert.equal(r.fnrh_summary.pending, 1);
}

// 15) menor sem ficha concluída
{
  const r = evaluateReservationPendingState({
    payment_status: "pago",
    guests: [adultPrincipal(), minor({ fnrh_status: "pending", completed_by_guardian: false })],
  });
  assert.equal(r.fnrh_pending, true);
}

// 16) menor com ficha pelo responsável OK
{
  const r = evaluateReservationPendingState({
    payment_status: "pago",
    guests: [adultPrincipal(), minor({ fnrh_status: "completed", completed_by_guardian: true })],
  });
  assert.equal(r.fnrh_pending, false);
}

// 17) menor sem telefone/e-mail não pendura
{
  const r = evaluateReservationPendingState({
    payment_status: "pago",
    guests: [
      adultPrincipal(),
      minor({
        fnrh_status: "completed",
        completed_by_guardian: true,
        has_phone: false,
        has_email: false,
        individual_confirmation: false,
      }),
    ],
  });
  assert.equal(r.fnrh_pending, false);
}

// 18–19) facial / placa ausentes não penduram
{
  const r = evaluateReservationPendingState({
    payment_status: "pago",
    guests: [
      adultPrincipal({ has_facial: false, has_placa: false }),
      adultCompanion({ has_facial: false, has_placa: false }),
    ],
  });
  assert.equal(r.fnrh_pending, false);
  assert.equal(r.all_clear, true);
}

// 20) revisão pendente
{
  const r = evaluateReservationPendingState({
    payment_status: "pago",
    guests: [adultPrincipal({ fnrh_status: "review" })],
  });
  assert.equal(r.fnrh_pending, true);
}

// 23) acesso emergencial / liberação manual não elimina pagamento
{
  const r = evaluateReservationPendingState({
    payment_status: "pendente",
    emergency_access: true,
    manual_access_release: true,
    guests: [adultPrincipal()],
  });
  assert.equal(r.payment_pending, true);
  assert.equal(r.all_clear, false);
}

// menor completed sem guardian flag → ainda pendente
{
  const r = evaluateReservationPendingState({
    payment_status: "pago",
    guests: [adultPrincipal(), minor({ completed_by_guardian: false })],
  });
  assert.equal(r.fnrh_pending, true);
}

console.log("OK test-reservation-pending-state");
