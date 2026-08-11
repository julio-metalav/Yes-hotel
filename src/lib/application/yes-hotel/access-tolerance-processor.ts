/**
 * Processador de tolerâncias — apenas efeito TTLock confirmado persiste suspended/restored.
 * dry-run / flag off: não claim permanente, não mensagem ao hóspede, não timestamps físicos.
 */

import {
  buildAccessRestoreStrategy,
  buildAccessSuspensionStrategy,
  assertSuspensionContractSafe,
} from "../../domain/yes-hotel/access-suspension-strategy";
import {
  buildAccessRestoredMessage,
  buildAccessSuspendedMessage,
  buildTechnicalFailureMessage,
  assertMessageHasNoTechnicalJargon,
} from "../../domain/yes-hotel/access-grace-messages";
import {
  getAccessToleranceFlags,
  type AccessToleranceFlags,
} from "../../domain/yes-hotel/access-tolerance-flags";
import { evaluateReservationPendingState } from "../../domain/yes-hotel/reservation-pending-state";
import type {
  AccessToleranceItemRecord,
  AccessToleranceRecord,
  ProcessToleranceResult,
} from "./first-room-access-types";
import type {
  AccessToleranceRepository,
  AccessOutboxQueuePort,
  ClockPort,
  ReservationPendingStatePort,
  TtlockValidityChangePort,
} from "./first-room-access-ports";

const MAX_ITEM_ATTEMPTS = 5;
const STALE_PENDING_MS = 15 * 60_000;
const BATCH_DEADLINE_MS = 25_000;

export type AccessToleranceProcessorPorts = {
  tolerances: AccessToleranceRepository;
  pending: ReservationPendingStatePort;
  ttlock: TtlockValidityChangePort;
  outboxQueue: AccessOutboxQueuePort;
  clock: ClockPort;
  presencialDiferidoAudit?: import("./presencial-diferido-audit-port").PresencialDiferidoAuditPort;
};

export type AccessToleranceProcessorOptions = {
  flags?: AccessToleranceFlags;
  batchLimit?: number;
  /**
   * dry-run: calcula decisão sem persistir efeito / sem claim permanente / sem mensagens.
   * Default efetivo no Edge é true; false só com flag TTLock + homolog + servidor.
   */
  dryRun?: boolean;
  /** Deadline absoluto (ms epoch). Se omitido, usa now+BATCH_DEADLINE_MS no batch. */
  deadlineMs?: number;
  /**
   * Cutoff de staleness (ISO). updated_at <= cutoff é reclaimável.
   * Default: now - STALE_PENDING_MS.
   */
  staleCutoffIso?: string;
};

function toMs(iso: string): number {
  return new Date(iso).getTime();
}

function resolveStaleCutoff(
  now: Date,
  options: AccessToleranceProcessorOptions,
): string {
  return (
    options.staleCutoffIso ??
    new Date(now.getTime() - STALE_PENDING_MS).toISOString()
  );
}

/** Evidência de suspensão física confirmada nos itens (não só grace_status). */
export function hasPhysicalSuspensionEvidence(
  items: AccessToleranceItemRecord[],
): boolean {
  return items.some(
    (i) => i.suspension_status === "succeeded" || Boolean(i.suspended_at),
  );
}

function requireRepoMethods(repo: AccessToleranceRepository): void {
  if (
    !repo.listDueForSuspension ||
    !repo.listCandidatesForRestore ||
    !repo.listItems ||
    !repo.tryTransitionStatus ||
    !repo.tryClaimStaleTolerance ||
    !repo.updateItemSuspension ||
    !repo.findById
  ) {
    throw new Error(
      "AccessToleranceRepository incompleto para o processador (list/claim/items).",
    );
  }
}

/** Execução real só quando flag TTLock ligada E dryRun falso. */
export function isTtlockExecutionReal(
  flags: AccessToleranceFlags,
  dryRun: boolean,
): boolean {
  return flags.ttlockSuspensionEnabled === true && dryRun !== true;
}

/**
 * Homologação: execução real exige lockId configurado (fail-closed).
 * Dry-run pode listar sem filtro.
 */
