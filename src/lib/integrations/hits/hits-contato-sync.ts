/**
 * Ciclo HITS → Yes: materialização de reservas novas + reconciliação de contato
 * das já materializadas, com **enriquecimento direcionado** pelo guest master.
 *
 * Por que existe: o celular oficial (`contactCellPhone`) só aparece em
 * `GuestRevenueDto` (GET /v1/guests?EntityId=…), nunca no detalhe da reserva.
 * Consultar o guest master de TODO hóspede de TODA reserva a cada 10 minutos
 * seria um N+1 sobre o universo inteiro. Aqui a consulta é decidida antes:
 *
 *   A. reserva NOVA que será materializada agora → hóspedes com idEntity;
 *   B. hóspede já materializado que PODE melhorar → WhatsApp vazio, WhatsApp
 *      que não é celular (candidato a virar celular oficial) ou e-mail vazio,
 *      e apenas enquanto a ficha FNRH dele continuar intocada.
 *
 * Quem já tem celular + e-mail, ou já preencheu a FNRH, não gera consulta
 * nenhuma. Os ids são deduplicados e cortados por um teto conservador por
 * ciclo; a leitura em si é sequencial e cadenciada (quem faz é o leitor).
 *
 * Este módulo não faz rede: recebe `buscarGuestRevenues` injetado. Não envia
 * nada, não escreve no HITS.
 */

import type { SyncedReservation } from "../../domain/yes-hotel/synced-reservation.ts";
import type { HitsGuestRevenue } from "./types.ts";
import { aplicarContatoOficialNaReserva, precisaGuestMaster } from "./hits-contato.ts";
import {
  materializarReservaSincronizada,
  reconciliarContatosDaReserva,
  reconciliarPlanoRefeicaoDaReserva,
  ORIGEM_HITS,
  type SupabaseAdminLike,
} from "./hits-materializar.ts";

/** Teto de materializações por ciclo (comportamento anterior preservado). */
export const HITS_AUTO_MATERIALIZAR_MAX_POR_CICLO = 20;

/** Teto de reservas já locais reconciliadas por ciclo. */
export const HITS_RECONCILIAR_CONTATO_MAX_POR_CICLO = 20;

const FNRH_LIFECYCLE_INTOCADA = new Set<string>(["", "pending", "link_sent"]);

type LocalHospede = {
  id: string;
  reserva_id: string;
  pms_external_guest_id?: string | null;
  whatsapp?: string | null;
  email?: string | null;
};

export type PlanoContato = {
  /** Externos ativos deste ciclo ainda sem linha em operacional_reservas. */
  novas: string[];
  /** Externos ativos deste ciclo que JÁ têm linha local (plano é reconciliado). */
  ja_locais: string[];
  /** Externos já locais com pelo menos um hóspede que pode melhorar. */
  existentes: string[];
  /** idEntity a consultar no guest master, sem repetição, já cortado pelo teto. */
  entity_ids: string[];
  /** idEntity elegíveis que não couberam no teto deste ciclo. */
  entity_ids_ignorados: number;
  erro: string | null;
};

export type BuscarGuestRevenues = (
  entityIds: string[],
) => Promise<{
  porEntityId: Map<string, HitsGuestRevenue>;
  lidos: number;
  falhas: number;
  ignorados_teto: number;
  parou_por: string;
}>;

function idsAtivosComDetalhe(
  rows: ReadonlyArray<{ external_reservation_id: string; status_reserva: string }>,
  detalhes: ReadonlyMap<string, SyncedReservation>,
): string[] {
  return rows
    .filter((r) => r.status_reserva !== "cancelada")
    .map((r) => String(r.external_reservation_id || "").trim())
    .filter((id) => id && detalhes.has(id));
}

/**
 * Decide o menor conjunto de idEntity que precisa do guest master neste ciclo.
 * Reservas novas primeiro (nascem agora e não podem nascer com o fixo), depois
 * os hóspedes já locais que podem melhorar.
 */
