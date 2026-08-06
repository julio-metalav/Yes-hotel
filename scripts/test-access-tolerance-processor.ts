/**
 * Testes do processador pós-auditoria (sem rede/banco).
 * Efeito real só com flag TTLock + dryRun=false + homolog lock.
 */
import assert from "node:assert/strict";
import {
  processAccessTolerancesBatch,
  processOneToleranceDue,
  processOneToleranceRestore,
  isTtlockExecutionReal,
  resolveHomologFilter,
} from "../src/lib/application/yes-hotel/access-tolerance-processor";
import { createMockTtlockValidityChangePort } from "../src/lib/application/yes-hotel/access-outbox-dispatcher";
import {
  createFirstRoomAccessMemoryHarness,
  seedActiveTolerance,
} from "../src/lib/application/yes-hotel/testing/first-room-access-memory";
import type { AccessToleranceFlags } from "../src/lib/domain/yes-hotel/access-tolerance-flags";
import type { ReservationPendingStateInput } from "../src/lib/domain/yes-hotel/reservation-pending-state";
import { assertSanitizedPayloadSafe } from "../src/lib/integrations/ttlock/access-ingest/sanitize";

const RES_ID = "5321a46f-5000-43e1-8830-df57f3bc0439";
const CRED_ID = "64705bcb-6736-4329-96ae-f9413f3bb5d8";
const VALID_FROM = "2026-08-08T17:00:00.000Z";
const VALID_UNTIL = "2026-08-10T15:00:00.000Z";
const DUE = "2026-08-08T19:00:00.000Z";
const BEFORE_DUE = new Date("2026-08-08T18:30:00.000Z");
const AFTER_DUE = new Date("2026-08-08T19:05:00.000Z");
const LOCK_APT = 13865804;

const FLAGS_SAFE: AccessToleranceFlags = {
  processorEnabled: true,
  ttlockSuspensionEnabled: false,
  outboxDispatchEnabled: false,
  digisacRealEnabled: false,
  emailRealEnabled: false,
  homologLockIdFilter: null,
  digisacInternalNumber: "6721800225",
};

const FLAGS_REAL: AccessToleranceFlags = {
  ...FLAGS_SAFE,
  ttlockSuspensionEnabled: true,
  homologLockIdFilter: LOCK_APT,
};

function pendingPay(): ReservationPendingStateInput {
  return {
    payment_status: "pendente",
    guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "completed" }],
  };
}
function clear(): ReservationPendingStateInput {
  return {
    payment_status: "pago",
    guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "completed" }],
  };
}
function desconhecido(): ReservationPendingStateInput {
  return {
    payment_status: "desconhecido",
    guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "completed" }],
  };
}
function parcial(): ReservationPendingStateInput {
  return {
    payment_status: "parcial",
    guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "completed" }],
  };
}
function fnrhPending(): ReservationPendingStateInput {
  return {
    payment_status: "pago",
    guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "pending" }],
  };
}

function threeItems(remoteIds: number[] = [1, 2, 3]) {
  return [
    {
      credential_item_id: "item-apt",
      logical_destination: "APT-02",
      lock_id: LOCK_APT,
      remote_keyboard_pwd_id: remoteIds[0],
    },
    {
      credential_item_id: "item-ext",
      logical_destination: "GATE-EXT",
      lock_id: 2,
      remote_keyboard_pwd_id: remoteIds[1],
    },
    {
      credential_item_id: "item-int",
      logical_destination: "GATE-INT",
      lock_id: 3,
      remote_keyboard_pwd_id: remoteIds[2],
    },
  ];
}

function harness(pending: ReservationPendingStateInput, now = AFTER_DUE) {
  return createFirstRoomAccessMemoryHarness({
    correlation: {
      correlated: true,
      reservation_id: RES_ID,
      credential_id: CRED_ID,
      within_reservation_window: true,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
    },
    pending,
    items: [],
    now,
  });
}

function portsOf(h: ReturnType<typeof harness>, ttlock = createMockTtlockValidityChangePort()) {
  return {
    tolerances: h.tolerances,
    pending: h.pendingPort,
    ttlock,
    outboxQueue: h.outboxQueue,
    clock: h.clock,
  };
}

