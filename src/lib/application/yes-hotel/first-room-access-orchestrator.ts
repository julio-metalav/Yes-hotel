/**
 * Orquestrador: processa evento de abertura → decisão de domínio → persistência atômica (UoW).
 * Sem fetch, Supabase, TTLock ou DigiSac no domínio.
 */

import {
  decideAccessGrace,
  evaluateFirstRoomAccessEvent,
  TTLOCK_RECORD_TYPE,
  type NormalizedRoomAccessEvent,
} from "../../domain/yes-hotel/first-room-access-policy.ts";
import { buildWelcomePendingMessage } from "../../domain/yes-hotel/access-grace-messages.ts";
import { evaluateReservationPendingState } from "../../domain/yes-hotel/reservation-pending-state.ts";
import type { FirstRoomAccessCommitCommand } from "./first-room-access-commit.ts";
import { enqueueInternalFirstAccessMessage } from "./enqueue-internal-first-access.ts";
import type { FirstRoomAccessPorts } from "./first-room-access-ports.ts";
import type {
  AccessMethodPersisted,
  ProcessFirstRoomAccessInput,
  ProcessFirstRoomAccessResult,
  ProvisionedCredentialItem,
} from "./first-room-access-types.ts";

function mapAccessMethod(recordType: number): AccessMethodPersisted {
  switch (recordType) {
    case TTLOCK_RECORD_TYPE.PASSCODE_UNLOCK:
      return "passcode";
    case TTLOCK_RECORD_TYPE.APP_UNLOCK:
      return "app";
    case TTLOCK_RECORD_TYPE.GATEWAY_UNLOCK:
    case TTLOCK_RECORD_TYPE.GATEWAY_UNLOCK_ALT:
      return "gateway";
    case TTLOCK_RECORD_TYPE.IC_CARD_UNLOCK:
      return "ic_card";
    case TTLOCK_RECORD_TYPE.MECHANICAL_KEY:
      return "mechanical_key";
    case TTLOCK_RECORD_TYPE.REMOTE_CONTROL:
      return "remote";
    case TTLOCK_RECORD_TYPE.OPEN_FROM_INSIDE:
      return "inside";
    case TTLOCK_RECORD_TYPE.INVALID_PASSCODE:
      return "invalid_passcode";
    default:
      return "other";
  }
}

function assertNoPasswordLeak(value: unknown): void {
  const json = JSON.stringify(value);
  if (/"keyboardPwd"\s*:/i.test(json) || /"password"\s*:\s*"/i.test(json) || /"senha"\s*:\s*"/i.test(json)) {
    throw new Error("Payload contém campo de senha proibido.");
  }
}

function classifyDestination(item: ProvisionedCredentialItem): "apartamento" | "portao_externo" | "portao_interno" | "other" {
  if (item.lock_type === "apartamento") return "apartamento";
  if (item.lock_type === "portao_externo") return "portao_externo";
  if (item.lock_type === "portao_interno") return "portao_interno";
  const d = item.logical_destination.toUpperCase();
  if (d.startsWith("APT-") || d.startsWith("APTO-")) return "apartamento";
  if (d.includes("EXTERNAL") || d.includes("EXT")) return "portao_externo";
  if (d.includes("INTERNAL") || d.includes("INT")) return "portao_interno";
  return "other";
}

function validateThreeTargets(items: ProvisionedCredentialItem[]): {
  ok: true;
  apt: ProvisionedCredentialItem;
  gateExt: ProvisionedCredentialItem;
  gateInt: ProvisionedCredentialItem;
} | { ok: false; error: string } {
  if (items.some((i) => i.remote_keyboard_pwd_id == null || !Number.isFinite(i.remote_keyboard_pwd_id))) {
    return { ok: false, error: "Item sem remote_keyboard_pwd_id." };
  }
  const apt = items.find((i) => classifyDestination(i) === "apartamento");
  const gateExt = items.find((i) => classifyDestination(i) === "portao_externo");
  const gateInt = items.find((i) => classifyDestination(i) === "portao_interno");
  if (!apt) return { ok: false, error: "Credencial sem item de apartamento provisionado." };
  if (!gateExt) return { ok: false, error: "Credencial sem portão externo provisionado." };
  if (!gateInt) return { ok: false, error: "Credencial sem portão interno provisionado." };
  return { ok: true, apt, gateExt, gateInt };
}

