/**
 * Persistência real do sync de reservas HITS via Supabase.
 * Usa tabelas pms_* + operacional_* existentes (provider/origem = hits).
 * Não altera fluxo Hospedin.
 */

import type {
  SyncedReservation,
} from "../../../domain/yes-hotel/synced-reservation.ts";
import type {
  ReservationChangeEvent,
  SyncedReservationSnapshot,
} from "../../../domain/yes-hotel/reservation-sync-diff.ts";
import type {
  ReservationSyncRepository,
  PersistedSyncRun,
} from "../../../application/yes-hotel/reservation-sync-repository.ts";

/** Subset do SupabaseClient usado pelo repository (real ou fake de teste). */
export type ReservationSyncSupabaseClient = {
  from: (table: string) => {
    select: (cols?: string) => any;
    insert: (row: unknown) => any;
    upsert: (row: unknown, opts?: { onConflict?: string }) => any;
    update: (row: unknown) => any;
    delete: () => any;
  };
};

const PROVIDER = "hits";
const ORIGEM = "hits";

export class SupabaseReservationSyncRepository implements ReservationSyncRepository {
  constructor(private readonly client: ReservationSyncSupabaseClient) {}

  async findPmsSnapshot(
    provider: string,
    externalReservationId: string,
  ): Promise<SyncedReservationSnapshot | null> {
    const { data: pms, error } = await this.client
      .from("pms_reservas")
      .select(
        "id, external_reservation_id, unit_code, check_in, check_out, is_cancelled, payment_mapped, hospede_principal_nome, raw_payload",
      )
      .eq("provider", provider)
      .eq("external_reservation_id", externalReservationId)
      .maybeSingle();
    if (error || !pms) return null;

    const { data: links } = await this.client
      .from("pms_reserva_hospedes")
      .select("pms_hospede_id, is_principal")
      .eq("pms_reserva_id", pms.id);

    const guestIds: string[] = [];
    let phone: string | null = null;
    let email: string | null = null;
    for (const link of links ?? []) {
      const { data: g } = await this.client
        .from("pms_hospedes")
        .select("external_guest_id, telefone, email")
        .eq("id", link.pms_hospede_id)
        .maybeSingle();
      if (g?.external_guest_id) guestIds.push(String(g.external_guest_id));
      if (link.is_principal) {
        phone = (g?.telefone as string) || null;
        email = (g?.email as string) || null;
      }
    }
    guestIds.sort();

    const raw = (pms.raw_payload ?? {}) as Record<string, unknown>;
    const guestCount =
      typeof raw.__guest_count === "number"
        ? raw.__guest_count
        : guestIds.length || 1;

    return {
      externalReservationId: String(pms.external_reservation_id),
      reservationStatus: pms.is_cancelled ? "cancelada" : "ativa",
      checkIn: String(pms.check_in).slice(0, 10),
      checkOut: String(pms.check_out).slice(0, 10),
      apartmentCode: String(pms.unit_code ?? ""),
      mainGuestName: String(pms.hospede_principal_nome ?? ""),
      totalGuests: guestCount,
      paymentStatus: (pms.payment_mapped as SyncedReservationSnapshot["paymentStatus"]) || "desconhecido",
      phone,
      email,
      guestIds,
    };
  }

  async upsertFromSynced(
    reservation: SyncedReservation,
    events: ReservationChangeEvent[],
    options: { dryRun: boolean; nowIso: string },
  ): Promise<{
    operacionalId: string;
    created: boolean;
    updated: boolean;
    eventsWritten: number;
  }> {
    if (options.dryRun) {
      const { data: existing } = await this.client
        .from("operacional_reservas")
        .select("id")
        .eq("origem_externa", ORIGEM)
        .eq("external_reservation_id", reservation.externalReservationId)
        .maybeSingle();
      return {
        operacionalId: existing?.id ?? "dry-run",
        created: !existing,
        updated: Boolean(existing) && events.length > 0,
        eventsWritten: 0,
      };
    }

    const mirror = await this.upsertPmsMirror(reservation, options.nowIso);
    if (!mirror) {
      throw new Error("pms_mirror_upsert_failed");
    }

    const projected = await this.projectOperacional(reservation, events, options.nowIso);
    if (!projected) {
      throw new Error("operacional_projection_failed");
    }

    return {
      operacionalId: projected.operacionalId,
      created: projected.created,
      updated: projected.updated,
      eventsWritten: projected.eventsWritten,
    };
  }

  async startSyncRun(input: {
    provider: string;
    nowIso: string;
    dryRun: boolean;
  }): Promise<string> {
    if (input.dryRun) return "dry-run-sync";
    const { data, error } = await this.client
      .from("pms_sync_runs")
      .insert({
        provider: input.provider,
        status: "running",
        started_at: input.nowIso,
        stats: { dry_run: false },
        message: null,
      })
      .select("id")
      .single();
    if (error || !data?.id) throw new Error("sync_run_start_failed");
    return String(data.id);
  }