async function main() {
  let cases = 0;
  function ok(name: string) {
    cases += 1;
    console.log("  ok", name);
  }

  assert.equal(isTtlockExecutionReal(FLAGS_SAFE, false), false);
  assert.equal(isTtlockExecutionReal(FLAGS_REAL, true), false);
  assert.equal(isTtlockExecutionReal(FLAGS_REAL, false), true);
  ok("isTtlockExecutionReal");

  {
    const h = harness(pendingPay(), BEFORE_DUE);
    const tol = await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID,
      suspension_due_at: DUE,
      pending_payment: true,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems(),
    });
    const r = await processOneToleranceDue(portsOf(h), tol, {
      flags: FLAGS_REAL,
      dryRun: false,
    });
    assert.equal(r.action, "skipped_not_due");
    ok("ainda nao vencida");
  }

  // dry-run não persiste
  {
    const h = harness(pendingPay());
    const tol = await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "dry",
      suspension_due_at: DUE,
      pending_payment: true,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems(),
    });
    const before = h.state.accessOutbox.length;
    const r = await processOneToleranceDue(portsOf(h), tol, {
      flags: FLAGS_REAL,
      dryRun: true,
    });
    assert.equal(r.action, "would_suspend");
    assert.equal(r.simulation_only, true);
    assert.equal((await h.tolerances.findById!(tol.id))!.grace_status, "active");
    assert.equal(h.state.accessOutbox.length, before);
    ok("dry-run nao persiste / nao mensagem");
  }

  // flag TTLock off
  {
    const h = harness(pendingPay());
    const tol = await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "flag",
      suspension_due_at: DUE,
      pending_payment: true,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems(),
    });
    const r = await processOneToleranceDue(portsOf(h), tol, {
      flags: FLAGS_SAFE,
      dryRun: false,
    });
    assert.equal(r.action, "skipped_ttlock_disabled");
    assert.equal((await h.tolerances.findById!(tol.id))!.grace_status, "active");
    ok("flag desligada nao marca suspended");
  }

  // pagamento desconhecido
  {
    const h = harness(desconhecido());
    const tol = await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "unk",
      suspension_due_at: DUE,
      pending_payment: true,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems(),
    });
    const r = await processOneToleranceDue(portsOf(h), tol, {
      flags: FLAGS_REAL,
      dryRun: false,
    });
    assert.equal(r.action, "deferred_payment_unknown");
    assert.equal((await h.tolerances.findById!(tol.id))!.grace_status, "active");
    ok("pagamento desconhecido nao suspende");
  }

  // parcial + real → suspended
  {
    const h = harness(parcial());
    const tol = await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "parc",
      suspension_due_at: DUE,
      pending_payment: true,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems(),
    });
    const r = await processOneToleranceDue(
      portsOf(h, createMockTtlockValidityChangePort()),
      tol,
      { flags: FLAGS_REAL, dryRun: false },
    );
    assert.equal(r.action, "suspended");
    assert.equal((await h.tolerances.findById!(tol.id))!.grace_status, "suspended");
    assert.ok(h.state.accessOutbox.some((m) => m.event_type === "guest_access_suspended"));
    ok("parcial suspende com efeito real confirmado");
  }

  // FNRH pendente
  {
    const h = harness(fnrhPending());
    const tol = await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "fnrh",
      suspension_due_at: DUE,
      pending_payment: false,
      pending_fnrh: true,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems(),
    });
    const r = await processOneToleranceDue(portsOf(h), tol, {
      flags: FLAGS_REAL,
      dryRun: false,
    });
    assert.equal(r.action, "suspended");
    ok("fnrh pendente suspende");
  }

  // clear → cancelled
  {
    const h = harness(clear());
    const tol = await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "clr",
      suspension_due_at: DUE,
      pending_payment: true,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems(),
    });
    const r = await processOneToleranceDue(portsOf(h), tol, {
      flags: FLAGS_REAL,
      dryRun: false,
    });
    assert.equal(r.action, "cancelled_all_clear");
    ok("sem pendencias cancela");
  }

  // homolog: todos filtrados
  {
    const h = harness(pendingPay());
    const tol = await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "hom",
      suspension_due_at: DUE,
      pending_payment: true,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems().map((i) => ({ ...i, lock_id: 999 })),
    });
    const flags = { ...FLAGS_REAL, homologLockIdFilter: LOCK_APT };
    const r = await processOneToleranceDue(portsOf(h), tol, { flags, dryRun: false });
    assert.equal(r.action, "skipped_homolog_filter");
    assert.equal((await h.tolerances.findById!(tol.id))!.grace_status, "active");
    assert.equal(
      h.state.accessOutbox.filter((m) => m.event_type === "guest_technical_failure").length,
      0,
    );
    ok("homolog filter todos skipped sem erro ao hospede");
  }

  // real sem homolog → bloqueio
  {
    const r = resolveHomologFilter(
      { ...FLAGS_REAL, homologLockIdFilter: null },
      true,
    );
    assert.equal(r.ok, false);
    ok("homolog ausente + real → bloqueio");
  }

  // falha parcial
  {
    const h = harness(pendingPay());
    const tol = await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "part",
      suspension_due_at: DUE,
      pending_payment: true,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems(),
    });
    const r = await processOneToleranceDue(
      portsOf(h, createMockTtlockValidityChangePort({ failLockIds: [LOCK_APT] })),
      tol,
      { flags: FLAGS_REAL, dryRun: false },
    );
    // apt fails, other locks filtered by homolog → all eligible failed
    assert.ok(r.action === "error" || r.action === "partial_failure");
    ok("falha TTLock no lock homologado");
  }

  // restore
  {
    const h = harness(pendingPay());
    const tol = await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "rest",
      suspension_due_at: DUE,
      pending_payment: true,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems(),
    });
    await processOneToleranceDue(portsOf(h), tol, { flags: FLAGS_REAL, dryRun: false });
    h.pendingPort.setInput(clear());
    const suspended = (await h.tolerances.findById!(tol.id))!;
    const r = await processOneToleranceRestore(portsOf(h), suspended, {
      flags: FLAGS_REAL,
      dryRun: false,
    });
    assert.equal(r.action, "restored");
    const r2 = await processOneToleranceRestore(
      portsOf(h),
      (await h.tolerances.findById!(tol.id))!,
      { flags: FLAGS_REAL, dryRun: false },
    );
    assert.equal(r2.action, "noop");
    ok("restauracao + ja realizada");
  }

  // reclaim stale suspension_pending
  {
    const h = harness(pendingPay());
    const tol = await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "stale",
      suspension_due_at: DUE,
      pending_payment: true,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems(),
      grace_status: "suspension_pending",
    });
    await h.tolerances.tryTransitionStatus!(
      tol.id,
      "suspension_pending",
      "suspension_pending",
      "2026-08-08T18:00:00.000Z",
    );
    const cutoff = "2026-08-08T18:50:00.000Z";
    const stale = await h.tolerances.listStalePending!(cutoff);
    assert.ok(stale.some((t) => t.id === tol.id));
    const r = await processOneToleranceDue(
      portsOf(h),
      (await h.tolerances.findById!(tol.id))!,
      { flags: FLAGS_REAL, dryRun: false, staleCutoffIso: cutoff },
    );
    assert.equal(r.action, "suspended");
    ok("stale suspension_pending reclaimed");
  }

  // B7: exclusão mútua suspension_pending (predicado temporal no CAS)
  {
    const h = harness(pendingPay());
    const tol = await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "race-stale",
      suspension_due_at: DUE,
      pending_payment: true,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems(),
      grace_status: "suspension_pending",
    });
    await h.tolerances.tryTransitionStatus!(
      tol.id,
      "suspension_pending",
      "suspension_pending",
      "2026-08-08T18:00:00.000Z",
    );
    const cutoff = "2026-08-08T18:50:00.000Z";
    let ttlockCalls = 0;
    const countingTtlock = {
      async changeValidityOnly(req: {
        lockId: number;
        keyboardPwdId: number;
        startDateMs: number;
        endDateMs: number;
      }) {
        ttlockCalls += 1;
        return createMockTtlockValidityChangePort().changeValidityOnly(req);
      },
    };
    const snap = (await h.tolerances.findById!(tol.id))!;
    const opts = { flags: FLAGS_REAL, dryRun: false, staleCutoffIso: cutoff };
    const [a, b] = await Promise.all([
      processOneToleranceDue(portsOf(h, countingTtlock), snap, opts),
      processOneToleranceDue(portsOf(h, countingTtlock), snap, opts),
    ]);
    const actions = [a.action, b.action].sort();
    assert.ok(actions.includes("suspended"));
    assert.ok(actions.includes("already_processing"));
    assert.equal(ttlockCalls, 1);
    // Predicado temporal do repository: segunda claim falha
    const again = await h.tolerances.tryClaimStaleTolerance!(
      tol.id,
      "suspension_pending",
      cutoff,
      AFTER_DUE.toISOString(),
    );
    assert.equal(again, false);
    ok("B7 exclusao mutua suspension_pending");
  }

  // B7: suspension_pending recente nao reclaimed
  {
    const h = harness(pendingPay());
    const tol = await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "fresh-sp",
      suspension_due_at: DUE,
      pending_payment: true,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems(),
      grace_status: "suspension_pending",
    });
    // updated_at = now (AFTER_DUE) — recente
    const cutoff = "2026-08-08T18:50:00.000Z";
    assert.equal(
      await h.tolerances.tryClaimStaleTolerance!(
        tol.id,
        "suspension_pending",
        cutoff,
        AFTER_DUE.toISOString(),
      ),
      false,
    );
    const r = await processOneToleranceDue(
      portsOf(h),
      (await h.tolerances.findById!(tol.id))!,
      { flags: FLAGS_REAL, dryRun: false, staleCutoffIso: cutoff },
    );
    assert.equal(r.action, "already_processing");
    assert.equal((await h.tolerances.findById!(tol.id))!.grace_status, "suspension_pending");
    ok("B7 suspension_pending recente nao reclaimed");
  }

  // B7: exclusão mútua restore_pending
  {
    const h = harness(clear());
    const tol = await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "race-rp",
      suspension_due_at: DUE,
      pending_payment: false,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems(),
      grace_status: "restore_pending",
    });
    await h.tolerances.tryTransitionStatus!(
      tol.id,
      "restore_pending",
      "restore_pending",
      "2026-08-08T18:00:00.000Z",
    );
    // itens já suspensos fisicamente (pré-condição de restore)
    for (const it of await h.tolerances.listItems!(tol.id)) {
      await h.tolerances.updateItemSuspension!(it.id, {
        suspension_status: "succeeded",
        suspended_at: "2026-08-08T18:10:00.000Z",
        suspended_valid_until: "2026-08-08T19:10:00.000Z",
      });
    }
    const cutoff = "2026-08-08T18:50:00.000Z";
    let ttlockCalls = 0;
    const countingTtlock = {
      async changeValidityOnly(req: {
        lockId: number;
        keyboardPwdId: number;
        startDateMs: number;
        endDateMs: number;
      }) {
        ttlockCalls += 1;
        return createMockTtlockValidityChangePort().changeValidityOnly(req);
      },
    };
    const snap = (await h.tolerances.findById!(tol.id))!;
    const opts = { flags: FLAGS_REAL, dryRun: false, staleCutoffIso: cutoff };
    const [a, b] = await Promise.all([
      processOneToleranceRestore(portsOf(h, countingTtlock), snap, opts),
      processOneToleranceRestore(portsOf(h, countingTtlock), snap, opts),
    ]);
    const actions = [a.action, b.action].sort();
    assert.ok(actions.includes("restored"));
    assert.ok(actions.includes("already_processing"));
    assert.equal(ttlockCalls, 1);
    ok("B7 exclusao mutua restore_pending");
  }

  // B7: restore_pending recente nao reclaimed
  {
    const h = harness(clear());
    const tol = await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "fresh-rp",
      suspension_due_at: DUE,
      pending_payment: false,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems(),
      grace_status: "restore_pending",
    });
    const cutoff = "2026-08-08T18:50:00.000Z";
    assert.equal(
      await h.tolerances.tryClaimStaleTolerance!(
        tol.id,
        "restore_pending",
        cutoff,
        AFTER_DUE.toISOString(),
      ),
      false,
    );
    const r = await processOneToleranceRestore(
      portsOf(h),
      (await h.tolerances.findById!(tol.id))!,
      { flags: FLAGS_REAL, dryRun: false, staleCutoffIso: cutoff },
    );
    assert.equal(r.action, "already_processing");
    ok("B7 restore_pending recente nao reclaimed");
  }

  // B7: crash após suspensão física + all_clear → restore (nao cancelled)
  {
    const h = harness(clear());
    const tol = await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "crash-phys",
      suspension_due_at: DUE,
      pending_payment: true,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems(),
      grace_status: "suspension_pending",
    });
    await h.tolerances.tryTransitionStatus!(
      tol.id,
      "suspension_pending",
      "suspension_pending",
      "2026-08-08T18:00:00.000Z",
    );
    for (const it of await h.tolerances.listItems!(tol.id)) {
      await h.tolerances.updateItemSuspension!(it.id, {
        suspension_status: "succeeded",
        suspended_at: "2026-08-08T18:10:00.000Z",
        suspended_valid_until: "2026-08-08T19:10:00.000Z",
      });
    }
    const cutoff = "2026-08-08T18:50:00.000Z";
    let restoreCalls = 0;
    const countingTtlock = {
      async changeValidityOnly(req: {
        lockId: number;
        keyboardPwdId: number;
        startDateMs: number;
        endDateMs: number;
      }) {
        restoreCalls += 1;
        assert.equal(req.startDateMs, new Date(VALID_FROM).getTime());
        assert.equal(req.endDateMs, new Date(VALID_UNTIL).getTime());
        return createMockTtlockValidityChangePort().changeValidityOnly(req);
      },
    };
    const r = await processOneToleranceDue(
      portsOf(h, countingTtlock),
      (await h.tolerances.findById!(tol.id))!,
      { flags: FLAGS_REAL, dryRun: false, staleCutoffIso: cutoff },
    );
    assert.equal(r.action, "restored");
    assert.equal((await h.tolerances.findById!(tol.id))!.grace_status, "restored");
    assert.ok(restoreCalls >= 1);
    assert.ok(
      h.state.accessOutbox.some(
        (m) =>
          m.event_type === "guest_access_restored" &&
          m.idempotency_key.startsWith(`tol:${tol.id}:restored`),
      ),
    );
    assert.equal(
      h.state.accessOutbox.filter((m) => m.event_type === "guest_access_suspended").length,
      0,
    );
    // reprocessamento nao duplica
    const r2 = await processOneToleranceRestore(
      portsOf(h, countingTtlock),
      (await h.tolerances.findById!(tol.id))!,
      { flags: FLAGS_REAL, dryRun: false, staleCutoffIso: cutoff },
    );
    assert.equal(r2.action, "noop");
    assert.equal(
      h.state.accessOutbox.filter((m) => m.event_type === "guest_access_restored").length,
      2, // whatsapp + email
    );
    ok("B7 crash fisico → restore nao cancelled");
  }

  // B7: all_clear sem efeito fisico → cancelled, sem TTLock
  {
    const h = harness(clear());
    const tol = await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "cancel-ok",
      suspension_due_at: DUE,
      pending_payment: true,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems(),
      grace_status: "suspension_pending",
    });
    let calls = 0;
    const countingTtlock = {
      async changeValidityOnly() {
        calls += 1;
        return { ok: true as const };
      },
    };
    const r = await processOneToleranceDue(
      portsOf(h, countingTtlock),
      (await h.tolerances.findById!(tol.id))!,
      { flags: FLAGS_REAL, dryRun: false },
    );
    assert.equal(r.action, "cancelled_all_clear");
    assert.equal((await h.tolerances.findById!(tol.id))!.grace_status, "cancelled");
    assert.equal(calls, 0);
    assert.equal(
      h.state.accessOutbox.filter((m) => m.event_type === "guest_access_restored").length,
      0,
    );
    ok("B7 all_clear sem efeito fisico cancela");
  }

  // B7: dry-run com item fisicamente suspenso nao marca restored/cancelled
  {
    const h = harness(clear());
    const tol = await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "dry-crash",
      suspension_due_at: DUE,
      pending_payment: true,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems(),
      grace_status: "suspension_pending",
    });
    await h.tolerances.tryTransitionStatus!(
      tol.id,
      "suspension_pending",
      "suspension_pending",
      "2026-08-08T18:00:00.000Z",
    );
    for (const it of await h.tolerances.listItems!(tol.id)) {
      await h.tolerances.updateItemSuspension!(it.id, {
        suspension_status: "succeeded",
        suspended_at: "2026-08-08T18:10:00.000Z",
      });
    }
    const before = (await h.tolerances.findById!(tol.id))!.updated_at;
    const r = await processOneToleranceDue(
      portsOf(h),
      (await h.tolerances.findById!(tol.id))!,
      {
        flags: FLAGS_REAL,
        dryRun: true,
        staleCutoffIso: "2026-08-08T18:50:00.000Z",
      },
    );
    assert.equal(r.action, "would_restore");
    assert.equal(r.simulation_only, true);
    const after = (await h.tolerances.findById!(tol.id))!;
    assert.equal(after.grace_status, "suspension_pending");
    assert.equal(after.updated_at, before);
    assert.equal(
      h.state.accessOutbox.filter((m) => m.event_type === "guest_access_restored").length,
      0,
    );
    ok("B7 dry-run com efeito fisico nao persiste");
  }

  // batch: um erro nao aborta
  {
    const h = harness(pendingPay());
    await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "b1",
      suspension_due_at: DUE,
      pending_payment: true,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems([0, 0, 0]),
    });
    await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "b2",
      suspension_due_at: DUE,
      pending_payment: true,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems(),
    });
    const results = await processAccessTolerancesBatch(portsOf(h), {
      flags: FLAGS_REAL,
      dryRun: false,
    });
    assert.ok(results.length >= 2);
    assert.ok(results.some((r) => r.action === "suspended"));
    ok("batch isola falhas");
  }

  // last_error limpo apos sucesso
  {
    const h = harness(pendingPay());
    const tol = await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "err",
      suspension_due_at: DUE,
      pending_payment: true,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems(),
      grace_status: "error",
    });
    await h.tolerances.markError(tol.id, "old_error", AFTER_DUE.toISOString());
    await h.tolerances.tryTransitionStatus!(tol.id, "error", "active", AFTER_DUE.toISOString());
    await processOneToleranceDue(
      portsOf(h),
      (await h.tolerances.findById!(tol.id))!,
      { flags: FLAGS_REAL, dryRun: false },
    );
    const after = (await h.tolerances.findById!(tol.id))!;
    assert.equal(after.grace_status, "suspended");
    assert.equal(after.last_error, null);
    ok("last_error limpo apos sucesso");
  }

  // sanitize: texto com senha ok; chave bloqueada
  {
    assertSanitizedPayloadSafe({ body: "Sua senha foi temporariamente suspensa" });
    assert.throws(() => assertSanitizedPayloadSafe({ senha: "1234" }));
    assert.throws(() => assertSanitizedPayloadSafe({ keyboardPwd: "x" }));
    ok("sanitizacao chave vs texto");
  }

  // concorrencia CAS active→pending
  {
    const h = harness(pendingPay());
    const tol = await seedActiveTolerance(h, {
      reservation_id: RES_ID,
      credential_id: CRED_ID + "race",
      suspension_due_at: DUE,
      pending_payment: true,
      pending_fnrh: false,
      original_valid_from: VALID_FROM,
      original_valid_until: VALID_UNTIL,
      items: threeItems(),
    });
    const p = portsOf(h);
    const [a, b] = await Promise.all([
      processOneToleranceDue(p, tol, { flags: FLAGS_REAL, dryRun: false }),
      processOneToleranceDue(p, tol, { flags: FLAGS_REAL, dryRun: false }),
    ]);
    const actions = [a.action, b.action].sort();
    assert.ok(actions.includes("suspended"));
    assert.ok(actions.includes("already_processing") || actions.filter((x) => x === "suspended").length === 1);
    ok("concorrencia CAS");
  }

  console.log(`OK test-access-tolerance-processor (${cases} casos)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
