/**
 * Adapters in-memory para testes do fluxo de primeiro acesso.
 * NÃO usar em produção. NÃO exportar pelo index da aplicação.
 */

import { randomUUID } from "node:crypto";
import type {
  AccessEventRepository,
  AccessToleranceRepository,
  ClockPort,
  CommunicationOutboxPort,
  CredentialCorrelationPort,
  CredentialItemsPort,
  FirstRoomAccessPorts,
  ReservationPendingStatePort,
  UnitOfWorkPort,
} from "../first-room-access-ports";
import type {
  AccessEventRecord,
  AccessToleranceItemRecord,
  AccessToleranceRecord,
  CorrelatedRoomAccessResult,
  CreateToleranceInput,
  OutboxMessage,
  ProcessFirstRoomAccessInput,
  ProvisionedCredentialItem,
} from "../first-room-access-types";
import type { ReservationPendingStateInput } from "../../../domain/yes-hotel/reservation-pending-state";

type MemoryState = {
  events: AccessEventRecord[];
  tolerances: AccessToleranceRecord[];
  toleranceItems: AccessToleranceItemRecord[];
  outbox: OutboxMessage[];
};

function cloneState(state: MemoryState): MemoryState {
  return structuredClone(state);
}

export class FixedClock implements ClockPort {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(next: Date): void {
    this.current = new Date(next.getTime());
  }
}

export class InMemoryUnitOfWork implements UnitOfWorkPort {
  constructor(private readonly getState: () => MemoryState, private readonly setState: (s: MemoryState) => void) {}

  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const snapshot = cloneState(this.getState());
    try {
      return await fn();
    } catch (e) {
      this.setState(snapshot);
      throw e;
    }
  }
}

export class InMemoryAccessEventRepository implements AccessEventRepository {
  constructor(private readonly state: MemoryState) {}

  async findByIdempotencyKey(key: string): Promise<AccessEventRecord | null> {
    return this.state.events.find((e) => e.idempotency_key === key) ?? null;
  }

  async insertRawEvent(
    input: ProcessFirstRoomAccessInput & {
      access_method: AccessEventRecord["access_method"];
      received_at: string;
    },
  ): Promise<AccessEventRecord> {
    const row: AccessEventRecord = {
      id: randomUUID(),
      source: input.source,
      source_event_id: input.source_event_id,
      idempotency_key: input.idempotency_key,
      occurred_at: input.occurred_at,
      received_at: input.received_at,
      lock_id: input.lock_id,
      keyboard_pwd_id: input.keyboard_pwd_id ?? null,
      record_type: input.record_type,
      access_method: input.access_method,
      success: input.success,
      reservation_id: null,
      credential_id: null,
      credential_item_id: null,
      logical_destination: null,
      processing_status: "received",
      ignored_reason: null,
      raw_payload_sanitized: input.raw_payload_sanitized ?? null,
      processed_at: null,
      created_at: input.received_at,
    };
    this.state.events.push(row);
    return { ...row };
  }

  private mutate(id: string, patch: Partial<AccessEventRecord>): void {
    const idx = this.state.events.findIndex((e) => e.id === id);
    if (idx < 0) throw new Error(`Evento não encontrado: ${id}`);
    this.state.events[idx] = { ...this.state.events[idx], ...patch };
  }

  async markProcessed(eventId: string, processedAt: string): Promise<void> {
    this.mutate(eventId, {
      processing_status: "processed",
      processed_at: processedAt,
      ignored_reason: null,
    });
  }

  async markIgnored(eventId: string, reason: string, processedAt: string): Promise<void> {
    this.mutate(eventId, {
      processing_status: "ignored",
      ignored_reason: reason,
      processed_at: processedAt,
    });
  }

  async markFailed(eventId: string, error: string, processedAt: string): Promise<void> {
    this.mutate(eventId, {
      processing_status: "failed",
      ignored_reason: error,
      processed_at: processedAt,
    });
  }

  async attachCorrelation(
    eventId: string,
    correlation: {
      reservation_id: string | null;
      credential_id: string | null;
      credential_item_id: string | null;
      logical_destination: string | null;
      keyboard_pwd_id: number | null;
    },
  ): Promise<void> {
    this.mutate(eventId, {
      reservation_id: correlation.reservation_id,
      credential_id: correlation.credential_id,
      credential_item_id: correlation.credential_item_id,
      logical_destination: correlation.logical_destination,
      keyboard_pwd_id: correlation.keyboard_pwd_id,
    });
  }
}

