/**
 * Materialização do vínculo operacional de uma reserva HITS — lógica de
 * banco compartilhada entre a Edge sob demanda (hits-reserva-materializar) e a
 * materialização automática do ciclo do snapshot (hits-reservations-preview).
 *
 * Recebe o detalhe JÁ normalizado (SyncedReservation): não faz rede, não chama
 * o HITS, não envia nada. Escreve apenas em `operacional_reservas` e
 * `operacional_hospedes` (a ficha FNRH continua vindo do trigger
 * operacional_hospedes_criar_fnrh; `fnrh_hospedes` é apenas LIDA, para não
 * adotar posição cuja ficha já foi tocada). Idempotente: reserva é procurada
 * pela chave (origem_externa, external_reservation_id); hóspede por
 * (reserva_id, pms_external_guest_id); ficha preenchida nunca é sobrescrita,
 * nada é apagado. A única escrita sobre linha existente de hóspede é a adoção
 * da posição técnica intocada ("Novo hóspede" sem idEntity) pelo PAX HITS.
 *
 * MATERIALIZAR ≠ ENVIAR: nenhuma chamada a send-fnrh-links, send-senha,
 * DigiSac, Resend ou WhatsApp existe aqui. O envio da FNRH é da TAG externa.
 */

import type { SyncedReservation } from "../../domain/yes-hotel/synced-reservation.ts";
import { calcularPosicoesFaltantes } from "./hits-ocupacao.ts";
import { decidirEmailExistente, decidirWhatsappExistente } from "./hits-contato.ts";

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

export type HospedeMaterializado = {
  id_entity: string;
  criado: boolean;
  posicao_adotada: boolean;
  ambiguo?: true;
  /** hóspede já vinculado recebeu email/whatsapp do HITS (só esses campos). */
  contato_atualizado?: true;
};

export type MaterializacaoResultado =
  | {
      ok: true;
      reserva_id: string;
      external_reservation_id: string;
      reserva_criada: boolean;
      financeiro: { pagamento_status: string; backfilled: boolean };
      hospedes: HospedeMaterializado[];
      hospedes_total: number;
      contatos_atualizados: number;
      ocupacao: {
        declarada_hits: number;
        hospedes_ativos: number;
        posicoes_criadas: number;
        posicoes_adotadas: number;
        /** >0 = mais de uma posição técnica elegível: nada foi adotado NEM criado; exige intervenção manual. */
        posicoes_ambiguas: number;
      };
      /** true quando algum PAX ficou sem vínculo por ambiguidade (ver ocupacao.posicoes_ambiguas). */
      intervencao_manual: boolean;
    }
  | {
      ok: false;
      error: "reserva_sem_datas_no_hits" | "falha_ao_criar_reserva" | "falha_ao_criar_hospede";
      status: 422 | 500;
    };

/**
 * Posição técnica criada pelo passo 4 (ou pelo "Adicionar hóspede" do painel)
 * que ninguém tocou: sem idEntity, sem nome real, sem contato, não principal,
 * não removida, e cuja ficha FNRH (criada pelo trigger) ainda está em
 * 'pendente' sem ciclo de vida iniciado. É o ÚNICO tipo de linha que pode
 * passar a representar um PAX do HITS. Qualquer sinal de preenchimento
 * (nome, contato, rascunho, confirmação, lifecycle) desqualifica a linha.
 */
export const POSICAO_TECNICA = {
  nome: "Novo hóspede",
  origem_cadastro: "novo",
  status_operacional: "nao_identificado",
} as const;

const FNRH_LIFECYCLE_INTOCADA = new Set<string>(["", "pending", "link_sent"]);

type PosicaoTecnicaRow = {
  id: string;
  email?: string | null;
  whatsapp?: string | null;
};

/**
 * Procura a posição técnica segura da reserva. Retorna a linha só quando há
 * EXATAMENTE uma candidata; 0 → null (cria como hoje); >1 → null com
 * ambiguas>0 (não escolhe: escolher "a primeira" seria chute).
 */
export async function encontrarPosicaoTecnicaSegura(
  admin: SupabaseAdminLike,
  reservaId: string,
): Promise<{ posicao: PosicaoTecnicaRow | null; ambiguas: number }> {
  const { data } = await admin
    .from("operacional_hospedes")
    .select("id, email, whatsapp")
    .eq("reserva_id", reservaId)
    .is("pms_external_guest_id", null)
    .eq("nome", POSICAO_TECNICA.nome)
    .eq("origem_cadastro", POSICAO_TECNICA.origem_cadastro)
    .eq("status_operacional", POSICAO_TECNICA.status_operacional)
    .eq("principal", false)
    .or("removed_from_reservation.is.null,removed_from_reservation.eq.false");
  const candidatas = ((data ?? []) as PosicaoTecnicaRow[]).filter(
    (r) =>
      !String(r.email ?? "").trim() &&
      !String(r.whatsapp ?? "").trim(),
  );
  if (candidatas.length !== 1) {
    return { posicao: null, ambiguas: candidatas.length > 1 ? candidatas.length : 0 };
  }
  const unica = candidatas[0]!;
  if (await fichaFnrhTocada(admin, unica.id)) return { posicao: null, ambiguas: 0 };
  return { posicao: unica, ambiguas: 0 };
}

