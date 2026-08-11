import type { SupabaseClient } from "@supabase/supabase-js";
import type { CredentialItemsPort } from "../../../application/yes-hotel/first-room-access-ports.ts";
import type { ProvisionedCredentialItem } from "../../../application/yes-hotel/first-room-access-types.ts";
import { classifyLogicalDestination } from "../../../integrations/ttlock/access-ingest/lock-type.ts";
import type { LockLogicalType } from "../../../domain/yes-hotel/first-room-access-policy.ts";

export class SupabaseCredentialItemsPort implements CredentialItemsPort {
  constructor(private readonly client: SupabaseClient) {}

  async listProvisionedItemsByCredentialId(
    credentialId: string,
  ): Promise<ProvisionedCredentialItem[]> {
    const { data, error } = await this.client
      .from("operacional_credencial_itens")
      .select(
        "id, credencial_id, codigo_logico_destino, lock_id_ttlock, remote_keyboard_pwd_id, status_provisionamento",
      )
      .eq("credencial_id", credentialId)
      .eq("status_provisionamento", "provisionado");
    if (error) throw new Error(`listProvisionedItems: ${error.message}`);

    return (data ?? [])
      .map((row) => {
        const dest = String(row.codigo_logico_destino ?? "");
        const lockType = classifyLogicalDestination(dest);
        if (lockType === "other") return null;
        if (row.remote_keyboard_pwd_id == null) {
          // Mantém no array com NaN? Orquestrador valida e falha — devolve com 0 e deixa validateThreeTargets.
          // Melhor devolver e deixar orquestrador acusar "Item sem remote_keyboard_pwd_id".
        }
        return {
          id: row.id as string,
          credential_id: row.credencial_id as string,
          logical_destination: dest,
          lock_type: lockType as LockLogicalType,
          lock_id: Number(row.lock_id_ttlock),
          remote_keyboard_pwd_id: Number(row.remote_keyboard_pwd_id),
        } satisfies ProvisionedCredentialItem;
      })
      .filter((x): x is ProvisionedCredentialItem => x != null);
  }
}