export function resolveHomologFilter(
  flags: AccessToleranceFlags,
  realExecution: boolean,
): { ok: true; filter: number | null } | { ok: false; error: string } {
  if (!realExecution) {
    return { ok: true, filter: flags.homologLockIdFilter };
  }
  if (flags.homologLockIdFilter == null) {
    return {
      ok: false,
      error: "homolog_lock_required_for_real_execution",
    };
  }
  return { ok: true, filter: flags.homologLockIdFilter };
}

async function enqueueGuestAndInternal(
  queue: AccessOutboxQueuePort,
  input: {
    event_type: string;
    reservation_id: string;
    credential_id: string;
    tolerance_id: string;
    body: string;
    idempotency_key: string;
    template: string;
    nowIso: string;
    enqueue_internal_alert?: boolean;
    internal_body?: string;
  },
): Promise<void> {
  assertMessageHasNoTechnicalJargon(input.body);
  await queue.enqueue({
    event_type: input.event_type,
    channel: "whatsapp",
    reservation_id: input.reservation_id,
    credential_id: input.credential_id,
    access_event_id: null,
    tolerance_id: input.tolerance_id,
    recipient_ref: null,
    template: input.template,
    payload: { body: input.body },
    idempotency_key: `${input.idempotency_key}:whatsapp`,
    status: "pending",
    attempts: 0,
    available_at: input.nowIso,
    processed_at: null,
    last_error: null,
  });
  await queue.enqueue({
    event_type: input.event_type,
    channel: "email",
    reservation_id: input.reservation_id,
    credential_id: input.credential_id,
    access_event_id: null,
    tolerance_id: input.tolerance_id,
    recipient_ref: null,
    template: input.template,
    payload: { body: input.body, subject: "Yes Hotel — acesso" },
    idempotency_key: `${input.idempotency_key}:email`,
    status: "pending",
    attempts: 0,
    available_at: input.nowIso,
    processed_at: null,
    last_error: null,
  });
  if (input.enqueue_internal_alert && input.internal_body) {
    assertMessageHasNoTechnicalJargon(input.internal_body);
    await queue.enqueue({
      event_type: "internal_alert",
      channel: "whatsapp",
      reservation_id: input.reservation_id,
      credential_id: input.credential_id,
      access_event_id: null,
      tolerance_id: input.tolerance_id,
      recipient_ref: null,
      template: "internal_alert",
      payload: { body: input.internal_body },
      idempotency_key: `${input.idempotency_key}:internal`,
      status: "pending",
      attempts: 0,
      available_at: input.nowIso,
      processed_at: null,
      last_error: null,
    });
  }
}

async function enqueueInternalOnly(
  queue: AccessOutboxQueuePort,
  input: {
    reservation_id: string;
    credential_id: string;
    tolerance_id: string;
    body: string;
    idempotency_key: string;
    nowIso: string;
  },
): Promise<void> {
  assertMessageHasNoTechnicalJargon(input.body);
  await queue.enqueue({
    event_type: "internal_alert",
    channel: "whatsapp",
    reservation_id: input.reservation_id,
    credential_id: input.credential_id,
    access_event_id: null,
    tolerance_id: input.tolerance_id,
    recipient_ref: null,
    template: "internal_alert",
    payload: { body: input.body },
    idempotency_key: input.idempotency_key,
    status: "pending",
    attempts: 0,
    available_at: input.nowIso,
    processed_at: null,
    last_error: null,
  });
}

type ApplyResult = {
  succeeded: number;
  failed: number;
  skipped: number;
  lastError: string | null;
};

