/**
 * Edge: polling TTLock lockRecord/list → first-room-access.
 *
 * Auth: service_role Bearer OU x-access-tolerance-token (mesmo cron outbox).
 * Flag: YES_HOTEL_TTLOCK_ACCESS_POLL_ENABLED=true
 * NÃO processa histórico sem checkpoint (bootstrap = now).
 * Seed do lock 16274746 impede reprocessar evento 18:39:51 CG.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createSupabaseFirstRoomAccessPorts } from "../../../src/lib/infrastructure/supabase/yes-hotel/index.ts";
import { SupabaseTtlockPollCheckpointStore } from "../../../src/lib/infrastructure/supabase/yes-hotel/ttlock-poll-checkpoint-store.ts";
import {
  isTtlockAccessPollEnabled,
  runTtlockAccessPollBatch,
} from "../../../src/lib/integrations/ttlock/access-ingest/handle-poll.ts";
import { TtlockClient } from "../../../src/lib/integrations/ttlock/client.ts";
import { constantTimeEqual } from "../../../src/lib/integrations/ttlock/access-ingest/constant-time.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-access-tolerance-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
const processorToken = (Deno.env.get("ACCESS_TOLERANCE_PROCESSOR_TOKEN") ?? "").trim();

const TTLOCK_TOKEN_DEFAULT = "https://api.sciener.com/oauth2/token";
const TTLOCK_API_BASE_DEFAULT = "https://api.sciener.com";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function authorize(req: Request): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  if (auth.startsWith("Bearer ") && serviceRoleKey) {
    const t = auth.slice("Bearer ".length).trim();
    if (t && constantTimeEqual(t, serviceRoleKey)) return true;
  }
  if (processorToken) {
    const h = (req.headers.get("x-access-tolerance-token") ?? "").trim();
    if (h && constantTimeEqual(h, processorToken)) return true;
  }
  return false;
}

function buildTtlockClient(): TtlockClient {
  const clientId = (Deno.env.get("TTLOCK_CLIENT_ID") ?? "").trim();
  const clientSecret = (Deno.env.get("TTLOCK_CLIENT_SECRET") ?? "").trim();
  const username = (Deno.env.get("TTLOCK_USERNAME") ?? "").trim();
  const password = (Deno.env.get("TTLOCK_PASSWORD") ?? "").trim();
  let tokenUrl = (Deno.env.get("TTLOCK_TOKEN_URL") ?? "").trim() || TTLOCK_TOKEN_DEFAULT;
  let apiBaseUrl = (Deno.env.get("TTLOCK_API_BASE_URL") ?? "").trim() || TTLOCK_API_BASE_DEFAULT;
  tokenUrl = tokenUrl.replace(/euopen\.ttlock\.com/g, "api.sciener.com");
  apiBaseUrl = apiBaseUrl.replace(/\/+$/, "").replace(/euopen\.ttlock\.com/g, "api.sciener.com");
  const hasCredentials = !!(clientId && clientSecret && username && password);
  return new TtlockClient({
    config: {
      clientId,
      clientSecret,
      username,
      password,
      tokenUrl,
      apiBaseUrl,
      enabled: hasCredentials,
      hasCredentials,
    },
  });
}

function pollEnv(): Record<string, string | undefined> {
  const keys = [
    "YES_HOTEL_TTLOCK_ACCESS_POLL_ENABLED",
    "TTLOCK_ACCESS_IDEMPOTENCY_SECRET",
    "YES_HOTEL_PAGAMENTO_PRESENCIAL_DIFERIDO_ENABLED",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const out: Record<string, string | undefined> = {};
  for (const k of keys) out[k] = Deno.env.get(k) ?? undefined;
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!authorize(req)) return json({ ok: false, error: "unauthorized" }, 401);

  const env = pollEnv();
  if (!isTtlockAccessPollEnabled(env)) {
    return json({ ok: true, enabled: false, locks: 0, results: [] });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const limitLocks =
    typeof body.limitLocks === "number" && body.limitLocks > 0
      ? Math.min(50, Math.floor(body.limitLocks))
      : 50;

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const ports = createSupabaseFirstRoomAccessPorts(admin, env);
  const store = new SupabaseTtlockPollCheckpointStore(admin);
  const client = buildTtlockClient();

  if (!client.isAvailable()) {
    return json({ ok: false, error: "ttlock_credentials_missing" }, 500);
  }

  const batch = await runTtlockAccessPollBatch({
    client,
    ports,
    store,
    env,
    limitLocks,
  });

  const summary = {
    ok: true,
    enabled: batch.enabled,
    locks: batch.locks,
    totals: {
      fetched: batch.results.reduce((a, r) => a + r.fetched, 0),
      newer: batch.results.reduce((a, r) => a + r.newer, 0),
      processed: batch.results.reduce((a, r) => a + r.processed, 0),
      failed: batch.results.reduce((a, r) => a + r.failed, 0),
      skipped: batch.results.reduce((a, r) => a + r.skipped, 0),
    },
    results: batch.results.map((r) => ({
      lock_id: r.lock_id,
      fetched: r.fetched,
      newer: r.newer,
      processed: r.processed,
      failed: r.failed,
      skipped: r.skipped,
      watermark_before: r.watermark_before,
      watermark_after: r.watermark_after,
      bootstrapped: r.bootstrapped ?? false,
      results: r.results.map((x) => ({
        index: x.index,
        status: x.status,
        ignored_reason: x.ignored_reason,
        error: x.error,
        event_id: x.event_id,
        lockDate: x.lockDate,
      })),
    })),
  };

  console.log(
    "[TTLOCK_ACCESS_POLL]",
    JSON.stringify({
      enabled: summary.enabled,
      locks: summary.locks,
      totals: summary.totals,
    }),
  );

  return json(summary);
});