  async finishSyncRun(
    id: string,
    patch: {
      status: PersistedSyncRun["status"];
      finished_at: string;
      stats: Record<string, unknown>;
      message?: string | null;
    },
  ): Promise<void> {
    if (id === "dry-run-sync") return;
    await this.client
      .from("pms_sync_runs")
      .update({
        status: patch.status,
        finished_at: patch.finished_at,
        stats: patch.stats,
        message: patch.message ?? null,
      })
      .eq("id", id);
  }

  async recordSyncError(input: {
    sync_run_id: string;
    severity: "warn" | "error" | "fatal";
    step: string;
    message: string;
    context?: Record<string, unknown>;
  }): Promise<void> {
    if (input.sync_run_id === "dry-run-sync") return;
    await this.client.from("pms_sync_errors").insert({
      sync_run_id: input.sync_run_id,
      severity: input.severity,
      step: input.step,
      message: input.message.slice(0, 500),
      context: input.context ?? {},
    });
  }

  private async upsertPmsMirror(
    reservation: SyncedReservation,
    nowIso: string,
  ): Promise<{ pmsReservaId: string } | null> {
    const raw = {
      ...(reservation.rawSanitized ?? {}),
      __guest_count: reservation.totalGuests,
      __simulated: true,
    };
    const row = {
      provider: PROVIDER,
      external_reservation_id: reservation.externalReservationId,
      unit_code: reservation.apartmentCode || "",
      unit_name: reservation.apartmentCode || "",
      check_in: reservation.checkIn,
      check_out: reservation.checkOut,
      status_raw: reservation.reservationStatus,
      is_cancelled: reservation.reservationStatus === "cancelada",
      payment_status_raw: reservation.paymentStatus,
      payment_mapped: reservation.paymentStatus,
      hospede_principal_nome: reservation.mainGuestName || "",
      raw_payload: raw,
      pms_updated_at: reservation.sourceUpdatedAt,
      synced_at: nowIso,
    };

    const { data: upserted, error } = await this.client
      .from("pms_reservas")
      .upsert(row, { onConflict: "provider,external_reservation_id" })
      .select("id")
      .single();
    if (error || !upserted?.id) return null;
    const pmsReservaId = String(upserted.id);

    await this.client.from("pms_reserva_hospedes").delete().eq("pms_reserva_id", pmsReservaId);

    for (let i = 0; i < reservation.guests.length; i++) {
      const g = reservation.guests[i]!;
      const gid =
        g.externalGuestId ||
        `anon:${reservation.externalReservationId}:${g.name || i}`;
      const phone = g.phone ?? (g.isPrincipal ? reservation.phone : null) ?? "";
      const email = g.email ?? (g.isPrincipal ? reservation.email : null) ?? "";
      const { data: hRow, error: hErr } = await this.client
        .from("pms_hospedes")
        .upsert(
          {
            provider: PROVIDER,
            external_guest_id: gid,
            nome: g.name || "",
            email,
            telefone: phone,
            documento: g.documentNumber || "",
            nacionalidade: g.nationality || "",
            sexo: g.gender || "",
            data_nascimento: g.birthDate ? String(g.birthDate).slice(0, 10) : null,
            endereco_logradouro: "",
            cidade: "",
            estado: "",
            pais: g.nationality || "",
            cep: "",
            raw_payload: {
              simulated: true,
              documentType: g.documentType ?? null,
              birthDate: g.birthDate ?? null,
              gender: g.gender ?? null,
            },
            synced_at: nowIso,
          },
          { onConflict: "provider,external_guest_id" },
        )
        .select("id")
        .single();
      if (hErr || !hRow?.id) continue;
      await this.client.from("pms_reserva_hospedes").insert({
        pms_reserva_id: pmsReservaId,
        pms_hospede_id: hRow.id,
        is_principal: g.isPrincipal,
        ordem: i,
        raw_payload: {},
      });
    }

    return { pmsReservaId };
  }