export class InMemoryAccessToleranceRepository implements AccessToleranceRepository {
  constructor(private readonly state: MemoryState) {}

  async findByCredentialId(credentialId: string): Promise<AccessToleranceRecord | null> {
    return this.state.tolerances.find((t) => t.credential_id === credentialId) ?? null;
  }

  async createTolerance(input: CreateToleranceInput): Promise<AccessToleranceRecord> {
    if (input.items.length !== 3) {
      throw new Error("Tolerância exige exatamente 3 itens.");
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const row: AccessToleranceRecord = {
      id,
      reservation_id: input.reservation_id,
      credential_id: input.credential_id,
      first_room_access_at: input.first_room_access_at,
      grace_started_at: input.grace_started_at,
      suspension_due_at: input.suspension_due_at,
      grace_status: "active",
      pending_payment_at_start: input.pending_payment_at_start,
      pending_fnrh_at_start: input.pending_fnrh_at_start,
      current_payment_pending: input.pending_payment_at_start,
      current_fnrh_pending: input.pending_fnrh_at_start,
      pending_snapshot: [...input.pending_snapshot],
      original_valid_from: input.original_valid_from,
      original_valid_until: input.original_valid_until,
      suspended_at: null,
      restored_at: null,
      welcome_message_event_id: input.welcome_message_event_id,
      last_error: null,
      created_at: now,
      updated_at: now,
    };
    this.state.tolerances.push(row);
    for (const item of input.items) {
      const itemRow: AccessToleranceItemRecord = {
        id: randomUUID(),
        tolerance_id: id,
        credential_item_id: item.credential_item_id,
        logical_destination: item.logical_destination,
        lock_id: item.lock_id,
        remote_keyboard_pwd_id: item.remote_keyboard_pwd_id,
        original_valid_from: input.original_valid_from,
        original_valid_until: input.original_valid_until,
        suspended_valid_until: null,
        suspension_status: "pending",
        restore_status: "not_applicable",
        suspension_attempts: 0,
        restore_attempts: 0,
        last_attempt_at: null,
        last_error: null,
        suspended_at: null,
        restored_at: null,
        created_at: now,
        updated_at: now,
      };
      this.state.toleranceItems.push(itemRow);
    }
    return { ...row };
  }

  private patch(id: string, patch: Partial<AccessToleranceRecord>): void {
    const idx = this.state.tolerances.findIndex((t) => t.id === id);
    if (idx < 0) throw new Error(`Tolerância não encontrada: ${id}`);
    this.state.tolerances[idx] = { ...this.state.tolerances[idx], ...patch };
  }

  async updateCurrentPendingState(
    toleranceId: string,
    state: {
      current_payment_pending: boolean;
      current_fnrh_pending: boolean;
      updated_at: string;
    },
  ): Promise<void> {
    this.patch(toleranceId, state);
  }

  async markCancelled(toleranceId: string, updatedAt: string): Promise<void> {
    this.patch(toleranceId, { grace_status: "cancelled", updated_at: updatedAt });
  }
  async markSuspensionPending(toleranceId: string, updatedAt: string): Promise<void> {
    this.patch(toleranceId, { grace_status: "suspension_pending", updated_at: updatedAt });
  }
  async markSuspended(toleranceId: string, suspendedAt: string): Promise<void> {
    this.patch(toleranceId, {
      grace_status: "suspended",
      suspended_at: suspendedAt,
      updated_at: suspendedAt,
    });
  }
  async markPartialFailure(toleranceId: string, error: string, updatedAt: string): Promise<void> {
    this.patch(toleranceId, {
      grace_status: "partial_failure",
      last_error: error,
      updated_at: updatedAt,
    });
  }
  async markRestorePending(toleranceId: string, updatedAt: string): Promise<void> {
    this.patch(toleranceId, { grace_status: "restore_pending", updated_at: updatedAt });
  }
  async markRestored(toleranceId: string, restoredAt: string): Promise<void> {
    this.patch(toleranceId, {
      grace_status: "restored",
      restored_at: restoredAt,
      updated_at: restoredAt,
    });
  }
  async markError(toleranceId: string, error: string, updatedAt: string): Promise<void> {
    this.patch(toleranceId, {
      grace_status: "error",
      last_error: error,
      updated_at: updatedAt,
    });
  }
}

export class InMemoryCredentialCorrelationPort implements CredentialCorrelationPort {
  constructor(private readonly result: CorrelatedRoomAccessResult) {}

