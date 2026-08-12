/**
 * Edge: sync manual de reservas HITS (mock | real preparado).
 *
 * dry-run default → zero escrita, contadores would*.
 * Persistência Supabase só com:
 *   HITS_RESERVATION_SYNC_ENABLED=true
 *   HITS_RESERVATION_SYNC_PERSISTENCE_ENABLED=true
 *   HITS_RESERVATION_SCHEMA_READY=true
 *   dry_run=false
 *
 * Modo real:
 *   - HITS_INTEGRATION_ENABLED === true
 *   - credenciais/contexto presentes
 *   - NÃO ativar em produção sem smoke controlado
 *
 * Body smoke opcional (limites seguros):
 *   date_from, date_to (YYYY-MM-DD)
 *   max_pages (1..50, default 50)
 *   max_reservations (1..100; omitido = sem hard-cap além da paginação)
 *
 * Sync de leitura/persistência NÃO dispara: cobrança, senha, TTLock, escrita HITS.
 * Após create operacional (persistência real), orquestra FNRH via send-fnrh-links
 * (tipo_evento=reserva_criada) sem falhar o sync se Resend/DigiSac estiverem indisponíveis.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  getReservationSyncFlags,
  syncReservationsFromSource,
} from "../../../src/lib/application/yes-hotel/reservation-sync-service.ts";
import {
  createEmptyMemorySyncState,
  InMemoryReservationSyncRepository,
} from "../../../src/lib/application/yes-hotel/reservation-sync-repository.ts";
import { SupabaseReservationSyncRepository } from "../../../src/lib/infrastructure/supabase/yes-hotel/supabase-reservation-sync-repository.ts";
import { resolveHitsReservationSource } from "../../../src/lib/integrations/hits/resolve-hits-reservation-source.ts";
import type { HitsConfig } from "../../../src/lib/integrations/hits/config.ts";
import { constantTimeEqual } from "../../../src/lib/integrations/ttlock/access-ingest/constant-time.ts";
import { notifyFnrhLinksForCreatedReservations } from "../_shared/comunicacao-operacional/notify-fnrh-reservation-created.ts";
import { resolveFnrhPublicBaseUrl } from "../_shared/fnrh-public-link.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-hits-sync-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const syncToken = (Deno.env.get("HITS_RESERVATION_SYNC_TOKEN") ?? "").trim();

/** Cap duro no body — evita sync acidental do universo. */
const MAX_RESERVATIONS_BODY_CAP = 100;
const MAX_PAGES_BODY_CAP = 50;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function authorize(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization") ?? "";
  if (auth.startsWith("Bearer ") && serviceRoleKey) {
    const token = auth.slice("Bearer ".length).trim();
    if (token && constantTimeEqual(token, serviceRoleKey)) return true;
  }
  if (syncToken) {
    const header = (req.headers.get("x-hits-sync-token") ?? "").trim();
    if (header && constantTimeEqual(header, syncToken)) return true;
  }
  return false;
}

function denoEnv(): Record<string, string | undefined> {
  const keys = [
    "HITS_RESERVATION_SYNC_ENABLED",
    "HITS_RESERVATION_SYNC_MODE",
    "HITS_RESERVATION_SYNC_BATCH_SIZE",
    "HITS_RESERVATION_SYNC_PERSISTENCE_ENABLED",
    "HITS_RESERVATION_SCHEMA_READY",
    "HITS_INTEGRATION_ENABLED",
  ];
  const env: Record<string, string | undefined> = {};
  for (const k of keys) env[k] = Deno.env.get(k) ?? undefined;
  return env;
}

/** Config HITS a partir de Deno.env (Edge não usa process.env). */
function hitsConfigFromDenoEnv(): HitsConfig {
  const read = (name: string): string => String(Deno.env.get(name) ?? "").trim();
  const integrationEnabled = read("HITS_INTEGRATION_ENABLED") === "true";
  const checkinEnabled = read("HITS_CHECKIN_ENABLED") === "true";
  const timeoutRaw = read("HITS_REQUEST_TIMEOUT_MS");
  const timeoutN = Number(timeoutRaw);
  const requestTimeoutMs =
    Number.isFinite(timeoutN) && timeoutN >= 1000 && timeoutN <= 120_000
      ? Math.floor(timeoutN)
      : 12_000;
  const scopesRaw = read("HITS_AUTHORIZE_SCOPES");
  const scopes = scopesRaw
    ? scopesRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : ["WebCheckIn"];
  return {
    apiBaseUrl: (read("HITS_API_BASE_URL") || "https://api.hitspms.net").replace(/\/+$/, ""),
    sharedAccessSecret: read("HITS_SHARED_ACCESS_SECRET"),
    propertyId: read("HITS_PROPERTY_ID"),
    integrationEnabled,
    checkinEnabled: integrationEnabled && checkinEnabled,
    requestTimeoutMs,
    apiVersion: read("HITS_API_VERSION") || "1",
    tenantName: read("HITS_TENANT_NAME"),
    propertyCode: read("HITS_PROPERTY_CODE"),
    partnerUserId: read("HITS_PARTNER_USER_ID"),
    clientId: read("HITS_CLIENT_ID"),
    languageCode: read("HITS_LANGUAGE_CODE") || "pt-BR",
    scopes,
    authContractStatus: "verified",
    checkInBodyContractStatus: "unverified",
  };
}