  private async projectOperacional(
    reservation: SyncedReservation,
    events: ReservationChangeEvent[],
    nowIso: string,
  ): Promise<{
    operacionalId: string;
    created: boolean;
    updated: boolean;
    eventsWritten: number;
  } | null> {
    const pmsFields: Record<string, unknown> = {
      apartamento: reservation.apartmentCode || "",
      hospede_principal: reservation.mainGuestName || "",
      check_in_previsto: reservation.checkIn,
      check_out_previsto: reservation.checkOut,
      pagamento_status: reservation.paymentStatus,
      status_reserva: reservation.reservationStatus,
      synced_at: nowIso,
      origem_externa: ORIGEM,
      external_reservation_id: reservation.externalReservationId,
      total_hospedes_hits: reservation.totalGuests,
      meal_plan_desc: reservation.mealPlanDesc ?? null,
      channel_manager: reservation.channelManager ?? null,
      sales_channel: reservation.salesChannel ?? null,
      billing_entity: reservation.billingEntity ?? null,
      reservation_channel_id: reservation.reservationChannelId ?? null,
      reservation_balance_due: reservation.reservationBalanceDue,
      reservation_total_amount: reservation.reservationTotalAmount,
      updated_at: nowIso,
    };

    const { data: existing } = await this.client
      .from("operacional_reservas")
      .select("id, classificacao_comissionamento_origem")
      .eq("origem_externa", ORIGEM)
      .eq("external_reservation_id", reservation.externalReservationId)
      .maybeSingle();

    const canWriteHitsClassif =
      reservation.classificacaoComissionamento === "comissionada" ||
      reservation.classificacaoComissionamento === "nao_comissionada";
    const existingOrigem = String(
      (existing as { classificacao_comissionamento_origem?: string } | null)
        ?.classificacao_comissionamento_origem ?? "",
    );
    if (canWriteHitsClassif && existingOrigem !== "manual_operador") {
      pmsFields.classificacao_comissionamento = reservation.classificacaoComissionamento;
      pmsFields.classificacao_comissionamento_origem = "hits_campo";
      pmsFields.classificacao_comissionamento_atualizado_em = nowIso;
    }

    let operacionalId: string;
    let created = false;
    if (existing?.id) {
      const { error } = await this.client
        .from("operacional_reservas")
        .update(pmsFields)
        .eq("id", existing.id);
      if (error) return null;
      operacionalId = String(existing.id);
    } else {
      if (canWriteHitsClassif) {
        pmsFields.classificacao_comissionamento = reservation.classificacaoComissionamento;
        pmsFields.classificacao_comissionamento_origem = "hits_campo";
        pmsFields.classificacao_comissionamento_atualizado_em = nowIso;
      }
      const { data: ins, error } = await this.client
        .from("operacional_reservas")
        .insert({
          ...pmsFields,
          acesso_liberado: false,
          entrou_no_apto: false,
          fnrh_status_agregado: "fnrh_pendente",
        })
        .select("id")
        .single();
      if (error || !ins?.id) return null;
      operacionalId = String(ins.id);
      created = true;
    }

    const seen = new Set<string>();
    for (const g of reservation.guests) {
      const gid =
        g.externalGuestId ||
        `anon:${reservation.externalReservationId}:${g.name}`;
      seen.add(gid);
      const phone = g.phone ?? (g.isPrincipal ? reservation.phone : null) ?? "";
      const email = g.email ?? (g.isPrincipal ? reservation.email : null) ?? "";
      const hospedePayload: Record<string, unknown> = {
        reserva_id: operacionalId,
        nome: g.name || "",
        principal: g.isPrincipal,
        email,
        whatsapp: phone,
        pms_external_guest_id: gid,
        removed_from_reservation: false,
        updated_at: nowIso,
      };
      if (g.birthDate) hospedePayload.data_nascimento = String(g.birthDate).slice(0, 10);
      if (g.isMinor === true || g.isMinor === false) hospedePayload.is_minor = g.isMinor;

      const { data: hop } = await this.client
        .from("operacional_hospedes")
        .select("id")
        .eq("reserva_id", operacionalId)
        .eq("pms_external_guest_id", gid)
        .maybeSingle();

      if (hop?.id) {
        await this.client
          .from("operacional_hospedes")
          .update(hospedePayload)
          .eq("id", hop.id);
      } else {
        const { error: insErr } = await this.client
          .from("operacional_hospedes")
          .insert({
            ...hospedePayload,
            status_operacional: "nao_identificado",
            origem_cadastro: "existente_incompleto",
            modo_coleta_fnrh: "preenchimento_completo",
            tentativas_envio: 0,
            fnrh_required: true,
            requires_classification: false,
          });
        if (insErr) return null;
      }
    }

    const { data: opRows } = await this.client
      .from("operacional_hospedes")
      .select("id, pms_external_guest_id")
      .eq("reserva_id", operacionalId);

    for (const row of opRows ?? []) {
      const ext =
        typeof row.pms_external_guest_id === "string"
          ? row.pms_external_guest_id.trim()
          : "";
      if (ext && !seen.has(ext)) {
        await this.client
          .from("operacional_hospedes")
          .update({ removed_from_reservation: true, updated_at: nowIso })
          .eq("id", row.id);
      }
    }

    let eventsWritten = 0;
    for (const ev of events) {
      const { error } = await this.client.from("operacional_reserva_eventos").insert({
        reserva_id: operacionalId,
        tipo: ev.tipo,
        titulo: ev.titulo,
        detalhe: ev.detalhe,
        criado_em: nowIso,
      });
      if (!error) eventsWritten += 1;
    }

    // Garantia: todos os hóspedes ativos foram projetados.
    const { data: activeGuests } = await this.client
      .from("operacional_hospedes")
      .select("id")
      .eq("reserva_id", operacionalId)
      .eq("removed_from_reservation", false);
    if ((activeGuests ?? []).length < reservation.guests.length) {
      return null;
    }

    return {
      operacionalId,
      created,
      updated: !created && events.length > 0,
      eventsWritten,
    };
  }
}
