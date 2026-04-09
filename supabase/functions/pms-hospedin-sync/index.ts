/**
 * Pull Hospedin → espelho Supabase (pms_*) + projeção operacional (operacional_*).
 * Autenticação HTTP configurável; contrato JSON normalizado em _shared/pms-hospedin-mapper.ts.
 * Invocar com service_role (cron) ou POST com header x-hospedin-sync-secret se configurado.
 */

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  normalizeHospedinListPayload,
  type NormalizedPmsGuest,
  type NormalizedPmsReservation,
} from "../_shared/pms-hospedin-mapper.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hospedin-sync-secret",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const PROVIDER = "hospedin";
const ORIGEM_OPERACIONAL = "hospedin";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function windowDates(): { dateFrom: string; dateTo: string } {
  const today = new Date();
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(today);
  to.setUTCDate(to.getUTCDate() + 30);
  return { dateFrom: ymd(from), dateTo: ymd(to) };
}

function composeEndereco(g: NormalizedPmsGuest): string {
  const parts = [g.endereco_logradouro, g.cidade, g.estado, g.cep, g.pais].filter((p) => p && String(p).trim());
  return parts.join(", ");
}

async function logError(
  client: SupabaseClient,
  runId: string | null,
  step: string,
  message: string,
  context: Record<string, unknown>,
): Promise<void> {
  if (!runId) return;
  try {
    await client.from("pms_sync_errors").insert({
      sync_run_id: runId,
      step,
      message,
      context,
      severity: "error",
    });
  } catch (e) {
    console.warn("[pms-hospedin-sync] logError", e);
  }
}

async function prefillFnrhFromPms(
  client: SupabaseClient,
  hospedeOperacionalId: string,
  g: NormalizedPmsGuest,
): Promise<void> {
  const endereco = composeEndereco(g);
  const patch: Record<string, unknown> = {};
  if (g.documento.trim()) patch.documento = g.documento.trim();
  if (g.data_nascimento) patch.data_nascimento = g.data_nascimento;
  if (g.nacionalidade.trim()) patch.nacionalidade = g.nacionalidade.trim();
  if (g.email.trim()) patch.email = g.email.trim();
  if (g.telefone.trim()) patch.telefone = g.telefone.trim();
  if (endereco.trim()) patch.endereco = endereco.trim();
  if (g.nome.trim()) patch.hospede_nome = g.nome.trim();
  if (Object.keys(patch).length === 0) return;
  const { error } = await client
    .from("fnrh_hospedes")
    .update(patch)
    .eq("hospede_id", hospedeOperacionalId)
    .eq("status", "pendente");
  if (error && typeof console !== "undefined") {
    console.warn("[pms-hospedin-sync] prefillFnrhFromPms", error.message);
  }
}

async function removeOperacionalCancelled(
  client: SupabaseClient,
  externalReservationId: string,
): Promise<void> {
  await client
    .from("operacional_reservas")
    .delete()
    .eq("origem_externa", ORIGEM_OPERACIONAL)
    .eq("external_reservation_id", externalReservationId);
}