/**
 * Ficha FNRH do hóspede: LEITURA apenas (a ficha continua sendo do trigger e
 * do fnrh-submit). Ficha ausente = trigger ainda não rodou = intocada. Qualquer
 * rascunho/confirmação/lifecycle iniciado = tocada (dados do hóspede mandam).
 */
export async function fichaFnrhTocada(admin: SupabaseAdminLike, hospedeId: string): Promise<boolean> {
  const { data: fichas } = await admin
    .from("fnrh_hospedes")
    .select("status, fnrh_lifecycle_status")
    .eq("hospede_id", hospedeId);
  return ((fichas ?? []) as Array<{ status?: string | null; fnrh_lifecycle_status?: string | null }>).some(
    (f) =>
      String(f.status ?? "pendente") !== "pendente" ||
      !FNRH_LIFECYCLE_INTOCADA.has(String(f.fnrh_lifecycle_status ?? "")),
  );
}

/**
 * Hóspede JÁ vinculado (reserva_id + pms_external_guest_id): o HITS pode ter
 * ganhado celular/e-mail depois da materialização. Atualiza SOMENTE
 * `whatsapp`/`email` de operacional_hospedes, pelas regras de
 * decidirWhatsappExistente/decidirEmailExistente (nunca rebaixa celular para
 * fixo; e-mail só preenche vazio), e só se a ficha FNRH ainda está intocada —
 * ficha tocada = contato do hóspede é o que vale. Nome, principal, status,
 * ficha, link_token, lifecycle e auditoria não são tocados. Sem envio.
 * Devolve true se gravou.
 */
