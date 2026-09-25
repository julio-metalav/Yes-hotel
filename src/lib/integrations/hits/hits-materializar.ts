/**
 * Materialização do vínculo operacional de uma reserva HITS — lógica de
 * banco compartilhada entre a Edge sob demanda (hits-reserva-materializar) e a
 * materialização automática do ciclo do snapshot (hits-reservations-preview).
 *
 * Recebe o detalhe JÁ normalizado (SyncedReservation): não faz rede, não chama
 * o HITS, não envia nada. Escreve apenas em `operacional_reservas` e
 * `operacional_hospedes` (a ficha FNRH continua vindo do trigger
 * operacional_hospedes_criar_fnrh). Idempotente: reserva é procurada pela
 * chave (origem_externa, external_reservation_id); hóspede por
 * (reserva_id, pms_external_guest_id); nada é sobrescrito, nada é apagado.
 *
 * MATERIALIZAR ≠ ENVIAR: nenhuma chamada a send-fnrh-links, send-senha,
 * DigiSac, Resend ou WhatsApp existe aqui. O envio da FNRH é da TAG externa.
 */

import type { SyncedReservation } from "../../domain/yes-hotel/synced-reservation.ts";
import { calcularPosicoesFaltantes } from "./hits-ocupacao.ts";

/** Origem fixa: é o que o índice único de idempotência usa. */
export const ORIGEM_HITS = "hits";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function ymdOrNull(value: unknown): string | null {
  const s = String(value ?? "").slice(0, 10);
  return YMD_RE.test(s) ? s : null;
}

/** 23505 = unique_violation: outro processo ganhou a corrida. */
export function isUniqueViolation(error: unknown): boolean {
  return String((error as { code?: string } | null)?.code ?? "") === "23505";
}

/**
 * Subconjunto de supabase-js usado aqui (service_role). Tipado de forma
 * frouxa de propósito: o helper é testado com um cliente falso.
 */
// deno-lint-ignore no-explicit-any
export type SupabaseAdminLike = { from: (table: string) => any };

export type MaterializacaoResultado =
  | {
      ok: true;
      reserva_id: string;
      external_reservation_id: string;
      reserva_criada: boolean;
      financeiro: { pagamento_status: string; backfilled: boolean };
      hospedes: Array<{ id_entity: string; criado: boolean }>;
      hospedes_total: number;
      ocupacao: { declarada_hits: number; hospedes_ativos: number; posicoes_criadas: number };
    }
  | {
      ok: false;
      error: "reserva_sem_datas_no_hits" | "falha_ao_criar_reserva" | "falha_ao_criar_hospede";
      status: 422 | 500;
    };