async function applyValidityToItems(input: {
  items: AccessToleranceItemRecord[];
  startMs: number;
  endMs: number;
  ttlock: TtlockValidityChangePort;
  tolerances: AccessToleranceRepository;
  nowIso: string;
  mode: "suspend" | "restore";
  homologLockIdFilter: number | null;
}): Promise<ApplyResult> {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let lastError: string | null = null;

  for (const item of input.items) {
    // Já confirmado — não repetir chamada TTLock.
    if (input.mode === "suspend" && item.suspension_status === "succeeded") {
      skipped += 1;
      succeeded += 1; // conta para agregado de sucesso total
      continue;
    }
    if (input.mode === "restore" && item.restore_status === "succeeded") {
      skipped += 1;
      succeeded += 1;
      continue;
    }

    if (input.homologLockIdFilter != null && item.lock_id !== input.homologLockIdFilter) {
      skipped += 1;
      await input.tolerances.updateItemSuspension!(item.id, {
        suspension_status: input.mode === "suspend" ? "skipped" : item.suspension_status,
        restore_status: input.mode === "restore" ? "skipped" : item.restore_status,
        last_attempt_at: input.nowIso,
        updated_at: input.nowIso,
        last_error: "homolog_lock_filter_skip",
      });
      continue;
    }

    if (!item.remote_keyboard_pwd_id) {
      failed += 1;
      lastError = "remote_keyboard_pwd_id_ausente";
      await input.tolerances.updateItemSuspension!(item.id, {
        suspension_status: input.mode === "suspend" ? "failed" : item.suspension_status,
        restore_status: input.mode === "restore" ? "failed" : item.restore_status,
        suspension_attempts:
          input.mode === "suspend" ? item.suspension_attempts + 1 : item.suspension_attempts,
        restore_attempts:
          input.mode === "restore" ? item.restore_attempts + 1 : item.restore_attempts,
        last_attempt_at: input.nowIso,
        last_error: lastError,
        updated_at: input.nowIso,
      });
      continue;
    }

    const attempts =
      input.mode === "suspend" ? item.suspension_attempts : item.restore_attempts;
    if (attempts >= MAX_ITEM_ATTEMPTS) {
      failed += 1;
      lastError = "max_attempts_exceeded";
      continue;
    }

    // Reconcile: reutilizar janela já persistida (não recalcular).
    let endMs = input.endMs;
    let startMs = input.startMs;
    if (
      input.mode === "suspend" &&
      item.suspended_valid_until &&
      Number.isFinite(toMs(item.suspended_valid_until))
    ) {
      endMs = toMs(item.suspended_valid_until);
      startMs = toMs(item.original_valid_from);
    }

    const result = await input.ttlock.changeValidityOnly({
      lockId: item.lock_id,
      keyboardPwdId: item.remote_keyboard_pwd_id,
      startDateMs: startMs,
      endDateMs: endMs,
    });

    if (result.ok) {
      succeeded += 1;
      await input.tolerances.updateItemSuspension!(item.id, {
        suspension_status: input.mode === "suspend" ? "succeeded" : item.suspension_status,
        restore_status: input.mode === "restore" ? "succeeded" : item.restore_status,
        suspended_valid_until:
          input.mode === "suspend" ? new Date(endMs).toISOString() : item.suspended_valid_until,
        suspension_attempts:
          input.mode === "suspend" ? attempts + 1 : item.suspension_attempts,
        restore_attempts: input.mode === "restore" ? attempts + 1 : item.restore_attempts,
        last_attempt_at: input.nowIso,
        last_error: null,
        suspended_at: input.mode === "suspend" ? input.nowIso : item.suspended_at,
        restored_at: input.mode === "restore" ? input.nowIso : item.restored_at,
        updated_at: input.nowIso,
      });
    } else {
      failed += 1;
      lastError = result.error.slice(0, 200);
      await input.tolerances.updateItemSuspension!(item.id, {
        suspension_status: input.mode === "suspend" ? "failed" : item.suspension_status,
        restore_status: input.mode === "restore" ? "failed" : item.restore_status,
        suspension_attempts:
          input.mode === "suspend" ? attempts + 1 : item.suspension_attempts,
        restore_attempts: input.mode === "restore" ? attempts + 1 : item.restore_attempts,
        last_attempt_at: input.nowIso,
        last_error: lastError,
        updated_at: input.nowIso,
      });
    }
  }

  return { succeeded, failed, skipped, lastError };
}