function resultFromExistingEvent(
  eventId: string,
  status: ProcessFirstRoomAccessResult["status"],
  extra?: Partial<ProcessFirstRoomAccessResult>,
): ProcessFirstRoomAccessResult {
  return { status, event_id: eventId, ...extra };
}

/** Opções efêmeras — nunca entram no evento persistido. */
export type ProcessFirstRoomAccessOptions = {
  /** Senha só em memória para correlação; descartar após o processamento. */
  ephemeral_keyboard_pwd?: string;
};

/**
 * Processa um evento sanitizado de abertura.
 * Persistência integral via ports.uow.commitFirstRoomAccess (RPC em produção).
 */
export async function processFirstRoomAccessEvent(
  input: ProcessFirstRoomAccessInput,
  ports: FirstRoomAccessPorts,
  options?: ProcessFirstRoomAccessOptions,
): Promise<ProcessFirstRoomAccessResult> {
  assertNoPasswordLeak(input);
  if (input.raw_payload_sanitized) {
    assertNoPasswordLeak(input.raw_payload_sanitized);
  }

  const existing = await ports.events.findByIdempotencyKey(input.idempotency_key);
  if (existing) {
    if (existing.processing_status === "ignored") {
      return resultFromExistingEvent(existing.id, "ignored", {
        ignored_reason: existing.ignored_reason ?? "duplicate",
      });
    }
    if (existing.processing_status === "processed") {
      const tol = existing.credential_id
        ? await ports.tolerances.findByCredentialId(existing.credential_id)
        : null;
      if (tol && ports.accessOutboxQueue && existing.reservation_id) {
        // Reconciliação idempotente: repara outbox ausente sem reabrir tolerância.
        const ctx = ports.reservationDisplay
          ? await ports.reservationDisplay.getContext(existing.reservation_id)
          : {
              apartment_number: "—",
              reservation_code: "—",
              guest_main_name: "hóspede",
            };
        await enqueueInternalFirstAccessMessage({
          queue: ports.accessOutboxQueue,
          reservation_id: existing.reservation_id,
          credential_id: existing.credential_id,
          tolerance_id: tol.id,
          apartment_number: ctx.apartment_number,
          reservation_code: ctx.reservation_code,
          guest_main_name: ctx.guest_main_name,
          payment_pending: tol.current_payment_pending,
          fnrh_pending: tol.current_fnrh_pending,
          grace_started: true,
          nowIso: ports.clock.now().toISOString(),
        });
        if (tol.pending_payment_at_start || tol.pending_fnrh_at_start) {
          const welcome = buildWelcomePendingMessage({
            payment_pending: tol.pending_payment_at_start,
            fnrh_pending: tol.pending_fnrh_at_start,
          });
          if (welcome) {
            await ports.accessOutboxQueue.enqueue({
              event_type: "guest_welcome_pending",
              channel: "whatsapp",
              reservation_id: existing.reservation_id,
              credential_id: existing.credential_id,
              access_event_id: existing.id,
              tolerance_id: tol.id,
              recipient_ref: null,
              template: "access_grace_welcome",
              payload: { body: welcome.body },
              idempotency_key: `welcome:${existing.credential_id}:${tol.grace_started_at}`,
              status: "pending",
              attempts: 0,
              available_at: ports.clock.now().toISOString(),
              processed_at: null,
              last_error: null,
            });
            await ports.accessOutboxQueue.enqueue({
              event_type: "guest_welcome_pending",
              channel: "email",
              reservation_id: existing.reservation_id,
              credential_id: existing.credential_id,
              access_event_id: existing.id,
              tolerance_id: tol.id,
              recipient_ref: null,
              template: "access_grace_welcome",
              payload: { body: welcome.body, subject: "Yes Hotel — acesso" },
              idempotency_key: `welcome:${existing.credential_id}:${tol.grace_started_at}:email`,
              status: "pending",
              attempts: 0,
              available_at: ports.clock.now().toISOString(),
              processed_at: null,
              last_error: null,
            });
          }
        }
      }
      if (tol) {
        return resultFromExistingEvent(existing.id, "already_started", {
          tolerance_id: tol.id,
          suspension_due_at: tol.suspension_due_at,
          pending_reasons: tol.pending_snapshot,
        });
      }
      return resultFromExistingEvent(existing.id, "processed_no_pending");
    }
    if (existing.processing_status === "failed") {
      return resultFromExistingEvent(existing.id, "failed", {
        error: existing.ignored_reason ?? "previous_failure",
      });
    }
    return resultFromExistingEvent(existing.id, "already_started");
  }

  const now = ports.clock.now();
  const receivedAt = now.toISOString();
  const accessMethod = mapAccessMethod(input.record_type);

  const eventWrite = {
    source: input.source,
    source_event_id: input.source_event_id,
    idempotency_key: input.idempotency_key,
    occurred_at: input.occurred_at,
    received_at: receivedAt,
    lock_id: input.lock_id,
    keyboard_pwd_id: input.keyboard_pwd_id ?? null,
    record_type: input.record_type,
    access_method: accessMethod,
    success: input.success,
    raw_payload_sanitized: input.raw_payload_sanitized ?? null,
  };

  try {
    const correlation = await ports.correlation.correlateRoomPasscodeEvent({
      lock_id: input.lock_id,
      keyboard_pwd_id: input.keyboard_pwd_id,
      occurred_at: input.occurred_at,
      record_type: input.record_type,
      ephemeral_keyboard_pwd: options?.ephemeral_keyboard_pwd,
    });
    if (options) {
      options.ephemeral_keyboard_pwd = undefined;
    }

    const correlationWrite = {
      reservation_id: correlation.reservation_id ?? null,
      credential_id: correlation.credential_id ?? null,
      credential_item_id: correlation.credential_item_id ?? null,
      logical_destination: correlation.logical_destination ?? null,
      keyboard_pwd_id: correlation.keyboard_pwd_id ?? input.keyboard_pwd_id ?? null,
    };

    if (correlation.ambiguous) {
      const cmd: FirstRoomAccessCommitCommand = {
        decision: "ignored",
        event: eventWrite,
        correlation: correlationWrite,
        ignored_reason: "ambiguous",
        outbox: {
          event_type: "internal_alert",
          channel: "whatsapp",
          reservation_id: correlation.reservation_id ?? "00000000-0000-4000-8000-000000000000",
          payload: {
            kind: "internal_alert",
            code: "access_correlation_ambiguous",
            message: "Correlação ambígua de primeiro acesso; tolerância não iniciada.",
            details: { lock_id: input.lock_id },
          },
          idempotency_key: `alert:ambiguous:${input.idempotency_key}`,
        },
      };
      // Sem reservation_id válido: não forçar outbox com UUID falso — só ignore.
      if (!correlation.reservation_id) {
        cmd.outbox = null;
      }
      return await ports.uow.commitFirstRoomAccess(cmd);
    }

    const existingTolerance = correlation.credential_id
      ? await ports.tolerances.findByCredentialId(correlation.credential_id)
      : null;
    const existingFirstProcessed = correlation.credential_id
      ? await ports.events.findFirstProcessedApartmentByCredentialId(correlation.credential_id)
      : null;
    const firstAccessAlready =
      !!existingTolerance || !!existingFirstProcessed;

    const normalized: NormalizedRoomAccessEvent = {
      source_event_id: input.source_event_id,
      occurred_at: input.occurred_at,
      lock_id: input.lock_id,
      keyboard_pwd_id: correlation.keyboard_pwd_id ?? input.keyboard_pwd_id,
      record_type: input.record_type,
      success: input.success,
      logical_destination: correlation.logical_destination,
      lock_type: correlation.lock_type,
      reservation_id: correlation.reservation_id,
      credential_id: correlation.credential_id,
      credential_item_id: correlation.credential_item_id,
      within_reservation_window: correlation.within_reservation_window,
      correlated: correlation.correlated,
      is_admin_operator: input.is_admin_operator,
    };

    const decision = evaluateFirstRoomAccessEvent(normalized, {
      first_access_already_registered: firstAccessAlready,
      event_already_processed: false,
      grace_already_started: firstAccessAlready,
    });

    if (!decision.accepted) {
      const reason = decision.ignored_reason ?? decision.decision;
      if (
        firstAccessAlready &&
        (reason === "already_started" || reason === "duplicate")
      ) {
        return await ports.uow.commitFirstRoomAccess({
          decision: "already_started",
          event: eventWrite,
          correlation: correlationWrite,
          ignored_reason: reason,
          existing_tolerance_id: existingTolerance?.id,
          existing_suspension_due_at: existingTolerance?.suspension_due_at,
          existing_pending_snapshot: existingTolerance?.pending_snapshot,
        });
      }
      return await ports.uow.commitFirstRoomAccess({
        decision: "ignored",
        event: eventWrite,
        correlation: correlationWrite,
        ignored_reason: reason,
      });
    }

    if (existingTolerance || existingFirstProcessed) {
      return await ports.uow.commitFirstRoomAccess({
        decision: "already_started",
        event: eventWrite,
        correlation: correlationWrite,
        ignored_reason: "already_started",
        existing_tolerance_id: existingTolerance?.id,
        existing_suspension_due_at: existingTolerance?.suspension_due_at,
        existing_pending_snapshot: existingTolerance?.pending_snapshot,
      });
    }

    if (!correlation.reservation_id || !correlation.credential_id) {
      return await ports.uow.commitFirstRoomAccess({
        decision: "ignored",
        event: eventWrite,
        correlation: correlationWrite,
        ignored_reason: "uncorrelated",
      });
    }

    const pendingInput = await ports.pending.getReservationPendingInput(
      correlation.reservation_id,
    );
    const pending = evaluateReservationPendingState(pendingInput);
    const ppdFeatureOn = ports.presencialDiferidoFeatureEnabled === true;
    const ppdAutorizado =
      ppdFeatureOn && pendingInput.pagamento_presencial_diferido_autorizado === true;

    const grace = decideAccessGrace({
      event_accepted: true,
      first_access_already_registered: false,
      grace_already_started: false,
      payment_pending: pending.payment_pending,
      fnrh_pending: pending.fnrh_pending,
      pending_reasons: pending.pending_reasons,
      occurred_at: input.occurred_at,
      pagamento_presencial_diferido_autorizado: ppdAutorizado,
    });

    if (!grace.start_grace) {
      const noPending = await ports.uow.commitFirstRoomAccess({
        decision: "processed_no_pending",
        event: eventWrite,
        correlation: correlationWrite,
      });
      if (
        noPending.status === "processed_no_pending" &&
        ports.accessOutboxQueue &&
        correlation.reservation_id
      ) {
        const ctx = ports.reservationDisplay
          ? await ports.reservationDisplay.getContext(correlation.reservation_id)
          : {
              apartment_number: "—",
              reservation_code: correlation.reservation_id.slice(0, 8),
              guest_main_name: "hóspede",
            };
        await enqueueInternalFirstAccessMessage({
          queue: ports.accessOutboxQueue,
          reservation_id: correlation.reservation_id,
          credential_id: correlation.credential_id ?? null,
          tolerance_id: null,
          apartment_number: ctx.apartment_number,
          reservation_code: ctx.reservation_code,
          guest_main_name: ctx.guest_main_name,
          payment_pending: false,
          fnrh_pending: false,
          grace_started: false,
          nowIso: ports.clock.now().toISOString(),
        });
      }
      return noPending;
    }

    const items = await ports.items.listProvisionedItemsByCredentialId(
      correlation.credential_id,
    );
    const targets = validateThreeTargets(items);
    if (!targets.ok) {
      throw new Error(targets.error);
    }

    const originalFrom =
      correlation.original_valid_from ??
      (() => {
        throw new Error("original_valid_from ausente na correlação.");
      })();
    const originalUntil =
      correlation.original_valid_until ??
      (() => {
        throw new Error("original_valid_until ausente na correlação.");
      })();

    const ppdEfetivado = grace.grace_mode === "presencial_diferido_09h";
    const welcome = buildWelcomePendingMessage({
      payment_pending: pending.payment_pending,
      fnrh_pending: pending.fnrh_pending,
      presencial_diferido_efetivado: ppdEfetivado,
    });
    if (!welcome) {
      throw new Error("Mensagem de boas-vindas esperada com pendências.");
    }

    const itemWrites = [targets.apt, targets.gateExt, targets.gateInt].map((i) => {
      const lock_class = classifyDestination(i);
      if (lock_class === "other") {
        throw new Error(`Destino lógico inválido: ${i.logical_destination}`);
      }
      return {
        credential_item_id: i.id,
        logical_destination: i.logical_destination,
        lock_id: i.lock_id,
        remote_keyboard_pwd_id: i.remote_keyboard_pwd_id,
        original_valid_from: originalFrom,
        original_valid_until: originalUntil,
        lock_class,
      };
    });

    const outboxPayload = {
      kind: "guest_welcome_pending",
      reservation_id: correlation.reservation_id,
      credential_id: correlation.credential_id,
      payment_pending: pending.payment_pending,
      fnrh_pending: pending.fnrh_pending,
      body: welcome.body,
      pending_snapshot: grace.pending_snapshot,
    };
    assertNoPasswordLeak(outboxPayload);

    const result = await ports.uow.commitFirstRoomAccess({
      decision: "grace_started",
      event: eventWrite,
      correlation: correlationWrite,
      grace: {
        first_room_access_at: grace.grace_started_at!,
        grace_started_at: grace.grace_started_at!,
        suspension_due_at: grace.suspension_due_at!,
        pending_payment: pending.payment_pending,
        pending_fnrh: pending.fnrh_pending,
        pending_snapshot: grace.pending_snapshot,
        original_valid_from: originalFrom,
        original_valid_until: originalUntil,
      },
      items: itemWrites,
      outbox: {
        event_type: "guest_welcome_pending",
        channel: "whatsapp",
        reservation_id: correlation.reservation_id,
        credential_id: correlation.credential_id,
        template: "access_grace_welcome",
        payload: outboxPayload,
        idempotency_key: `welcome:${correlation.credential_id}:${grace.grace_started_at}`,
      },
    });
    assertNoPasswordLeak(result);
    if (result.status === "grace_started" && ports.presencialDiferidoAudit && ppdAutorizado) {
      const ctxApt = ports.reservationDisplay
        ? await ports.reservationDisplay.getContext(correlation.reservation_id)
        : null;
      await ports.presencialDiferidoAudit.persistFirstAccessOutcome({
        reservation_id: correlation.reservation_id,
        autorizado: true,
        efetivado: ppdEfetivado,
        regra: grace.presencial_diferido?.regra ?? null,
        first_access_at: input.occurred_at,
        deadline_iso: ppdEfetivado ? grace.suspension_due_at ?? null : null,
        now_iso: ports.clock.now().toISOString(),
        apartment_number: ctxApt?.apartment_number ?? null,
      });
    }
    if (
      result.status === "grace_started" &&
      ports.accessOutboxQueue &&
      correlation.reservation_id
    ) {
      const ctx = ports.reservationDisplay
        ? await ports.reservationDisplay.getContext(correlation.reservation_id)
        : {
            apartment_number: "—",
            reservation_code: "—",
            guest_main_name: "hóspede",
          };
      await enqueueInternalFirstAccessMessage({
        queue: ports.accessOutboxQueue,
        reservation_id: correlation.reservation_id,
        credential_id: correlation.credential_id ?? null,
        tolerance_id: result.tolerance_id ?? null,
        apartment_number: ctx.apartment_number,
        reservation_code: ctx.reservation_code,
        guest_main_name: ctx.guest_main_name,
        payment_pending: pending.payment_pending,
        fnrh_pending: pending.fnrh_pending,
        grace_started: true,
        presencial_diferido_efetivado: ppdEfetivado,
        nowIso: ports.clock.now().toISOString(),
      });
      // Canal e-mail complementar (idempotente); ausência de e-mail tratada no dispatcher.
      await ports.accessOutboxQueue.enqueue({
        event_type: "guest_welcome_pending",
        channel: "email",
        reservation_id: correlation.reservation_id,
        credential_id: correlation.credential_id ?? null,
        access_event_id: result.event_id ?? null,
        tolerance_id: result.tolerance_id ?? null,
        recipient_ref: null,
        template: "access_grace_welcome",
        payload: { body: welcome.body, subject: "Yes Hotel — acesso" },
        idempotency_key: `welcome:${correlation.credential_id}:${grace.grace_started_at}:email`,
        status: "pending",
        attempts: 0,
        available_at: ports.clock.now().toISOString(),
        processed_at: null,
        last_error: null,
      });
    }
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Domínio/RPC falhou: sem persistência parcial (RPC faz rollback; memória restaura snapshot).
    return {
      status: "failed",
      error: msg,
    };
  }
}
