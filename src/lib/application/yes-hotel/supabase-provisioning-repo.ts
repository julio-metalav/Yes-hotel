/**
 * Implementação do repositório de provisionamento usando Supabase.
 * Usado por scripts e, no futuro, por backend para processar credenciais.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CredencialItemRow,
  CredencialRow,
  ProvisioningRepository,
} from "./provisioning-executor";
import type {
  OperacionalCredencialStatus,
  OperacionalItemProvisionamentoStatus,
} from "./types";

interface DbCredencial {
  id: string;
  reserva_id: string;
  status: OperacionalCredencialStatus;
  valido_de: string;
  valido_ate: string;
  codigo_credencial: string | null;
  provider_tipo: string | null;
}

interface DbItem {
  id: string;
  credencial_id: string;
  fechadura_id: string;
  lock_id_ttlock: string;
  tipo_destino: string;
  codigo_logico_destino: string;
  status_provisionamento: OperacionalItemProvisionamentoStatus;
  ultimo_erro: string | null;
  provisionado_em: string | null;
  remote_keyboard_pwd_id: number | null;
  codigo_enviado: string | null;
}

function toCredencialRow(r: DbCredencial): CredencialRow {
  return {
    id: r.id,
    reserva_id: r.reserva_id,
    status: r.status,
    valido_de: r.valido_de,
    valido_ate: r.valido_ate,
    codigo_credencial: r.codigo_credencial,
    provider_tipo: r.provider_tipo,
  };
}

function toItemRow(r: DbItem): CredencialItemRow {
  return {
    id: r.id,
    credencial_id: r.credencial_id,
    fechadura_id: r.fechadura_id,
    lock_id_ttlock: r.lock_id_ttlock,
    tipo_destino: r.tipo_destino,
    codigo_logico_destino: r.codigo_logico_destino,
    status_provisionamento: r.status_provisionamento,
    ultimo_erro: r.ultimo_erro,
    provisionado_em: r.provisionado_em,
    remote_keyboard_pwd_id: r.remote_keyboard_pwd_id,
    codigo_enviado: r.codigo_enviado,
  };
}

export function createSupabaseProvisioningRepository(
  supabase: SupabaseClient,
): ProvisioningRepository {
  return {
    async getCredencial(id: string): Promise<CredencialRow | null> {
      const { data, error } = await supabase
        .from("operacional_credenciais_acesso")
        .select("id, reserva_id, status, valido_de, valido_ate, codigo_credencial, provider_tipo")
        .eq("id", id)
        .single();
      if (error || !data) return null;
      return toCredencialRow(data as DbCredencial);
    },

    async getCredenciaisPendentes(): Promise<CredencialRow[]> {
      const { data, error } = await supabase
        .from("operacional_credenciais_acesso")
        .select("id, reserva_id, status, valido_de, valido_ate, codigo_credencial, provider_tipo")
        .eq("status", "pendente")
        .order("created_at", { ascending: true });
      if (error) throw new Error(`getCredenciaisPendentes: ${error.message}`);
      return (data ?? []).map((r) => toCredencialRow(r as DbCredencial));
    },

    async getItensPendentes(credencialId: string): Promise<CredencialItemRow[]> {
      const { data, error } = await supabase
        .from("operacional_credencial_itens")
        .select(
          "id, credencial_id, fechadura_id, lock_id_ttlock, tipo_destino, codigo_logico_destino, status_provisionamento, ultimo_erro, provisionado_em, remote_keyboard_pwd_id, codigo_enviado",
        )
        .eq("credencial_id", credencialId)
        .eq("status_provisionamento", "pendente");
      if (error) throw new Error(`getItensPendentes: ${error.message}`);
      return (data ?? []).map((r) => toItemRow(r as DbItem));
    },

    async updateCredencial(id: string, patch: Partial<Pick<CredencialRow, "status" | "codigo_credencial" | "provider_tipo">>): Promise<void> {
      const { error } = await supabase
        .from("operacional_credenciais_acesso")
        .update(patch)
        .eq("id", id);
      if (error) throw new Error(`updateCredencial: ${error.message}`);
    },

    async updateItem(
      id: string,
      patch: Partial<{
        status_provisionamento: OperacionalItemProvisionamentoStatus;
        ultimo_erro: string | null;
        provisionado_em: string | null;
        remote_keyboard_pwd_id: number | null;
        codigo_enviado: string | null;
      }>,
    ): Promise<void> {
      const { error } = await supabase.from("operacional_credencial_itens").update(patch).eq("id", id);
      if (error) throw new Error(`updateItem: ${error.message}`);
    },
  };
}