async function upsertPmsMirror(
  client: SupabaseClient,
  runId: string | null,
  r: NormalizedPmsReservation,
): Promise<{ pmsReservaId: string } | null> {
  const row = {
    provider: PROVIDER,
    external_reservation_id: r.externalReservationId,
    property_external_id: r.propertyExternalId,
    unit_code: r.unitCode,
    unit_name: r.unitName,
    check_in: r.checkIn,
    check_out: r.checkOut,
    status_raw: r.statusRaw,
    is_cancelled: r.isCancelled,
    payment_status_raw: r.paymentStatusRaw,
    payment_mapped: r.paymentMapped,
    hospede_principal_nome: r.hospedePrincipalNome,
    raw_payload: r.raw as Record<string, unknown>,
    synced_at: new Date().toISOString(),
  };

  const { data: upserted, error } = await client
    .from("pms_reservas")
    .upsert(row, { onConflict: "provider,external_reservation_id" })
    .select("id")
    .single();

  if (error || !upserted?.id) {
    await logError(client, runId, "pms_reservas.upsert", error?.message ?? "sem id", {
      external_reservation_id: r.externalReservationId,
    });
    return null;
  }

  const pmsReservaId = upserted.id as string;

  await client.from("pms_reserva_hospedes").delete().eq("pms_reserva_id", pmsReservaId);

  for (let i = 0; i < r.guests.length; i++) {
    const g = r.guests[i]!;
    const gh = {
      provider: PROVIDER,
      external_guest_id: g.externalGuestId,
      nome: g.nome,
      email: g.email,
      telefone: g.telefone,
      documento: g.documento,
      data_nascimento: g.data_nascimento || null,
      nacionalidade: g.nacionalidade,
      sexo: g.sexo,
      endereco_logradouro: g.endereco_logradouro,
      cidade: g.cidade,
      estado: g.estado,
      pais: g.pais,
      cep: g.cep,
      raw_payload: g.raw as Record<string, unknown>,
      synced_at: new Date().toISOString(),
    };
    const { data: hRow, error: hErr } = await client
      .from("pms_hospedes")
      .upsert(gh, { onConflict: "provider,external_guest_id" })
      .select("id")
      .single();
    if (hErr || !hRow?.id) {
      await logError(client, runId, "pms_hospedes.upsert", hErr?.message ?? "sem id", {
        external_guest_id: g.externalGuestId,
      });
      continue;
    }
    const { error: linkErr } = await client.from("pms_reserva_hospedes").insert({
      pms_reserva_id: pmsReservaId,
      pms_hospede_id: hRow.id,
      is_principal: g.isPrincipal,
      ordem: i,
      raw_payload: g.raw as Record<string, unknown>,
    });
    if (linkErr) {
      await logError(client, runId, "pms_reserva_hospedes.insert", linkErr.message, {
        pms_reserva_id: pmsReservaId,
        pms_hospede_id: hRow.id,
      });
    }
  }

  return { pmsReservaId };
}

function origemCadastro(g: NormalizedPmsGuest): string {
  const hasNome = g.nome.trim().length > 0;
  const hasContact = g.email.trim().length > 0 || g.telefone.trim().length > 0;
  if (hasNome && hasContact) return "existente_completo";
  if (hasNome) return "existente_incompleto";
  return "agencia_sem_dados";
}

async function projectOperacional(
  client: SupabaseClient,
  runId: string | null,
  r: NormalizedPmsReservation,
): Promise<void> {
  if (r.isCancelled) {
    await removeOperacionalCancelled(client, r.externalReservationId);
    return;
  }

  const reservaPayload = {
    apartamento: r.unitCode,
    hospede_principal: r.hospedePrincipalNome,
    check_in_previsto: r.checkIn,
    check_out_previsto: r.checkOut,
    pagamento_status: r.paymentMapped,
    origem_externa: ORIGEM_OPERACIONAL,
    external_reservation_id: r.externalReservationId,
    updated_at: new Date().toISOString(),
  };

  const { data: existing } = await client
    .from("operacional_reservas")
    .select("id")
    .eq("origem_externa", ORIGEM_OPERACIONAL)
    .eq("external_reservation_id", r.externalReservationId)
    .maybeSingle();

  let reservaId: string;
  if (existing?.id) {
    const { error } = await client.from("operacional_reservas").update(reservaPayload).eq("id", existing.id);
    if (error) {
      await logError(client, runId, "operacional_reservas.update", error.message, {
        external_reservation_id: r.externalReservationId,
      });
      return;
    }
    reservaId = existing.id as string;
  } else {
    const { data: ins, error } = await client
      .from("operacional_reservas")
      .insert({
        ...reservaPayload,
        acesso_liberado: false,
        entrou_no_apto: false,
      })
      .select("id")
      .single();
    if (error || !ins?.id) {
      await logError(client, runId, "operacional_reservas.insert", error?.message ?? "sem id", {
        external_reservation_id: r.externalReservationId,
      });
      return;
    }
    reservaId = ins.id as string;
  }

  const externalGuestIds = r.guests.map((g) => g.externalGuestId).filter(Boolean);

  for (let i = 0; i < r.guests.length; i++) {
    const g = r.guests[i]!;
    const nome = g.nome.trim()
      ? g.nome.trim()
      : g.isPrincipal
      ? "Hóspede principal"
      : `Hóspede ${i + 1}`;

    const hospedePayload = {
      reserva_id: reservaId,
      nome,
      principal: g.isPrincipal,
      email: g.email.trim(),
      whatsapp: g.telefone.trim(),
      pms_external_guest_id: g.externalGuestId,
      origem_cadastro: origemCadastro({ ...g, nome }),
      modo_coleta_fnrh: "preenchimento_completo",
      updated_at: new Date().toISOString(),
    };

    const { data: hop } = await client
      .from("operacional_hospedes")
      .select("id")
      .eq("reserva_id", reservaId)
      .eq("pms_external_guest_id", g.externalGuestId)
      .maybeSingle();

    if (hop?.id) {
      await client.from("operacional_hospedes").update(hospedePayload).eq("id", hop.id);
      await prefillFnrhFromPms(client, hop.id as string, { ...g, nome });
    } else {
      const { data: inserted, error: insErr } = await client
        .from("operacional_hospedes")
        .insert(hospedePayload)
        .select("id")
        .single();
      if (insErr || !inserted?.id) {
        await logError(client, runId, "operacional_hospedes.insert", insErr?.message ?? "sem id", {
          external_guest_id: g.externalGuestId,
        });
      } else {
        await prefillFnrhFromPms(client, inserted.id as string, { ...g, nome });
      }
    }
  }

  const { data: opRows } = await client
    .from("operacional_hospedes")
    .select("id, pms_external_guest_id")
    .eq("reserva_id", reservaId);

  const keep = new Set(externalGuestIds);
  for (const row of opRows ?? []) {
    const ext = typeof row.pms_external_guest_id === "string" ? row.pms_external_guest_id.trim() : "";
    if (ext && !keep.has(ext)) {
      await client.from("operacional_hospedes").delete().eq("id", row.id as string);
    }
  }
}