async function atualizarContatoExistente(
  admin: SupabaseAdminLike,
  row: { id: string; email?: string | null; whatsapp?: string | null },
  guest: { phone: string | null; email: string | null; phoneSource?: "cell" | "phone" | null },
  log: (msg: string, extra?: Record<string, unknown>) => void,
): Promise<boolean> {
  const contatoHits: { whatsapp?: string; email?: string } = {};
  // `phoneSource === "cell"` = veio de GuestRevenueDto.contactCellPhone: é o
  // único caso que autoriza trocar um fixo já gravado pelo celular.
  const whatsapp = decidirWhatsappExistente(row.whatsapp, guest.phone, guest.phoneSource === "cell");
  if (whatsapp) contatoHits.whatsapp = whatsapp;
  const email = decidirEmailExistente(row.email, guest.email);
  if (email) contatoHits.email = email;
  if (!contatoHits.whatsapp && !contatoHits.email) return false;
  if (await fichaFnrhTocada(admin, row.id)) return false;
  const { data, error } = await admin
    .from("operacional_hospedes")
    .update(contatoHits)
    .eq("id", row.id)
    .select("id");
  if (error) {
    log("[HITS_MATERIALIZAR] atualização de contato falhou", { code: error.code });
    return false;
  }
  return Array.isArray(data) && data.length === 1;
}

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

  // Plano de refeição e população: vêm do HITS e alimentam o direito ao café.
  // Texto bruto preservado; a classificação é feita na leitura do café.
  const planoHits = {
    meal_plan_desc: (synced.mealPlanDesc ?? "").trim() || null,
    total_hospedes_hits: Math.max(1, Number(synced.totalGuests) || 1),
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
        ...planoHits,
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
  //
  //    PAX ainda sem vínculo: antes de inserir, procura a posição técnica
  //    segura da reserva (passo 4 de uma rodada anterior, quando o HITS ainda
  //    não tinha o PAX cadastrado). Se existir exatamente uma, ela PASSA A SER
  //    o hóspede HITS (UPDATE de identificação em operacional_hospedes; a
  //    fnrh_hospedes e o link_token dela ficam como estão). Assim a ocupação
  //    não dobra: 1 PAX declarado + 1 PAX no HITS = 1 hóspede ativo.
  const hospedes: HospedeMaterializado[] = [];
  let posicoesAdotadas = 0;
  let posicoesAmbiguas = 0;
  let contatosAtualizados = 0;
  for (const guest of synced.guests ?? []) {
    const idEntity = String(guest.externalGuestId ?? "").trim();
    if (!idEntity) continue;

    const { data: existente } = await admin
      .from("operacional_hospedes")
      .select("id, email, whatsapp")
      .eq("reserva_id", reserva.id)
      .eq("pms_external_guest_id", idEntity)
      .maybeSingle();
    if (existente) {
      const atualizado = await atualizarContatoExistente(
        admin,
        existente as { id: string; email?: string | null; whatsapp?: string | null },
        guest,
        log,
      );
      if (atualizado) contatosAtualizados += 1;
      hospedes.push({
        id_entity: idEntity,
        criado: false,
        posicao_adotada: false,
        ...(atualizado ? { contato_atualizado: true as const } : {}),
      });
      continue;
    }

    const email = (guest.email ?? "").trim();
    const telefone = (guest.phone ?? "").trim();
    const identificacaoHits = {
      nome: (guest.name ?? "").trim(),
      principal: guest.isPrincipal === true,
      email,
      whatsapp: telefone,
      // Só é "pronto para envio" quem tem como receber o link. (Nenhum envio
      // acontece aqui: é só o estado que a TAG/operador usam depois.)
      status_operacional: email || telefone ? "pronto_para_envio" : "aguardando_contato",
      origem_cadastro: "existente_incompleto",
      pms_external_guest_id: idEntity,
    };

    const { posicao, ambiguas } = await encontrarPosicaoTecnicaSegura(admin, reserva.id);
    if (ambiguas > 0) {
      // Mais de uma posição técnica elegível: a reserva JÁ está inconsistente.
      // Saída conservadora: não escolhe, não adota, não insere (inserir só
      // pioraria: 2 posições + PAX = 3 ativos), não altera nada. Reporta e
      // segue — exige intervenção manual; o ciclo não cai.
      posicoesAmbiguas = Math.max(posicoesAmbiguas, ambiguas);
      log("[HITS_MATERIALIZAR] posições técnicas ambíguas: PAX não vinculado, nada escrito — intervenção manual", {
        ambiguas,
      });
      hospedes.push({ id_entity: idEntity, criado: false, posicao_adotada: false, ambiguo: true });
      continue;
    }
    if (posicao) {
      // Guardas repetidas no UPDATE: se outro processo já vinculou/tocou a
      // linha entre o SELECT e o UPDATE, zero linhas afetadas → cai no insert.
      const { data: adotada, error: errAdocao } = await admin
        .from("operacional_hospedes")
        .update(identificacaoHits)
        .eq("id", posicao.id)
        .eq("reserva_id", reserva.id)
        .is("pms_external_guest_id", null)
        .eq("nome", POSICAO_TECNICA.nome)
        .eq("status_operacional", POSICAO_TECNICA.status_operacional)
        .select("id");
      if (!errAdocao && Array.isArray(adotada) && adotada.length === 1) {
        posicoesAdotadas += 1;
        hospedes.push({ id_entity: idEntity, criado: false, posicao_adotada: true });
        continue;
      }
      if (errAdocao) {
        log("[HITS_MATERIALIZAR] adoção de posição falhou; cria", { code: errAdocao.code });
      }
    }

    const { error } = await admin.from("operacional_hospedes").insert({
      reserva_id: reserva.id,
      ...identificacaoHits,
      modo_coleta_fnrh: "preenchimento_completo",
    });
    if (error && !isUniqueViolation(error)) {
      log("[HITS_MATERIALIZAR] insert hóspede falhou", { code: error.code });
      return { ok: false, error: "falha_ao_criar_hospede", status: 500 };
    }
    hospedes.push({ id_entity: idEntity, criado: !error, posicao_adotada: false });
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
  // Com ambiguidade pendente não se cria posição nova: seria mais uma linha
  // técnica numa reserva que já tem posições demais.
  const faltam = posicoesAmbiguas > 0 ? 0 : calcularPosicoesFaltantes(synced.totalGuests, hospedesAtivos);

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
    contatos_atualizados: contatosAtualizados,
    ocupacao: {
      declarada_hits: Number(synced.totalGuests) || 1,
      hospedes_ativos: hospedesAtivos,
      posicoes_criadas: posicoesCriadas,
      posicoes_adotadas: posicoesAdotadas,
      posicoes_ambiguas: posicoesAmbiguas,
    },
    intervencao_manual: posicoesAmbiguas > 0,
  };
}

/**
 * RECONCILIAÇÃO DE CONTATO — reserva HITS **já materializada**.
 *
 * Caminho dedicado e deliberadamente estreito: não cria reserva, não cria
 * hóspede, não cria posição, não toca financeiro, ocupação, ficha FNRH,
 * link_token, lifecycle, nome, documento, `principal`, status operacional nem
 * auditoria. A ÚNICA escrita possível é `operacional_hospedes.whatsapp` e
 * `operacional_hospedes.email`, pelas regras de `hits-contato` (celular oficial
 * substitui fixo; celular nunca é rebaixado; e-mail só preenche vazio) e
 * somente enquanto a ficha FNRH do hóspede continuar intocada.
 *
 * Sem rede: o `synced` já chega enriquecido pelo guest master. Sem envio.
 */
