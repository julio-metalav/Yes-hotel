/**
 * Reconciliação de apartamento de uma reserva HITS já materializada.
 *
 * Não fala com o TTLock. Se a credencial principal existe, delega ao
 * lifecycle (`aplicarTroca`), que é quem chama `handleRoomChange`.
 * O apartamento local só muda aqui quando não há credencial — nesse caso
 * não existe fechadura a revogar.
 */

import { decidirTrocaApartamento } from "../../domain/yes-hotel/hits-room-change.ts";
import type { SyncedReservation } from "../../domain/yes-hotel/synced-reservation.ts";
import { ORIGEM_HITS, type SupabaseAdminLike } from "./hits-materializar.ts";

export type AplicarTrocaApartamento = (input: {
  reservaId: string;
  novoApartamento: string;
}) => Promise<{ ok: boolean; motivo?: string }>;

export type TrocaApartamentoResultado = {
  ok: boolean;
  acao: "noop" | "apartamento" | "lifecycle" | "pendente";
  motivo: string;
};

export async function reconciliarTrocaApartamentoHits(input: {
  admin: SupabaseAdminLike;
  externalId: string;
  synced: SyncedReservation;
  aplicarTroca?: AplicarTrocaApartamento;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}): Promise<TrocaApartamentoResultado> {
  const { admin, externalId, synced } = input;
  const log = input.log ?? (() => {});

  const { data, error } = await admin
    .from("operacional_reservas")
    .select("id, apartamento")
    .eq("origem_externa", ORIGEM_HITS)
    .eq("external_reservation_id", externalId)
    .maybeSingle();
  if (error) {
    log("[HITS_ROOM_CHANGE] leitura da reserva falhou", { code: error.code });
    return { ok: false, acao: "pendente", motivo: "leitura_reserva" };
  }
  const reserva = data as { id?: string; apartamento?: string | null } | null;
  if (!reserva?.id) return { ok: true, acao: "noop", motivo: "reserva_nao_materializada" };

  const decisao = decidirTrocaApartamento({
    apartamentoLocal: reserva.apartamento,
    apartamentoHits: synced.apartmentCode,
  });
  if (decisao.acao === "noop") return { ok: true, acao: "noop", motivo: "sem_mudanca" };

  const { data: cred, error: credErro } = await admin
    .from("operacional_credenciais_acesso")
    .select("id, status")
    .eq("reserva_id", reserva.id)
    .eq("tipo_credencial", "principal")
    .maybeSingle();
  if (credErro) {
    log("[HITS_ROOM_CHANGE] leitura da credencial falhou", { code: credErro.code });
    return { ok: false, acao: "pendente", motivo: "leitura_credencial" };
  }

  if (cred && (cred as { id?: string }).id) {
    if (!input.aplicarTroca) {
      return { ok: false, acao: "pendente", motivo: "lifecycle_nao_configurado" };
    }
    const aplicado = await input.aplicarTroca({
      reservaId: reserva.id,
      novoApartamento: decisao.para,
    });
    if (!aplicado.ok) {
      return { ok: false, acao: "pendente", motivo: aplicado.motivo || "lifecycle_falhou" };
    }
    return { ok: true, acao: "lifecycle", motivo: aplicado.motivo || "reconciliada" };
  }

  const { data: upd, error: updErro } = await admin
    .from("operacional_reservas")
    .update({ apartamento: decisao.para, updated_at: new Date().toISOString() })
    .eq("id", reserva.id)
    .eq("apartamento", reserva.apartamento ?? "")
    .select("id");
  if (updErro || !Array.isArray(upd) || upd.length !== 1) {
    log("[HITS_ROOM_CHANGE] apartamento sem credencial não atualizado", { code: updErro?.code });
    return { ok: false, acao: "pendente", motivo: "apartamento_nao_atualizado" };
  }
  return { ok: true, acao: "apartamento", motivo: "sem_credencial" };
}