function buildListUrl(dateFrom: string, dateTo: string): string | null {
  const base = (Deno.env.get("HOSPEDIN_API_BASE_URL") ?? "").trim().replace(/\/+$/, "");
  if (!base) return null;
  const rawPath = (Deno.env.get("HOSPEDIN_RESERVATIONS_PATH") ?? "/reservations").trim();
  const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const url = new URL(`${base}${path}`);
  const pFrom = (Deno.env.get("HOSPEDIN_QUERY_DATE_FROM_PARAM") ?? "check_in_from").trim() || "check_in_from";
  const pTo = (Deno.env.get("HOSPEDIN_QUERY_DATE_TO_PARAM") ?? "check_in_to").trim() || "check_in_to";
  url.searchParams.set(pFrom, dateFrom);
  url.searchParams.set(pTo, dateTo);
  const extra = (Deno.env.get("HOSPEDIN_EXTRA_QUERY") ?? "").trim();
  if (extra) {
    const q = extra.startsWith("?") ? extra.slice(1) : extra;
    for (const part of q.split("&")) {
      const [k, v] = part.split("=").map((s) => decodeURIComponent(s.trim()));
      if (k) url.searchParams.set(k, v ?? "");
    }
  }
  return url.toString();
}

function buildFetchHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  const token = (Deno.env.get("HOSPEDIN_API_TOKEN") ?? "").trim();
  const mode = (Deno.env.get("HOSPEDIN_AUTH_MODE") ?? "bearer").toLowerCase().trim();
  if (token) {
    if (mode === "header") {
      const hn = (Deno.env.get("HOSPEDIN_API_KEY_HEADER") ?? "X-Api-Key").trim();
      headers[hn] = token;
    } else {
      const prefix = (Deno.env.get("HOSPEDIN_AUTH_PREFIX") ?? "Bearer").trim();
      headers["Authorization"] = prefix.endsWith(" ") ? `${prefix}${token}` : `${prefix} ${token}`;
    }
  }
  const extraJson = (Deno.env.get("HOSPEDIN_EXTRA_HEADERS_JSON") ?? "").trim();
  if (extraJson) {
    try {
      const obj = JSON.parse(extraJson) as Record<string, string>;
      Object.assign(headers, obj);
    } catch {
      /* ignore */
    }
  }
  return headers;
}

