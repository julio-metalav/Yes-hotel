/**
 * Implementação do repositório de provisionamento usando Supabase.
 * Usado por scripts e, no futuro, por backend para processar credenciais.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CredencialItemRow,
  CredencialRow,
  NovoItemDestino,
  ProvisioningRepository,
  SyncStatus,
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
  revogado_em?: string | null;
  motivo_revogacao?: string | null;
  sync_status?: string | null;
  last_sync_attempt_at?: string | null;
  last_sync_error?: string | null;
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
  revogado_em?: string | null;
  remote_keyboard_pwd_id: number | null;
  codigo_enviado: string | null;
}

function normalizeApartmentNum(ap: string): string {
  const n = parseInt(ap.trim().replace(/\D/g, ""), 10);
  if (Number.isNaN(n) || n < 1 || n > 40) return "";
  return String(n).padStart(2, "0");
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
    revogado_em: r.revogado_em ?? null,
    motivo_revogacao: r.motivo_revogacao ?? null,
    sync_status: (r.sync_status as SyncStatus | null) ?? null,
    last_sync_attempt_at: r.last_sync_attempt_at ?? null,
    last_sync_error: r.last_sync_error ?? null,
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
    revogado_em: r.revogado_em ?? null,
    remote_keyboard_pwd_id: r.remote_keyboard_pwd_id,
    codigo_enviado: r.codigo_enviado,
  };
}

const COLS_CREDENCIAL =
  "id, reserva_id, status, valido_de, valido_ate, codigo_credencial, provider_tipo, revogado_em, motivo_revogacao, sync_status, last_sync_attempt_at, last_sync_error";
const COLS_ITEM =
  "id, credencial_id, fechadura_id, lock_id_ttlock, tipo_destino, codigo_logico_destino, status_provisionamento, ultimo_erro, provisionado_em, revogado_em, remote_keyboard_pwd_id, codigo_enviado";

export function createSupabaseProvisioningRepository(
  supabase: SupabaseClient,
): ProvisioningRepository {
  return {
    async getCredencial(id: string): Promise<CredencialRow | null> {
      const { data, error } = await supabase
        .from("operacional_credenciais_acesso")
        .select(COLS_CREDENCIAL)
        .eq("id", id)
        .single();
      if (error || !data) return null;
      return toCredencialRow(data as DbCredencial);
    },

    async getCredencialPorReserva(reservaId: string): Promise<CredencialRow | null> {
      const { data, error } = await supabase
        .from("operacional_credenciais_acesso")
        .select(COLS_CREDENCIAL)
        .eq("reserva_id", reservaId)
        .eq("tipo_credencial", "principal")
        .maybeSingle();
      if (error) throw new Error(`getCredencialPorReserva: ${error.message}`);
      return data ? toCredencialRow(data as DbCredencial) : null;
    },

    async getCredenciaisPendentes(): Promise<CredencialRow[]> {
      const { data, error } = await supabase
        .from("operacional_credenciais_acesso")
        .select(COLS_CREDENCIAL)
        .eq("status", "pendente")
        .order("created_at", { ascending: true });
      if (error) throw new Error(`getCredenciaisPendentes: ${error.message}`);
      return (data ?? []).map((r) => toCredencialRow(r as DbCredencial));
    },

    async getItens(credencialId: string): Promise<CredencialItemRow[]> {
      const { data, error } = await supabase
        .from("operacional_credencial_itens")
        .select(COLS_ITEM)
        .eq("credencial_id", credencialId);
      if (error) throw new Error(`getItens: ${error.message}`);
      return (data ?? []).map((r) => toItemRow(r as DbItem));
    },

    async getItensPendentes(credencialId: string): Promise<CredencialItemRow[]> {
      const { data, error } = await supabase
        .from("operacional_credencial_itens")
        .select(COLS_ITEM)
        .eq("credencial_id", credencialId)
        .eq("status_provisionamento", "pendente");
      if (error) throw new Error(`getItensPendentes: ${error.message}`);
      return (data ?? []).map((r) => toItemRow(r as DbItem));
    },

    async getItensProvisionados(credencialId: string): Promise<CredencialItemRow[]> {
      const { data, error } = await supabase
        .from("operacional_credencial_itens")
        .select(COLS_ITEM)
        .eq("credencial_id", credencialId)
        .eq("status_provisionamento", "provisionado")
        .not("remote_keyboard_pwd_id", "is", null);
      if (error) throw new Error(`getItensProvisionados: ${error.message}`);
      return (data ?? []).map((r) => toItemRow(r as DbItem));
    },

    async getItensPendentesLimpeza(credencialId: string): Promise<CredencialItemRow[]> {
      const { data, error } = await supabase
        .from("operacional_credencial_itens")
        .select(COLS_ITEM)
        .eq("credencial_id", credencialId)
        .eq("status_provisionamento", "pendente_limpeza")
        .not("remote_keyboard_pwd_id", "is", null);
      if (error) throw new Error(`getItensPendentesLimpeza: ${error.message}`);
      return (data ?? []).map((r) => toItemRow(r as DbItem));
    },

    async insertItem(credencialId: string, destino: NovoItemDestino): Promise<CredencialItemRow> {
      const { data, error } = await supabase
        .from("operacional_credencial_itens")
        .insert({
          credencial_id: credencialId,
          fechadura_id: destino.fechadura_id,
          lock_id_ttlock: destino.lock_id_ttlock,
          tipo_destino: destino.tipo_destino,
          codigo_logico_destino: destino.codigo_logico_destino,
          status_provisionamento: "pendente",
        })
        .select(COLS_ITEM)
        .single();
      if (error) throw new Error(`insertItem: ${error.message}`);
      return toItemRow(data as DbItem);
    },

    async updateCredencial(
      id: string,
      patch: Partial<
        Pick<
          CredencialRow,
          | "status"
          | "codigo_credencial"
          | "provider_tipo"
          | "valido_de"
          | "valido_ate"
          | "revogado_em"
          | "motivo_revogacao"
          | "sync_status"
          | "last_sync_attempt_at"
          | "last_sync_error"
        >
      >,
    ): Promise<void> {
      const { error } = await supabase
        .from("operacional_credenciais_acesso")
        .update(patch)
        .eq("id", id);
      if (error) throw new Error(`updateCredencial: ${error.message}`);
    },

    async getCredenciaisComPendenciaSync(): Promise<CredencialRow[]> {
      const { data, error } = await supabase
        .from("operacional_credenciais_acesso")
        .select(COLS_CREDENCIAL)
        .in("sync_status", ["pending", "partial", "failed"])
        .order("last_sync_attempt_at", { ascending: true, nullsFirst: true });
      if (error) throw new Error(`getCredenciaisComPendenciaSync: ${error.message}`);
      return (data ?? []).map((r) => toCredencialRow(r as DbCredencial));
    },

    async updateItem(
      id: string,
      patch: Partial<{
        status_provisionamento: OperacionalItemProvisionamentoStatus;
        ultimo_erro: string | null;
        provisionado_em: string | null;
        revogado_em: string | null;
        remote_keyboard_pwd_id: number | null;
        codigo_enviado: string | null;
      }>,
    ): Promise<void> {
      const { error } = await supabase.from("operacional_credencial_itens").update(patch).eq("id", id);
      if (error) throw new Error(`updateItem: ${error.message}`);
    },

    async getReservaApartment(reservaId: string): Promise<string | null> {
      const { data, error } = await supabase
        .from("operacional_reservas")
        .select("apartamento")
        .eq("id", reservaId)
        .single();
      if (error || !data?.apartamento) return null;
      const normalized = normalizeApartmentNum(String(data.apartamento));
      return normalized || null;
    },

    async getFechadurasForApartment(apartmentCode: string): Promise<NovoItemDestino[]> {
      const num = normalizeApartmentNum(apartmentCode);
      if (!num) return [];

      const { data: apt, error: aptErr } = await supabase
        .from("apartamentos")
        .select("id, bloco_id")
        .eq("numero", num)
        .single();
      if (aptErr || !apt) return [];

      const { data: fechadurasApt, error: errApt } = await supabase
        .from("fechaduras")
        .select("id, identificador_externo_ttlock, tipo_fechadura")
        .eq("apartamento_id", apt.id)
        .eq("ativo", true);
      if (errApt) throw new Error(`getFechadurasForApartment(apt): ${errApt.message}`);

      const { data: portoes, error: errPortoes } = await supabase
        .from("portoes")
        .select("id, identificador_operacional")
        .eq("bloco_id", apt.bloco_id);
      if (errPortoes) throw new Error(`getFechadurasForApartment(portoes): ${errPortoes.message}`);

      const portaoIds = (portoes ?? []).map((p: { id: string }) => p.id);
      const portaoById = new Map((portoes ?? []).map((p: { id: string; identificador_operacional: string }) => [p.id, p.identificador_operacional]));

      const { data: fechadurasPortao, error: errPortao } = await supabase
        .from("fechaduras")
        .select("id, identificador_externo_ttlock, tipo_fechadura, portao_id")
        .in("portao_id", portaoIds)
        .eq("ativo", true);
      if (errPortao) throw new Error(`getFechadurasForApartment(portao): ${errPortao.message}`);

      const result: NovoItemDestino[] = [];

      for (const f of fechadurasApt ?? []) {
        result.push({
          fechadura_id: f.id,
          lock_id_ttlock: f.identificador_externo_ttlock,
          tipo_destino: f.tipo_fechadura,
          codigo_logico_destino: `APT-${num}`,
        });
      }
      for (const f of fechadurasPortao ?? []) {
        const gateCode = portaoById.get(f.portao_id) ?? "";
        const suffix = f.tipo_fechadura === "portao_externo" ? "EXTERNAL" : "INTERNAL";
        result.push({
          fechadura_id: f.id,
          lock_id_ttlock: f.identificador_externo_ttlock,
          tipo_destino: f.tipo_fechadura,
          codigo_logico_destino: `GATE-${gateCode}-${suffix}`,
        });
      }

      return result;
    },
  };
}