export type ReconciliacaoContatoResultado = {
  ok: boolean;
  reserva_id: string | null;
  hospedes_avaliados: number;
  contatos_atualizados: number;
};

export async function reconciliarContatosDaReserva(input: {
  admin: SupabaseAdminLike;
  externalId: string;
  synced: SyncedReservation;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}): Promise<ReconciliacaoContatoResultado> {
  const { admin, externalId, synced } = input;
  const log = input.log ?? (() => {});
  const vazio: ReconciliacaoContatoResultado = {
    ok: true,
    reserva_id: null,
    hospedes_avaliados: 0,
    contatos_atualizados: 0,
  };

  const { data: reserva } = await admin
    .from("operacional_reservas")
    .select("id")
    .eq("origem_externa", ORIGEM_HITS)
    .eq("external_reservation_id", externalId)
    .maybeSingle();
  const reservaId = (reserva as { id?: string } | null)?.id;
  // Reserva ainda não materializada não é assunto desta função: quem cria é a
  // materialização, com o fluxo completo.
  if (!reservaId) return vazio;

  let avaliados = 0;
  let atualizados = 0;
  for (const guest of synced.guests ?? []) {
    const idEntity = String(guest.externalGuestId ?? "").trim();
    if (!idEntity) continue;
    if (!String(guest.phone ?? "").trim() && !String(guest.email ?? "").trim()) continue;

    const { data: existente } = await admin
      .from("operacional_hospedes")
      .select("id, email, whatsapp")
      .eq("reserva_id", reservaId)
      .eq("pms_external_guest_id", idEntity)
      .maybeSingle();
    if (!existente) continue;
    avaliados += 1;
    const mudou = await atualizarContatoExistente(
      admin,
      existente as { id: string; email?: string | null; whatsapp?: string | null },
      guest,
      log,
    );
    if (mudou) atualizados += 1;
  }

  return {
    ok: true,
    reserva_id: reservaId,
    hospedes_avaliados: avaliados,
    contatos_atualizados: atualizados,
  };
}

/**
 * RECONCILIAÇÃO DO PLANO DE REFEIÇÃO — reserva HITS **já materializada**.
 *
 * `meal_plan_desc` é campo de ORIGEM HITS: quando o HITS muda o plano do
 * quarto (ex.: "Nenhum" → "Café da Manhã"), o local precisa acompanhar, senão o
 * direito ao café fica errado. Escreve SOMENTE `meal_plan_desc` e
 * `total_hospedes_hits`, e só quando o valor difere do que já está gravado.
 *
 * Não toca FNRH, pagamento, status, senha, contato, hóspedes nem ocupação.
 * Sem rede, sem envio. Devolve true quando gravou.
 */
export async function reconciliarPlanoRefeicaoDaReserva(input: {
  admin: SupabaseAdminLike;
  externalId: string;
  synced: SyncedReservation;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}): Promise<{ ok: boolean; atualizado: boolean }> {
  const { admin, externalId, synced } = input;
  const log = input.log ?? (() => {});
  const mealPlanDesc = (synced.mealPlanDesc ?? "").trim() || null;
  const totalHits = Math.max(1, Number(synced.totalGuests) || 1);

  const { data } = await admin
    .from("operacional_reservas")
    .select("id, meal_plan_desc, total_hospedes_hits")
    .eq("origem_externa", ORIGEM_HITS)
    .eq("external_reservation_id", externalId)
    .maybeSingle();
  const reserva = data as
    | { id: string; meal_plan_desc?: string | null; total_hospedes_hits?: number | null }
    | null;
  if (!reserva) return { ok: true, atualizado: false };

  const patch: { meal_plan_desc?: string | null; total_hospedes_hits?: number } = {};
  const atual = (reserva.meal_plan_desc ?? "").trim() || null;
  if (atual !== mealPlanDesc) patch.meal_plan_desc = mealPlanDesc;
  if (Number(reserva.total_hospedes_hits ?? 0) !== totalHits) patch.total_hospedes_hits = totalHits;
  if (Object.keys(patch).length === 0) return { ok: true, atualizado: false };

  const { data: out, error } = await admin
    .from("operacional_reservas")
    .update(patch)
    .eq("id", reserva.id)
    .select("id");
  if (error) {
    log("[HITS_MATERIALIZAR] reconciliação de plano falhou", { code: error.code });
    return { ok: false, atualizado: false };
  }
  return { ok: true, atualizado: Array.isArray(out) && out.length === 1 };
}