export async function processOneToleranceDue(
  ports: AccessToleranceProcessorPorts,
  tolerance: AccessToleranceRecord,
  options: AccessToleranceProcessorOptions = {},
): Promise<ProcessToleranceResult> {
  requireRepoMethods(ports.tolerances);
  const flags = options.flags ?? getAccessToleranceFlags();
  const now = ports.clock.now();
  const nowIso = now.toISOString();
  const dryRun = options.dryRun === true;
  const realExec = isTtlockExecutionReal(flags, dryRun);
  const cutoffIso = resolveStaleCutoff(now, options);

  if (!flags.processorEnabled) {
    return { tolerance_id: tolerance.id, action: "skipped_flag_off", simulation_only: true };
  }

  if (toMs(tolerance.suspension_due_at) > now.getTime()) {
    return { tolerance_id: tolerance.id, action: "skipped_not_due" };
  }

  let pendingInput;
  try {
    pendingInput = await ports.pending.getReservationPendingInput(tolerance.reservation_id);
  } catch {
    if (!dryRun) {
      await enqueueInternalOnly(ports.outboxQueue, {
        reservation_id: tolerance.reservation_id,
        credential_id: tolerance.credential_id,
        tolerance_id: tolerance.id,
        body: "Não foi possível confirmar o pagamento da reserva. Senha permanece ativa.",
        idempotency_key: `tol:${tolerance.id}:payment_unavailable`,
        nowIso,
      });
    }
    return {
      tolerance_id: tolerance.id,
      action: "deferred_payment_unavailable",
      simulation_only: dryRun || undefined,
    };
  }

  const pending = evaluateReservationPendingState(pendingInput);

  // Pagamento desconhecido: não suspende (fail-safe para o hóspede).
  if (pendingInput.payment_status === "desconhecido") {
    // Não bump updated_at em suspension_pending antes do claim — só em active.
    if (!dryRun && tolerance.grace_status === "active") {
      await ports.tolerances.updateCurrentPendingState(tolerance.id, {
        current_payment_pending: pending.payment_pending,
        current_fnrh_pending: pending.fnrh_pending,
        updated_at: nowIso,
      });
    }
    if (!dryRun) {
      await enqueueInternalOnly(ports.outboxQueue, {
        reservation_id: tolerance.reservation_id,
        credential_id: tolerance.credential_id,
        tolerance_id: tolerance.id,
        body: "Pagamento não confirmado pelo sistema. Senha permanece ativa até revalidação.",
        idempotency_key: `tol:${tolerance.id}:payment_unknown`,
        nowIso,
      });
    }
    return {
      tolerance_id: tolerance.id,
      action: "deferred_payment_unknown",
      payment_pending: true,
      fnrh_pending: pending.fnrh_pending,
      simulation_only: dryRun || undefined,
    };
  }

  if (pending.all_clear) {
    const itemsForClear = await ports.tolerances.listItems!(tolerance.id);
    // Crash após TTLock: item já suspenso fisicamente + grace ainda pending → NÃO cancelar.
    if (
      tolerance.grace_status === "suspension_pending" &&
      hasPhysicalSuspensionEvidence(itemsForClear)
    ) {
      return processOneToleranceRestore(ports, tolerance, options);
    }

    if (dryRun) {
      return {
        tolerance_id: tolerance.id,
        action: "cancelled_all_clear",
        payment_pending: false,
        fnrh_pending: false,
        simulation_only: true,
      };
    }
    const fromStatuses =
      tolerance.grace_status === "active"
        ? ("active" as const)
        : tolerance.grace_status === "suspension_pending"
          ? ("suspension_pending" as const)
          : null;
    if (!fromStatuses) {
      return { tolerance_id: tolerance.id, action: "noop" };
    }
    const claimed = await ports.tolerances.tryTransitionStatus!(
      tolerance.id,
      fromStatuses,
      "cancelled",
      nowIso,
      { last_error: null },
    );
    if (!claimed) {
      return { tolerance_id: tolerance.id, action: "already_processing" };
    }
    if (
      ports.presencialDiferidoAudit &&
      Array.isArray(tolerance.pending_snapshot) &&
      tolerance.pending_snapshot.includes("pagamento_presencial_diferido") &&
      !pending.payment_pending
    ) {
      await ports.presencialDiferidoAudit.markRegularizado({
        reservation_id: tolerance.reservation_id,
        at_iso: nowIso,
      });
    }
    return {
      tolerance_id: tolerance.id,
      action: "cancelled_all_clear",
      payment_pending: false,
      fnrh_pending: false,
    };
  }

  // Dry-run: não persiste pending state nem claim (exceto leitura).
  if (!dryRun && tolerance.grace_status === "active") {
    await ports.tolerances.updateCurrentPendingState(tolerance.id, {
      current_payment_pending: pending.payment_pending,
      current_fnrh_pending: pending.fnrh_pending,
      updated_at: nowIso,
    });
  }

  const items = await ports.tolerances.listItems!(tolerance.id);
  const homolog = resolveHomologFilter(flags, realExec);
  if (!homolog.ok) {
    return {
      tolerance_id: tolerance.id,
      action: "error",
      error: homolog.error,
      simulation_only: true,
    };
  }

  const eligible = items.filter(
    (i) => homolog.filter == null || i.lock_id === homolog.filter,
  );
  if (eligible.length === 0 && items.length > 0) {
    return {
      tolerance_id: tolerance.id,
      action: "skipped_homolog_filter",
      items_skipped: items.length,
      simulation_only: true,
    };
  }

  // Dry-run ou TTLock desligada: não claim, não mensagem de suspensão, não estado suspended.
  if (!realExec) {
    return {
      tolerance_id: tolerance.id,
      action: dryRun ? "would_suspend" : "skipped_ttlock_disabled",
      payment_pending: pending.payment_pending,
      fnrh_pending: pending.fnrh_pending,
      items_succeeded: 0,
      items_failed: 0,
      items_skipped: eligible.length,
      simulation_only: true,
    };
  }

  if (items.some((i) => !i.original_valid_from || !i.original_valid_until)) {
    await ports.tolerances.markError(tolerance.id, "validade_original_ausente", nowIso);
    return {
      tolerance_id: tolerance.id,
      action: "error",
      error: "validade_original_ausente",
    };
  }

  // Claim exclusivo:
  // - active → suspension_pending (CAS de status)
  // - suspension_pending stale → tryClaimStaleTolerance (status + updated_at <= cutoff)
  if (tolerance.grace_status === "suspension_pending") {
    const claimed = await ports.tolerances.tryClaimStaleTolerance!(
      tolerance.id,
      "suspension_pending",
      cutoffIso,
      nowIso,
    );
    if (!claimed) {
      return { tolerance_id: tolerance.id, action: "already_processing" };
    }
  } else {
    const claimed = await ports.tolerances.tryTransitionStatus!(
      tolerance.id,
      "active",
      "suspension_pending",
      nowIso,
    );
    if (!claimed) {
      return { tolerance_id: tolerance.id, action: "already_processing" };
    }
  }

  // Após claim, ok atualizar pending (lease já renovado).
  await ports.tolerances.updateCurrentPendingState(tolerance.id, {
    current_payment_pending: pending.payment_pending,
    current_fnrh_pending: pending.fnrh_pending,
    updated_at: nowIso,
  });

  const strategy = buildAccessSuspensionStrategy({
    original_valid_from: tolerance.original_valid_from,
    original_valid_until: tolerance.original_valid_until,
    suspended_at: nowIso,
  });
  assertSuspensionContractSafe(strategy);

  // Persist janela uma vez nos itens ainda sem suspended_valid_until.
  for (const item of items) {
    if (!item.suspended_valid_until && item.suspension_status !== "succeeded") {
      await ports.tolerances.updateItemSuspension!(item.id, {
        suspended_valid_until: strategy.suspended_valid_until,
        updated_at: nowIso,
      });
    }
  }
  const itemsFresh = await ports.tolerances.listItems!(tolerance.id);

  const apply = await applyValidityToItems({
    items: itemsFresh,
    startMs: toMs(strategy.original_valid_from),
    endMs: toMs(strategy.suspended_valid_until),
    ttlock: ports.ttlock,
    tolerances: ports.tolerances,
    nowIso,
    mode: "suspend",
    homologLockIdFilter: homolog.filter,
  });

  const actionable = itemsFresh.filter(
    (i) => homolog.filter == null || i.lock_id === homolog.filter,
  );
  const actionableSucceeded = apply.succeeded;
  const actionableFailed = apply.failed;

  if (actionable.length > 0 && actionableFailed === 0 && actionableSucceeded > 0) {
    await ports.tolerances.markSuspended(tolerance.id, nowIso);
    if (
      ports.presencialDiferidoAudit &&
      Array.isArray(tolerance.pending_snapshot) &&
      tolerance.pending_snapshot.includes("pagamento_presencial_diferido")
    ) {
      await ports.presencialDiferidoAudit.markBloqueado({
        reservation_id: tolerance.reservation_id,
        at_iso: nowIso,
        motivo: "prazo_09h_vencido_pagamento_pendente",
      });
    }
    const msg = buildAccessSuspendedMessage();
    await enqueueGuestAndInternal(ports.outboxQueue, {
      event_type: "guest_access_suspended",
      reservation_id: tolerance.reservation_id,
      credential_id: tolerance.credential_id,
      tolerance_id: tolerance.id,
      body: msg.body,
      idempotency_key: `tol:${tolerance.id}:suspended`,
      template: "access_suspended",
      nowIso,
      enqueue_internal_alert: true,
      internal_body:
        "Senha de acesso suspensa temporariamente por pendências após o fim da tolerância.",
    });
    return {
      tolerance_id: tolerance.id,
      action: "suspended",
      payment_pending: pending.payment_pending,
      fnrh_pending: pending.fnrh_pending,
      items_succeeded: apply.succeeded,
      items_failed: 0,
      items_skipped: apply.skipped,
    };
  }

  if (actionableSucceeded > 0 && actionableFailed > 0) {
    await ports.tolerances.markPartialFailure(
      tolerance.id,
      apply.lastError ?? "partial_failure",
      nowIso,
    );
    const tech = buildTechnicalFailureMessage();
    await enqueueGuestAndInternal(ports.outboxQueue, {
      event_type: "guest_technical_failure",
      reservation_id: tolerance.reservation_id,
      credential_id: tolerance.credential_id,
      tolerance_id: tolerance.id,
      body: tech.body,
      idempotency_key: `tol:${tolerance.id}:tech_fail_suspend`,
      template: "technical_failure",
      nowIso,
      enqueue_internal_alert: true,
      internal_body:
        "Falha parcial ao suspender acesso. Intervenção da recepção pode ser necessária.",
    });
    return {
      tolerance_id: tolerance.id,
      action: "partial_failure",
      payment_pending: pending.payment_pending,
      fnrh_pending: pending.fnrh_pending,
      items_succeeded: apply.succeeded,
      items_failed: apply.failed,
      error: apply.lastError ?? undefined,
    };
  }

  await ports.tolerances.markError(
    tolerance.id,
    apply.lastError ?? "suspension_failed",
    nowIso,
  );
  const techFail = buildTechnicalFailureMessage();
  await enqueueGuestAndInternal(ports.outboxQueue, {
    event_type: "guest_technical_failure",
    reservation_id: tolerance.reservation_id,
    credential_id: tolerance.credential_id,
    tolerance_id: tolerance.id,
    body: techFail.body,
    idempotency_key: `tol:${tolerance.id}:tech_fail_suspend_total`,
    template: "technical_failure",
    nowIso,
    enqueue_internal_alert: true,
    internal_body: "Falha ao suspender acesso após tolerância. Verificar credenciais.",
  });
  return {
    tolerance_id: tolerance.id,
    action: "error",
    payment_pending: pending.payment_pending,
    fnrh_pending: pending.fnrh_pending,
    items_succeeded: apply.succeeded,
    items_failed: apply.failed,
    error: apply.lastError ?? "suspension_failed",
  };
}