export async function planejarEnriquecimentoContato(input: {
  admin: SupabaseAdminLike;
  rows: ReadonlyArray<{ external_reservation_id: string; status_reserva: string }>;
  detalhes: ReadonlyMap<string, SyncedReservation>;
  maxLookups: number;
}): Promise<PlanoContato> {
  const { admin, detalhes } = input;
  const vazio: PlanoContato = {
    novas: [],
    ja_locais: [],
    existentes: [],
    entity_ids: [],
    entity_ids_ignorados: 0,
    erro: null,
  };
  const ids = idsAtivosComDetalhe(input.rows, detalhes);
  if (ids.length === 0) return vazio;

  const { data: reservasLocais, error } = await admin
    .from("operacional_reservas")
    .select("id, external_reservation_id")
    .eq("origem_externa", ORIGEM_HITS)
    .in("external_reservation_id", ids);
  if (error) return { ...vazio, erro: String(error.code ?? "select_reservas") };

  const locais = (reservasLocais ?? []) as Array<{ id: string; external_reservation_id: string }>;
  const externoPorReservaId = new Map<string, string>();
  const jaLocal = new Set<string>();
  for (const r of locais) {
    const ext = String(r.external_reservation_id ?? "").trim();
    if (!ext) continue;
    jaLocal.add(ext);
    externoPorReservaId.set(String(r.id), ext);
  }

  const novas = ids.filter((id) => !jaLocal.has(id));
  const jaLocais = ids.filter((id) => jaLocal.has(id));
  const entityIdsNovas: string[] = [];
  for (const id of novas) {
    for (const g of detalhes.get(id)?.guests ?? []) {
      const idEntity = String(g.externalGuestId ?? "").trim();
      if (idEntity) entityIdsNovas.push(idEntity);
    }
  }

  // Hóspedes das reservas já locais: uma consulta só, e só as linhas vinculadas
  // ao HITS (sem pms_external_guest_id não há guest master a consultar).
  const entityIdsExistentes: string[] = [];
  const existentes = new Set<string>();
  const reservaIds = [...externoPorReservaId.keys()];
  if (reservaIds.length > 0) {
    const { data: hospedesLocais } = await admin
      .from("operacional_hospedes")
      .select("id, reserva_id, pms_external_guest_id, whatsapp, email")
      .in("reserva_id", reservaIds)
      .or("removed_from_reservation.is.null,removed_from_reservation.eq.false");
    const linhas = ((hospedesLocais ?? []) as LocalHospede[]).filter((h) =>
      String(h.pms_external_guest_id ?? "").trim(),
    );

    // Candidatos por estado do contato ANTES de olhar a ficha: só quem pode
    // melhorar chega a custar a leitura de fnrh_hospedes.
    const candidatos = linhas.filter((h) => precisaGuestMaster(h));
    let fichasTocadas = new Set<string>();
    if (candidatos.length > 0) {
      const { data: fichas } = await admin
        .from("fnrh_hospedes")
        .select("hospede_id, status, fnrh_lifecycle_status")
        .in("hospede_id", candidatos.map((h) => h.id));
      fichasTocadas = new Set(
        ((fichas ?? []) as Array<{
          hospede_id: string;
          status?: string | null;
          fnrh_lifecycle_status?: string | null;
        }>)
          .filter(
            (f) =>
              String(f.status ?? "pendente") !== "pendente" ||
              !FNRH_LIFECYCLE_INTOCADA.has(String(f.fnrh_lifecycle_status ?? "")),
          )
          .map((f) => String(f.hospede_id)),
      );
    }

    for (const h of candidatos) {
      // Ficha preenchida/confirmada: o contato do hóspede prevalece e nada
      // seria gravado — consultar o HITS por ele seria desperdício.
      if (fichasTocadas.has(h.id)) continue;
      const externo = externoPorReservaId.get(String(h.reserva_id));
      if (!externo) continue;
      const idEntity = String(h.pms_external_guest_id ?? "").trim();
      // O hóspede precisa estar no detalhe deste ciclo: é de lá que sai o
      // `synced` que será enriquecido e reconciliado.
      const noDetalhe = (detalhes.get(externo)?.guests ?? []).some(
        (g) => String(g.externalGuestId ?? "").trim() === idEntity,
      );
      if (!noDetalhe) continue;
      entityIdsExistentes.push(idEntity);
      existentes.add(externo);
    }
  }

  const vistos = new Set<string>();
  const ordenados: string[] = [];
  for (const id of [...entityIdsNovas, ...entityIdsExistentes]) {
    if (vistos.has(id)) continue;
    vistos.add(id);
    ordenados.push(id);
  }
  const teto = Math.max(0, input.maxLookups);
  return {
    novas,
    ja_locais: jaLocais,
    existentes: [...existentes],
    entity_ids: ordenados.slice(0, teto),
    entity_ids_ignorados: Math.max(0, ordenados.length - teto),
    erro: null,
  };
}

export type CicloContatoResultado = {
  habilitada: true;
  candidatas: number;
  criadas: number;
  reusadas: number;
  erros: number;
  ignoradas_teto: number;
  enriquecimento: {
    solicitados: number;
    lidos: number;
    falhas: number;
    ignorados_teto: number;
    parou_por: string;
  };
  reconciliacao: { reservas: number; contatos_atualizados: number; erros: number };
  /** Reservas já locais cujo meal_plan_desc/população foi trazido do HITS. */
  plano_refeicao: { avaliadas: number; atualizadas: number; erros: number };
};