export async function materializarReservaSincronizada(input: {
  admin: SupabaseAdminLike;
  externalId: string;
  synced: SyncedReservation;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}): Promise<MaterializacaoResultado> {
  const { admin, externalId, synced } = input;
  const log = input.log ?? (() => {});

  // Datas vêm do HITS. Sem elas não se inventa `current_date`: o painel filtra
  // por dia operacional e uma data chutada esconderia a reserva da grade.
  const checkIn = ymdOrNull(synced.checkIn);
  const checkOut = ymdOrNull(synced.checkOut);
  if (!checkIn || !checkOut) {
    return { ok: false, error: "reserva_sem_datas_no_hits", status: 422 };
  }

  // 2. Reserva operacional: reusa se já existe (índice único parcial em
  //    origem_externa + external_reservation_id garante unicidade).
  async function findReserva(): Promise<{ id: string } | null> {
    const { data } = await admin
      .from("operacional_reservas")
      .select("id")
      .eq("origem_externa", ORIGEM_HITS)
      .eq("external_reservation_id", externalId)
      .maybeSingle();
    return (data as { id: string } | null) ?? null;
  }

  // Financeiro da reserva HITS, já classificado pelo normalizador (regra do
  // domínio: reservationBalanceDue <= 0 → pago; > 0 → pendente; ausente →
  // desconhecido; comissionamento por canal). Nenhum valor de cartão/contato:
  // só saldo, total e classificação.
  const financeiroHits = {
    pagamento_status: synced.paymentStatus,
    reservation_balance_due: synced.reservationBalanceDue,
    reservation_total_amount: synced.reservationTotalAmount,
    classificacao_comissionamento: synced.classificacaoComissionamento,
    classificacao_comissionamento_origem: "hits_campo",
  };

  let reserva = await findReserva();
  let reservaCriada = false;
  if (!reserva) {
    const { data, error } = await admin
      .from("operacional_reservas")
      .insert({
        apartamento: synced.apartmentCode || "",
        hospede_principal: synced.mainGuestName || "",
        check_in_previsto: checkIn,
        check_out_previsto: checkOut,
        origem_externa: ORIGEM_HITS,
        external_reservation_id: externalId,
        ...financeiroHits,
      })
      .select("id")
      .single();
    if (error) {
      // Corrida com outro processo: o vencedor já criou — reusa.
      if (!isUniqueViolation(error)) {
        log("[HITS_MATERIALIZAR] insert reserva falhou", { code: error.code });
        return { ok: false, error: "falha_ao_criar_reserva", status: 500 };
      }
      reserva = await findReserva();
    } else {
      reserva = data as { id: string };
      reservaCriada = true;
    }
  }
  if (!reserva) {
    return { ok: false, error: "falha_ao_criar_reserva", status: 500 };
  }

  // 2b. Reserva materializada ANTES do financeiro existir: aplica o financeiro
  //     do HITS uma única vez. Guardado por reservation_balance_due IS NULL —
  //     nunca sobrescreve saldo/status já sincronizado ou já decrementado por
  //     cobrança Pagar.me. Só colunas financeiras.
  let financeiroBackfilled = false;
  if (!reservaCriada) {
    const { data: fin } = await admin
      .from("operacional_reservas")
      .update(financeiroHits)
      .eq("id", reserva.id)
      .is("reservation_balance_due", null)
      .select("id");
    financeiroBackfilled = Array.isArray(fin) && fin.length > 0;
  }

  // 3. Um operacional_hospedes por PAX com idEntity — o trigger existente cria
  //    a fnrh_hospedes com link_token. Hóspede já vinculado é reusado como está:
  //    nada é sobrescrito, e ficha preenchida permanece intacta.
  const hospedes: Array<{ id_entity: string; criado: boolean }> = [];
  for (const guest of synced.guests ?? []) {
    const idEntity = String(guest.externalGuestId ?? "").trim();
    if (!idEntity) continue;

    const { data: existente } = await admin
      .from("operacional_hospedes")
      .select("id")
      .eq("reserva_id", reserva.id)
      .eq("pms_external_guest_id", idEntity)
      .maybeSingle();
    if (existente) {
      hospedes.push({ id_entity: idEntity, criado: false });
      continue;
    }

    const email = (guest.email ?? "").trim();
    const telefone = (guest.phone ?? "").trim();
    const { error } = await admin.from("operacional_hospedes").insert({
      reserva_id: reserva.id,
      nome: (guest.name ?? "").trim(),
      principal: guest.isPrincipal === true,
      email,
      whatsapp: telefone,
      // Só é "pronto para envio" quem tem como receber o link. (Nenhum envio
      // acontece aqui: é só o estado que a TAG/operador usam depois.)
      status_operacional: email || telefone ? "pronto_para_envio" : "aguardando_contato",
      origem_cadastro: "existente_incompleto",
      modo_coleta_fnrh: "preenchimento_completo",
      pms_external_guest_id: idEntity,
    });
    if (error && !isUniqueViolation(error)) {
      log("[HITS_MATERIALIZAR] insert hóspede falhou", { code: error.code });
      return { ok: false, error: "falha_ao_criar_hospede", status: 500 };
    }
    hospedes.push({ id_entity: idEntity, criado: !error });
  }

  // 4. Completa a ocupação declarada pelo HITS com posições sem PAX.
  //    Mesmo payload do "Adicionar hóspede" do painel — e sem
  //    pms_external_guest_id, porque não se inventa idEntity. A ficha e o
  //    link_token continuam vindo do trigger operacional_hospedes_criar_fnrh.
  const { data: ativos } = await admin
    .from("operacional_hospedes")
    .select("id")
    .eq("reserva_id", reserva.id)
    .or("removed_from_reservation.is.null,removed_from_reservation.eq.false");
  const hospedesAtivos = (ativos ?? []).length;
  const faltam = calcularPosicoesFaltantes(synced.totalGuests, hospedesAtivos);

  let posicoesCriadas = 0;
  for (let i = 0; i < faltam; i += 1) {
    const { error } = await admin.from("operacional_hospedes").insert({
      reserva_id: reserva.id,
      nome: "Novo hóspede",
      principal: false,
      status_operacional: "nao_identificado",
      origem_cadastro: "novo",
      modo_coleta_fnrh: "preenchimento_completo",
      tentativas_envio: 0,
    });
    if (error) {
      log("[HITS_MATERIALIZAR] insert posição falhou", { code: error.code });
      break;
    }
    posicoesCriadas += 1;
  }

  return {
    ok: true,
    reserva_id: reserva.id,
    external_reservation_id: externalId,
    reserva_criada: reservaCriada,
    financeiro: { pagamento_status: synced.paymentStatus, backfilled: financeiroBackfilled },
    hospedes,
    hospedes_total: hospedes.length,
    ocupacao: {
      declarada_hits: Number(synced.totalGuests) || 1,
      hospedes_ativos: hospedesAtivos,
      posicoes_criadas: posicoesCriadas,
    },
  };
}
