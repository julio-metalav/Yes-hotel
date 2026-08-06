/**
 * Edge: sync manual de reservas HITS (mock).
 *
 * dry-run default → zero escrita, contadores would*.
 * Persistência Supabase só com:
 *   HITS_RESERVATION_SYNC_ENABLED=true
 *   HITS_RESERVATION_SYNC_PERSISTENCE_ENABLED=true
 *   HITS_RESERVATION_SCHEMA_READY=true
 *   dry_run=false
 *
 * Modo real bloqueado se HITS_INTEGRATION_ENABLED != true.
 * Sem cron. Sem rede HITS real nesta fase.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { HitsMockReservationSource } from "../../../src/lib/integrations/hits-mock/hits-mock-reservation-source.ts";
import {
  getReservationSyncFlags,
  syncReservationsFromSource,
} from "../../../src/lib/application/yes-hotel/reservation-sync-service.ts";
import {
  createEmptyMemorySyncState,
  InMemoryReservationSyncRepository,
} from "../../../src/lib/application/yes-hotel/reservation-sync-repository.ts";
import { SupabaseReservationSyncRepository } from "../../../src/lib/infrastructure/supabase/yes-hotel/supabase-reservation-sync-repository.ts";
import { constantTimeEqual } from "../../../src/lib/integrations/ttlock/access-ingest/constant-time.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-hits-sync-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const syncToken = (Deno.env.get("HITS_RESERVATION_SYNC_TOKEN") ?? "").trim();

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

  if (!flags.syncEnabled) {
    return json({ ok: false, error: "sync_disabled", dryRun, mode: flags.mode }, 403);
  }

  if (flags.mode === "real" && !flags.hitsIntegrationEnabled) {
    return json({ ok: false, error: "hits_real_blocked", dryRun, mode: flags.mode }, 403);
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

  const source = new HitsMockReservationSource({
    pageSize: flags.batchSize,
    scenario: "baseline",
  });

  try {
    if (dryRun) {
      const repo = new InMemoryReservationSyncRepository(createEmptyMemorySyncState());
      const result = await syncReservationsFromSource({
        source,
        repo,
        flags,
        dryRun: true,
      });
      return json({
        ok: result.ok,
        mode: result.mode,
        dryRun: true,
        persistence: "dry_run_no_writes",
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
    });

    const partial = result.errors > 0 && result.processed > result.errors;
    return json({
      ok: result.ok,
      partial: partial || undefined,
      mode: result.mode,
      dryRun: false,
      persistence: "supabase",
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
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 200) : "error";
    console.error("[HITS_RESERVATION_SYNC]", msg);
    return json({ ok: false, error: "internal_error" }, 500);
  }
});
