import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccessToleranceRepository } from "../../../application/yes-hotel/first-room-access-ports";
import type {
  AccessGraceStatusPersisted,
  AccessToleranceRecord,
  CreateToleranceInput,
} from "../../../application/yes-hotel/first-room-access-types";

type TolRow = {
  id: string;
  reservation_id: string;
  credential_id: string;
  first_room_access_at: string;
  grace_started_at: string;
  suspension_due_at: string;
  grace_status: AccessGraceStatusPersisted;
  pending_payment_at_start: boolean;
  pending_fnrh_at_start: boolean;
  current_payment_pending: boolean;
  current_fnrh_pending: boolean;
  pending_snapshot: string[] | unknown;
  original_valid_from: string;
  original_valid_until: string;
  suspended_at: string | null;
  restored_at: string | null;
  welcome_message_event_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

function mapTol(row: TolRow): AccessToleranceRecord {
  const snap = Array.isArray(row.pending_snapshot)
    ? (row.pending_snapshot as string[])
    : typeof row.pending_snapshot === "string"
      ? (JSON.parse(row.pending_snapshot) as string[])
      : [];
  return { ...row, pending_snapshot: snap };
}

/**
 * createTolerance usa RPC transacional `yes_hotel_create_access_tolerance`
 * (migration 0023, versionada, não aplicada neste PR).
 * Sem a RPC, inserts multi-tabela via client NÃO são atômicos — por isso
 * não há fallback de "duas inserts independentes" em produção.
 */
export class SupabaseAccessToleranceRepository implements AccessToleranceRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findByCredentialId(credentialId: string): Promise<AccessToleranceRecord | null> {
    const { data, error } = await this.client
      .from("operacional_acesso_tolerancias")
      .select("*")
      .eq("credential_id", credentialId)
      .maybeSingle();
    if (error) throw new Error(`findByCredentialId: ${error.message}`);
    return data ? mapTol(data as TolRow) : null;
  }

  async createTolerance(input: CreateToleranceInput): Promise<AccessToleranceRecord> {
    if (input.items.length !== 3) {
      throw new Error("Tolerância exige exatamente 3 itens.");
    }
    const { data, error } = await this.client.rpc("yes_hotel_create_access_tolerance", {
      p_reservation_id: input.reservation_id,
      p_credential_id: input.credential_id,
      p_first_room_access_at: input.first_room_access_at,
      p_grace_started_at: input.grace_started_at,
      p_suspension_due_at: input.suspension_due_at,
      p_pending_payment_at_start: input.pending_payment_at_start,
      p_pending_fnrh_at_start: input.pending_fnrh_at_start,
      p_pending_snapshot: input.pending_snapshot,
      p_original_valid_from: input.original_valid_from,
      p_original_valid_until: input.original_valid_until,
      p_welcome_message_event_id: input.welcome_message_event_id,
      p_items: input.items.map((i) => ({
        credential_item_id: i.credential_item_id,
        logical_destination: i.logical_destination,
        lock_id: i.lock_id,
        remote_keyboard_pwd_id: i.remote_keyboard_pwd_id,
      })),
    });
    if (error) {
      throw new Error(
        `createTolerance RPC: ${error.message}. ` +
          "Requer migration 0023 (yes_hotel_create_access_tolerance) aplicada. " +
          "Não há fallback multi-insert não-atômico.",
      );
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error("createTolerance RPC não retornou linha.");
    return mapTol(row as TolRow);
  }

  private async setStatus(
    toleranceId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const { error } = await this.client
      .from("operacional_acesso_tolerancias")
      .update(patch)
      .eq("id", toleranceId);
    if (error) throw new Error(`updateTolerance: ${error.message}`);
  }

  async updateCurrentPendingState(
    toleranceId: string,
    state: {
      current_payment_pending: boolean;
      current_fnrh_pending: boolean;
      updated_at: string;
    },
  ): Promise<void> {
    await this.setStatus(toleranceId, state);
  }

  async markCancelled(toleranceId: string, updatedAt: string): Promise<void> {
    await this.setStatus(toleranceId, { grace_status: "cancelled", updated_at: updatedAt });
  }
  async markSuspensionPending(toleranceId: string, updatedAt: string): Promise<void> {
    await this.setStatus(toleranceId, {
      grace_status: "suspension_pending",
      updated_at: updatedAt,
    });
  }
  async markSuspended(toleranceId: string, suspendedAt: string): Promise<void> {
    await this.setStatus(toleranceId, {
      grace_status: "suspended",
      suspended_at: suspendedAt,
      updated_at: suspendedAt,
    });
  }
  async markPartialFailure(toleranceId: string, error: string, updatedAt: string): Promise<void> {
    await this.setStatus(toleranceId, {
      grace_status: "partial_failure",
      last_error: error,
      updated_at: updatedAt,
    });
  }
  async markRestorePending(toleranceId: string, updatedAt: string): Promise<void> {
    await this.setStatus(toleranceId, { grace_status: "restore_pending", updated_at: updatedAt });
  }
  async markRestored(toleranceId: string, restoredAt: string): Promise<void> {
    await this.setStatus(toleranceId, {
      grace_status: "restored",
      restored_at: restoredAt,
      updated_at: restoredAt,
    });
  }
  async markError(toleranceId: string, error: string, updatedAt: string): Promise<void> {
    await this.setStatus(toleranceId, {
      grace_status: "error",
      last_error: error,
      updated_at: updatedAt,
    });
  }
}