function parseOptionalYmd(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function parsePositiveInt(v: unknown, max: number): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(max, Math.floor(n));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!(await authorize(req))) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const dryRun = body.dry_run !== false;
  const flags = getReservationSyncFlags(denoEnv());
  const dateFrom = parseOptionalYmd(body.date_from);
  const dateTo = parseOptionalYmd(body.date_to);
  const maxPages = parsePositiveInt(body.max_pages, MAX_PAGES_BODY_CAP) ?? 50;
  const maxReservations = parsePositiveInt(
    body.max_reservations,
    MAX_RESERVATIONS_BODY_CAP,
  );

  if (!flags.syncEnabled) {
    return json({ ok: false, error: "sync_disabled", dryRun, mode: flags.mode }, 403);
  }

  if (flags.mode === "real" && !flags.hitsIntegrationEnabled) {
    return json({ ok: false, error: "hits_real_blocked", dryRun, mode: flags.mode }, 403);
  }

  const resolved = resolveHitsReservationSource({
    flags,
    hitsConfig: hitsConfigFromDenoEnv(),
    mockPageSize: flags.batchSize,
    maxReservations,
  });
  if (!resolved.ok) {
    return json(
      {
        ok: false,
        error: resolved.error,
        message: resolved.message,
        dryRun,
        mode: flags.mode,
        source_kind: "real",
      },
      403,
    );
  }

  if (!dryRun) {
    if (!flags.schemaReady) {
      return json(
        { ok: false, error: "reservation_sync_schema_not_ready", dryRun: false },
        409,
      );
    }
    if (!flags.persistenceEnabled) {
      return json(
        { ok: false, error: "reservation_sync_persistence_disabled", dryRun: false },
        409,
      );
    }
    if (!supabaseUrl || !serviceRoleKey) {
      return json({ ok: false, error: "supabase_admin_unavailable" }, 503);
    }
  }

  const source = resolved.source;

  try {
    if (dryRun) {
      const repo = new InMemoryReservationSyncRepository(createEmptyMemorySyncState());
      const result = await syncReservationsFromSource({
        source,
        repo,
        flags,
        dryRun: true,
        maxPages,
        maxReservations,
        dateFrom,
        dateTo,
      });
      return json({
        ok: result.ok,
        mode: result.mode,
        source_kind: resolved.kind,
        dryRun: true,
        persistence: "dry_run_no_writes",
        date_from: dateFrom,
        date_to: dateTo,
        max_pages: maxPages,
        max_reservations: maxReservations,
        wouldCreate: result.created,
        wouldUpdate: result.updated,
        wouldCancel: result.cancelled,
        wouldCreateEvents: result.events,
        unchanged: result.unchanged,
        pages: result.pages,
        processed: result.processed,
        errors: result.errors,
        stopped_reason: result.stopped_reason ?? null,
        error: result.error ?? null,
      });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const repo = new SupabaseReservationSyncRepository(admin);
    const result = await syncReservationsFromSource({
      source,
      repo,
      flags,
      dryRun: false,
      maxPages,
      maxReservations,
      dateFrom,
      dateTo,
    });

    let fnrhNotify: {
      attempted: number;
      ok: number;
      failed: number;
    } | null = null;
    if (!dryRun && result.createdReservationIds.length > 0) {
      const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? serviceRoleKey;
      const baseUrl = resolveFnrhPublicBaseUrl({
        envValue: Deno.env.get("FNRH_PUBLIC_BASE_URL"),
      });
      const notify = await notifyFnrhLinksForCreatedReservations({
        supabaseUrl,
        serviceRoleKey,
        anonOrServiceKey: anonKey,
        reservaIds: result.createdReservationIds,
        baseUrl,
      });
      fnrhNotify = {
        attempted: notify.attempted,
        ok: notify.ok,
        failed: notify.failed,
      };
      if (notify.failed > 0) {
        console.warn(
          "[HITS_RESERVATION_SYNC] fnrh_notify_partial",
          JSON.stringify({
            attempted: notify.attempted,
            ok: notify.ok,
            failed: notify.failed,
            errors: notify.results
              .filter((r) => !r.ok)
              .map((r) => ({ reserva_id: r.reserva_id, error: r.error })),
          }),
        );
      }
    }

    const partial = result.errors > 0 && result.processed > result.errors;
    return json({
      ok: result.ok,
      partial: partial || undefined,
      mode: result.mode,
      source_kind: resolved.kind,
      dryRun: false,
      persistence: "supabase",
      date_from: dateFrom,
      date_to: dateTo,
      max_pages: maxPages,
      max_reservations: maxReservations,
      created: result.created,
      updated: result.updated,
      cancelled: result.cancelled,
      eventsCreated: result.events,
      unchanged: result.unchanged,
      pages: result.pages,
      processed: result.processed,
      errors: result.errors,
      stopped_reason: result.stopped_reason ?? null,
      error: result.error ?? null,
      fnrh_notify: fnrhNotify,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 200) : "error";
    console.error("[HITS_RESERVATION_SYNC]", msg);
    return json({ ok: false, error: "internal_error" }, 500);
  }
});