/**
 * Fase pós-snapshot do ciclo: planeja → consulta guest master (direcionado) →
 * aplica contato oficial no detalhe em memória → materializa as novas e
 * reconcilia contato das já existentes. Nenhum envio; nenhuma escrita no HITS.
 */
export async function executarCicloContatoEMaterializacao(input: {
  admin: SupabaseAdminLike;
  rows: ReadonlyArray<{ external_reservation_id: string; status_reserva: string }>;
  detalhes: ReadonlyMap<string, SyncedReservation>;
  buscarGuestRevenues: BuscarGuestRevenues;
  maxMaterializacoes?: number;
  maxLookups?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}): Promise<CicloContatoResultado> {
  const { admin, detalhes } = input;
  const log = input.log ?? (() => {});
  const maxMaterializacoes = input.maxMaterializacoes ?? HITS_AUTO_MATERIALIZAR_MAX_POR_CICLO;
  const maxLookups = input.maxLookups ?? 0;
  const out: CicloContatoResultado = {
    habilitada: true,
    candidatas: 0,
    criadas: 0,
    reusadas: 0,
    erros: 0,
    ignoradas_teto: 0,
    enriquecimento: { solicitados: 0, lidos: 0, falhas: 0, ignorados_teto: 0, parou_por: "fim" },
    reconciliacao: { reservas: 0, contatos_atualizados: 0, erros: 0 },
    plano_refeicao: { avaliadas: 0, atualizadas: 0, erros: 0 },
  };

  const plano = await planejarEnriquecimentoContato({
    admin,
    rows: input.rows,
    detalhes,
    maxLookups,
  });
  if (plano.erro) {
    log("[HITS_CONTATO] planejamento falhou", { code: plano.erro });
    return { ...out, erros: 1 };
  }
  out.candidatas = plano.novas.length;
  out.enriquecimento.solicitados = plano.entity_ids.length;
  out.enriquecimento.ignorados_teto = plano.entity_ids_ignorados;

  let porEntityId = new Map<string, HitsGuestRevenue>();
  if (plano.entity_ids.length > 0) {
    try {
      const r = await input.buscarGuestRevenues(plano.entity_ids);
      porEntityId = r.porEntityId;
      out.enriquecimento.lidos = r.lidos;
      out.enriquecimento.falhas = r.falhas;
      out.enriquecimento.ignorados_teto += r.ignorados_teto;
      out.enriquecimento.parou_por = r.parou_por;
    } catch (_e) {
      // Sem guest master o ciclo continua: cada hóspede fica com o fallback do
      // detalhe (contactPhone/contactMail) e nada é rebaixado.
      out.enriquecimento.parou_por = "erro";
    }
  }

  const enriquecido = (id: string): SyncedReservation | null => {
    const synced = detalhes.get(id);
    if (!synced) return null;
    return aplicarContatoOficialNaReserva(synced, porEntityId);
  };

  // 1. Reservas novas: materialização completa, já com o contato oficial.
  for (const id of plano.novas) {
    if (out.criadas + out.reusadas + out.erros >= maxMaterializacoes) {
      out.ignoradas_teto += 1;
      continue;
    }
    const synced = enriquecido(id);
    if (!synced) continue;
    try {
      const r = await materializarReservaSincronizada({ admin, externalId: id, synced, log });
      if (!r.ok) out.erros += 1;
      else if (r.reserva_criada) out.criadas += 1;
      else out.reusadas += 1;
    } catch (_e) {
      out.erros += 1;
    }
  }

  // 2. Plano de refeição das já locais: campo de origem HITS, sem rede e sem
  //    tocar em mais nada. É o que mantém o direito ao café correto quando o
  //    HITS muda o plano depois da materialização.
  for (const id of plano.ja_locais) {
    const synced = detalhes.get(id);
    if (!synced) continue;
    out.plano_refeicao.avaliadas += 1;
    try {
      const r = await reconciliarPlanoRefeicaoDaReserva({ admin, externalId: id, synced, log });
      if (!r.ok) out.plano_refeicao.erros += 1;
      else if (r.atualizado) out.plano_refeicao.atualizadas += 1;
    } catch (_e) {
      out.plano_refeicao.erros += 1;
    }
  }

  // 3. Reservas já locais: SOMENTE contato (whatsapp/email), nada mais.
  let reconciliadas = 0;
  for (const id of plano.existentes) {
    if (reconciliadas >= HITS_RECONCILIAR_CONTATO_MAX_POR_CICLO) break;
    const synced = enriquecido(id);
    if (!synced) continue;
    reconciliadas += 1;
    try {
      const r = await reconciliarContatosDaReserva({ admin, externalId: id, synced, log });
      out.reconciliacao.reservas += 1;
      out.reconciliacao.contatos_atualizados += r.contatos_atualizados;
    } catch (_e) {
      out.reconciliacao.erros += 1;
    }
  }

  return out;
}