export async function processOneToleranceRestore(
  ports: AccessToleranceProcessorPorts,
  tolerance: AccessToleranceRecord,
  options: AccessToleranceProcessorOptions = {},
): Promise<ProcessToleranceResult> {
  requireRepoMethods(ports.tolerances);
  const flags = options.flags ?? getAccessToleranceFlags();
  const now = ports.clock.now();
  const nowIso = now.toISOString();
  const dryRun = options.dryRun === true;
  const realExec = isTtlockExecutionReal(flags, dryRun);
  const cutoffIso = resolveStaleCutoff(now, options);

  if (!flags.processorEnabled) {
    return { tolerance_id: tolerance.id, action: "skipped_flag_off", simulation_only: true };
  }

  const restorable = ["suspended", "partial_failure", "restore_pending", "suspension_pending"] as const;
  if (!restorable.includes(tolerance.grace_status as (typeof restorable)[number])) {
    return { tolerance_id: tolerance.id, action: "noop" };
  }

  // suspension_pending só restaura se houver evidência física nos itens.
  if (tolerance.grace_status === "suspension_pending") {
    const itemsProbe = await ports.tolerances.listItems!(tolerance.id);
    if (!hasPhysicalSuspensionEvidence(itemsProbe)) {
      return { tolerance_id: tolerance.id, action: "noop" };
    }
  }

  let pendingInput;
  try {
    pendingInput = await ports.pending.getReservationPendingInput(tolerance.reservation_id);
  } catch {
    return { tolerance_id: tolerance.id, action: "deferred_payment_unavailable" };
  }

  if (pendingInput.payment_status === "desconhecido") {
    return {
      tolerance_id: tolerance.id,
      action: "deferred_payment_unknown",
      payment_pending: true,
    };
  }

  const pending = evaluateReservationPendingState(pendingInput);

  if (!pending.all_clear) {
    return {
      tolerance_id: tolerance.id,
      action: "noop",
      payment_pending: pending.payment_pending,
      fnrh_pending: pending.fnrh_pending,
    };
  }

  const items = await ports.tolerances.listItems!(tolerance.id);
  const homolog = resolveHomologFilter(flags, realExec);
  if (!homolog.ok) {
    return { tolerance_id: tolerance.id, action: "error", error: homolog.error, simulation_only: true };
  }
  const eligible = items.filter(
    (i) => homolog.filter == null || i.lock_id === homolog.filter,
  );
  if (eligible.length === 0 && items.length > 0) {
    return {
      tolerance_id: tolerance.id,
      action: "skipped_homolog_filter",
      items_skipped: items.length,
      simulation_only: true,
    };
  }

  if (!realExec) {
    return {
      tolerance_id: tolerance.id,
      action: dryRun ? "would_restore" : "skipped_ttlock_disabled",
      payment_pending: false,
      fnrh_pending: false,
      simulation_only: true,
    };
  }

  // Claim exclusivo:
  // - restore_pending / suspension_pending stale → lease temporal
  // - suspended / partial_failure → CAS de status para restore_pending
  if (
    tolerance.grace_status === "restore_pending" ||
    tolerance.grace_status === "suspension_pending"
  ) {
    const claimed = await ports.tolerances.tryClaimStaleTolerance!(
      tolerance.id,
      tolerance.grace_status,
      cutoffIso,
      nowIso,
    );
    if (!claimed) {
      return { tolerance_id: tolerance.id, action: "already_processing" };
    }
    if (tolerance.grace_status === "suspension_pending") {
      const moved = await ports.tolerances.tryTransitionStatus!(
        tolerance.id,
        "suspension_pending",
        "restore_pending",
        nowIso,
      );
      if (!moved) {
        return { tolerance_id: tolerance.id, action: "already_processing" };
      }
    }
  } else {
    const claimed = await ports.tolerances.tryTransitionStatus!(
      tolerance.id,
      ["suspended", "partial_failure"],
      "restore_pending",
      nowIso,
    );
    if (!claimed) {
      return { tolerance_id: tolerance.id, action: "already_processing" };
    }
  }

  await ports.tolerances.updateCurrentPendingState(tolerance.id, {
    current_payment_pending: pending.payment_pending,
    current_fnrh_pending: pending.fnrh_pending,
    updated_at: nowIso,
  });

  const strategy = buildAccessRestoreStrategy({
    original_valid_from: tolerance.original_valid_from,
    original_valid_until: tolerance.original_valid_until,
  });
  assertSuspensionContractSafe(strategy);

  const apply = await applyValidityToItems({
    items,
    startMs: toMs(strategy.restore_valid_from),
    endMs: toMs(strategy.restore_valid_until),
    ttlock: ports.ttlock,
    tolerances: ports.tolerances,
    nowIso,
    mode: "restore",
    homologLockIdFilter: homolog.filter,
  });

  if (apply.failed === 0 && apply.succeeded > 0) {
    await ports.tolerances.markRestored(tolerance.id, nowIso);
    if (
      ports.presencialDiferidoAudit &&
      Array.isArray(tolerance.pending_snapshot) &&
      tolerance.pending_snapshot.includes("pagamento_presencial_diferido")
    ) {
      await ports.presencialDiferidoAudit.markRegularizado({
        reservation_id: tolerance.reservation_id,
        at_iso: nowIso,
      });
    }
    const msg = buildAccessRestoredMessage();
    await enqueueGuestAndInternal(ports.outboxQueue, {
      event_type: "guest_access_restored",
      reservation_id: tolerance.reservation_id,
      credential_id: tolerance.credential_id,
      tolerance_id: tolerance.id,
      body: msg.body,
      idempotency_key: `tol:${tolerance.id}:restored`,
      template: "access_restored",
      nowIso,
      enqueue_internal_alert: true,
      internal_body: "Acessos restabelecidos após regularização das pendências.",
    });
    return {
      tolerance_id: tolerance.id,
      action: "restored",
      payment_pending: false,
      fnrh_pending: false,
      items_succeeded: apply.succeeded,
      items_failed: 0,
      items_skipped: apply.skipped,
    };
  }

  if (apply.succeeded > 0 && apply.failed > 0) {
    await ports.tolerances.markPartialFailure(
      tolerance.id,
      apply.lastError ?? "restore_partial_failure",
      nowIso,
    );
    return {
      tolerance_id: tolerance.id,
      action: "partial_failure",
      items_succeeded: apply.succeeded,
      items_failed: apply.failed,
      error: apply.lastError ?? undefined,
    };
  }

  await ports.tolerances.markError(
    tolerance.id,
    apply.lastError ?? "restore_failed",
    nowIso,
  );
  return {
    tolerance_id: tolerance.id,
    action: "error",
    items_succeeded: apply.succeeded,
    items_failed: apply.failed,
    error: apply.lastError ?? "restore_failed",
  };
}

