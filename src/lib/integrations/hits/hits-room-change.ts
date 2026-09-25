/**
 * Reconciliação HITS -> Yes para mudança de apartamento.
 *
 * Só DETECTA divergências entre a reserva operacional e o detalhe HITS já lido
 * no ciclo. O efeito TTLock é injetado pela Edge de snapshot; este módulo não
 * faz rede, não envia mensagem e não escreve no banco.
 */
import { normalizeApartmentCode } from "../../domain/yes-hotel/hotel-layout.ts";
import type { SyncedReservation } from "../../domain/yes-hotel/synced-reservation.ts";
import { ORIGEM_HITS, type SupabaseAdminLike } from "./hits-materializar.ts";

export type MudancaApartamentoHits = {
  reserva_id: string;
  external_reservation_id: string;
  apartamento_anterior: string;
  apartamento_novo: string;
};

export type DeteccaoMudancaApartamentoResultado = {
  avaliadas: number;
  mudancas: MudancaApartamentoHits[];
  invalidas: number;
  erro: string | null;
};

function normalizarSeguro(value: unknown): string | null {
  const s = String(value ?? "").trim();
  if (!s) return null;
  try {
    return normalizeApartmentCode(s);
  } catch {
    return null;
  }
}

export async function detectarMudancasApartamentoNoCiclo(input: {
  admin: SupabaseAdminLike;
  rows: ReadonlyArray<{ external_reservation_id: string; status_reserva: string }>;
  detalhes: ReadonlyMap<string, SyncedReservation>;
}): Promise<DeteccaoMudancaApartamentoResultado> {
  const ids = [
    ...new Set(
      input.rows
        .filter((r) => r.status_reserva !== "cancelada")
        .map((r) => String(r.external_reservation_id ?? "").trim())
        .filter((id) => id && input.detalhes.has(id)),
    ),
  ];
  if (ids.length === 0) {
    return { avaliadas: 0, mudancas: [], invalidas: 0, erro: null };
  }

  const { data, error } = await input.admin
    .from("operacional_reservas")
    .select("id, external_reservation_id, apartamento")
    .eq("origem_externa", ORIGEM_HITS)
    .in("external_reservation_id", ids);

  if (error) {
    return {
      avaliadas: 0,
      mudancas: [],
      invalidas: 0,
      erro: String(error.code ?? "select_operacional_reservas"),
    };
  }

  const mudancas: MudancaApartamentoHits[] = [];
  let invalidas = 0;
  for (const row of (data ?? []) as Array<{
    id: string;
    external_reservation_id: string;
    apartamento?: string | null;
  }>) {
    const externalId = String(row.external_reservation_id ?? "").trim();
    const synced = input.detalhes.get(externalId);
    if (!synced) continue;

    const anterior = normalizarSeguro(row.apartamento);
    const novo = normalizarSeguro(synced.apartmentCode);
    if (!anterior || !novo) {
      invalidas++;
      continue;
    }
    if (anterior === novo) continue;

    mudancas.push({
      reserva_id: String(row.id),
      external_reservation_id: externalId,
      apartamento_anterior: anterior,
      apartamento_novo: novo,
    });
  }

  return {
    avaliadas: Array.isArray(data) ? data.length : 0,
    mudancas,
    invalidas,
    erro: null,
  };
}