function checkSyncSecret(req: Request): boolean {
  const expected = (Deno.env.get("HOSPEDIN_SYNC_SECRET") ?? "").trim();
  if (!expected) return true;
  return req.headers.get("x-hospedin-sync-secret") === expected;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!checkSyncSecret(req)) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }

  const { dateFrom, dateTo } = windowDates();
  let body: unknown = null;

  if (req.method === "POST") {
    try {
      const text = await req.text();
      if (text.trim()) body = JSON.parse(text);
    } catch {
      return jsonResponse({ ok: false, error: "invalid_json" }, 400);
    }
  }

  const mockPayload = body && typeof body === "object" && body !== null && "mock_payload" in body
    ? (body as { mock_payload?: unknown }).mock_payload
    : null;

  const listUrl = buildListUrl(dateFrom, dateTo);
  let rawJson: unknown;

  if (mockPayload !== undefined && mockPayload !== null) {
    rawJson = mockPayload;
  } else if (!listUrl) {
    return jsonResponse({
      ok: false,
      error: "HOSPEDIN_API_BASE_URL não configurado. Use mock_payload no POST para teste ou defina secrets.",
      date_from: dateFrom,
      date_to: dateTo,
    }, 501);
  } else {
    const method = (Deno.env.get("HOSPEDIN_LIST_METHOD") ?? "GET").toUpperCase().trim();
    const init: RequestInit = { method, headers: buildFetchHeaders() };
    if (method === "POST") {
      const template = (Deno.env.get("HOSPEDIN_LIST_POST_BODY_JSON") ?? "{}").trim();
      const repl = template
        .replaceAll("{date_from}", dateFrom)
        .replaceAll("{date_to}", dateTo);
      init.body = repl;
      const h = init.headers as Record<string, string>;
      h["Content-Type"] = h["Content-Type"] ?? "application/json";
    }
    let res: Response;
    try {
      res = await fetch(listUrl, init);
    } catch (e) {
      return jsonResponse({
        ok: false,
        error: "fetch_failed",
        detail: e instanceof Error ? e.message : String(e),
      }, 502);
    }
    if (!res.ok) {
      const t = await res.text();
      return jsonResponse({
        ok: false,
        error: "pms_http_error",
        status: res.status,
        body_preview: t.slice(0, 500),
      }, 502);
    }
    try {
      rawJson = await res.json();
    } catch {
      return jsonResponse({ ok: false, error: "pms_response_not_json" }, 502);
    }
  }

  const reservations = normalizeHospedinListPayload(rawJson);

  const { data: runRow, error: runErr } = await admin
    .from("pms_sync_runs")
    .insert({
      provider: PROVIDER,
      status: "running",
      date_from: dateFrom,
      date_to: dateTo,
      stats: { received: reservations.length },
    })
    .select("id")
    .single();

  const runId = runErr ? null : (runRow?.id as string | undefined) ?? null;
  if (runErr && typeof console !== "undefined") {
    console.warn("[pms-hospedin-sync] pms_sync_runs.insert", runErr.message);
  }

  let mirrorOk = 0;
  let projected = 0;
  let cancelledRemoved = 0;
  const errors: string[] = [];

  for (const r of reservations) {
    if (r.isCancelled) cancelledRemoved++;
    const m = await upsertPmsMirror(admin, runId, r);
    if (m) {
      mirrorOk++;
    } else {
      errors.push(`mirror:${r.externalReservationId}`);
      if (r.isCancelled) {
        await removeOperacionalCancelled(admin, r.externalReservationId);
        projected++;
      }
      continue;
    }
    try {
      await projectOperacional(admin, runId, r);
      projected++;
    } catch (e) {
      errors.push(`project:${r.externalReservationId}:${e instanceof Error ? e.message : String(e)}`);
      await logError(admin, runId, "projectOperacional", e instanceof Error ? e.message : String(e), {
        external_reservation_id: r.externalReservationId,
      });
    }
  }

  const status = errors.length === 0 ? "success" : errors.length < reservations.length ? "partial" : "failed";
  if (runId) {
    await admin
      .from("pms_sync_runs")
      .update({
        status,
        finished_at: new Date().toISOString(),
        message: errors.length ? errors.slice(0, 20).join("; ") : null,
        stats: {
          received: reservations.length,
          mirror_ok: mirrorOk,
          projected,
          cancelled_in_batch: cancelledRemoved,
          errors: errors.length,
        },
      })
      .eq("id", runId);
  }

  return jsonResponse({
    ok: errors.length === 0,
    status,
    date_from: dateFrom,
    date_to: dateTo,
    run_id: runId,
    counts: {
      received: reservations.length,
      mirror_ok: mirrorOk,
      projected,
      cancelled_in_batch: cancelledRemoved,
      errors: errors.length,
    },
    error_samples: errors.slice(0, 10),
  });
});