export async function processAccessTolerancesBatch(
  ports: AccessToleranceProcessorPorts,
  options: AccessToleranceProcessorOptions = {},
): Promise<ProcessToleranceResult[]> {
  requireRepoMethods(ports.tolerances);
  const flags = options.flags ?? getAccessToleranceFlags();
  if (!flags.processorEnabled) {
    return [];
  }
  const limit = options.batchLimit ?? 20;
  const started = ports.clock.now().getTime();
  const deadline = options.deadlineMs ?? started + BATCH_DEADLINE_MS;
  const nowIso = ports.clock.now().toISOString();
  const cutoffIso =
    options.staleCutoffIso ?? new Date(started - STALE_PENDING_MS).toISOString();
  const childOptions: AccessToleranceProcessorOptions = {
    ...options,
    staleCutoffIso: cutoffIso,
  };

  const due = await ports.tolerances.listDueForSuspension!(nowIso, limit);
  const stale =
    ports.tolerances.listStalePending != null
      ? await ports.tolerances.listStalePending(cutoffIso, limit)
      : [];
  const restoreCandidates = await ports.tolerances.listCandidatesForRestore!(limit);

  const seen = new Set<string>();
  const results: ProcessToleranceResult[] = [];

  async function runOne(
    tol: AccessToleranceRecord,
    kind: "due" | "stale" | "restore",
  ): Promise<void> {
    if (seen.has(tol.id)) return;
    seen.add(tol.id);
    if (ports.clock.now().getTime() >= deadline) {
      results.push({
        tolerance_id: tol.id,
        action: "noop",
        error: "batch_deadline",
        simulation_only: true,
      });
      return;
    }
    try {
      if (kind === "restore" || tol.grace_status === "restore_pending") {
        results.push(await processOneToleranceRestore(ports, tol, childOptions));
      } else {
        results.push(await processOneToleranceDue(ports, tol, childOptions));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 120) : "error";
      results.push({
        tolerance_id: tol.id,
        action: "error",
        error: msg,
      });
    }
  }

  for (const tol of due) {
    await runOne(tol, "due");
  }
  for (const tol of stale) {
    await runOne(tol, "stale");
  }
  for (const tol of restoreCandidates) {
    await runOne(tol, "restore");
  }
  return results;
}