  async correlateRoomPasscodeEvent(): Promise<CorrelatedRoomAccessResult> {
    return { ...this.result };
  }
}

export class InMemoryReservationPendingStatePort implements ReservationPendingStatePort {
  constructor(private input: ReservationPendingStateInput) {}

  setInput(input: ReservationPendingStateInput): void {
    this.input = input;
  }

  async getReservationPendingInput(): Promise<ReservationPendingStateInput> {
    return structuredClone(this.input);
  }
}

export class InMemoryCredentialItemsPort implements CredentialItemsPort {
  constructor(private items: ProvisionedCredentialItem[]) {}

  setItems(items: ProvisionedCredentialItem[]): void {
    this.items = items;
  }

  async listProvisionedItemsByCredentialId(
    credentialId: string,
  ): Promise<ProvisionedCredentialItem[]> {
    return this.items.filter((i) => i.credential_id === credentialId).map((i) => ({ ...i }));
  }
}

export class InMemoryCommunicationOutbox implements CommunicationOutboxPort {
  constructor(
    private readonly state: MemoryState,
    private readonly options?: { failOnWelcome?: boolean },
  ) {}

  async enqueueGuestWelcomeMessage(
    message: Extract<OutboxMessage, { kind: "guest_welcome_pending" }>,
  ): Promise<void> {
    if (this.options?.failOnWelcome) {
      throw new Error("Falha simulada na outbox de boas-vindas.");
    }
    if (this.state.outbox.some((m) => m.idempotency_key === message.idempotency_key)) {
      return;
    }
    this.state.outbox.push({ ...message });
  }

  async enqueueGuestRestoredMessage(
    message: Extract<OutboxMessage, { kind: "guest_access_restored" }>,
  ): Promise<void> {
    if (this.state.outbox.some((m) => m.idempotency_key === message.idempotency_key)) {
      return;
    }
    this.state.outbox.push({ ...message });
  }

  async enqueueInternalAlert(
    message: Extract<OutboxMessage, { kind: "internal_alert" }>,
  ): Promise<void> {
    this.state.outbox.push({ ...message });
  }
}

export type FirstRoomAccessMemoryHarness = {
  state: MemoryState;
  ports: FirstRoomAccessPorts;
  clock: FixedClock;
  pendingPort: InMemoryReservationPendingStatePort;
  itemsPort: InMemoryCredentialItemsPort;
  outbox: InMemoryCommunicationOutbox;
};

export function createFirstRoomAccessMemoryHarness(seed: {
  correlation: CorrelatedRoomAccessResult;
  pending: ReservationPendingStateInput;
  items: ProvisionedCredentialItem[];
  now?: Date;
  failOnWelcome?: boolean;
}): FirstRoomAccessMemoryHarness {
  const state: MemoryState = {
    events: [],
    tolerances: [],
    toleranceItems: [],
    outbox: [],
  };
  const clock = new FixedClock(seed.now ?? new Date("2026-08-08T18:05:00.000Z"));
  const pendingPort = new InMemoryReservationPendingStatePort(seed.pending);
  const itemsPort = new InMemoryCredentialItemsPort(seed.items);
  const outbox = new InMemoryCommunicationOutbox(state, {
    failOnWelcome: seed.failOnWelcome,
  });

  const ports: FirstRoomAccessPorts = {
    events: new InMemoryAccessEventRepository(state),
    correlation: new InMemoryCredentialCorrelationPort(seed.correlation),
    pending: pendingPort,
    tolerances: new InMemoryAccessToleranceRepository(state),
    items: itemsPort,
    outbox,
    clock,
    uow: new InMemoryUnitOfWork(
      () => ({
        events: state.events.map((e) => ({ ...e })),
        tolerances: state.tolerances.map((t) => ({ ...t, pending_snapshot: [...t.pending_snapshot] })),
        toleranceItems: state.toleranceItems.map((i) => ({ ...i })),
        outbox: state.outbox.map((m) => ({ ...m })),
      }),
      (s) => {
        state.events.splice(0, state.events.length, ...s.events);
        state.tolerances.splice(0, state.tolerances.length, ...s.tolerances);
        state.toleranceItems.splice(0, state.toleranceItems.length, ...s.toleranceItems);
        state.outbox.splice(0, state.outbox.length, ...s.outbox);
      },
    ),
  };

  return { state, ports, clock, pendingPort, itemsPort, outbox };
}
