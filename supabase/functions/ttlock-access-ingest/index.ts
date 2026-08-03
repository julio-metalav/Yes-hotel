/**
 * Edge: TTLock Lock Records Notify → ingestão de primeiro acesso.
 *
 * - Resposta compatível: corpo texto "success" (doc TTLock).
 * - Feature flag YES_HOTEL_TTLOCK_ACCESS_INGEST_ENABLED (default off).
 * - Sem JWT gateway (verify_jwt=false só nesta Edge); auth via TTLOCK_ACCESS_WEBHOOK_SECRET.
 * - Flag off: ack sem revelar se o segredo está correto; sem persistir/processar.
 * - Flag on: rejeita sem segredo válido.
 * - NÃO chama TTLock API, DigiSac, Resend, suspensão ou polling.
 *
 * PR3: não deployar / não configurar Callback URL na TTLock.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createSupabaseFirstRoomAccessPorts } from "../../../src/lib/infrastructure/supabase/yes-hotel/index.ts";
import {
  buildSafeIngestLog,
  handleTtlockAccessIngest,
  TTLOCK_NOTIFY_SUCCESS_BODY,
} from "../../../src/lib/integrations/ttlock/access-ingest/index.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-yes-hotel-ttlock-webhook-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function denoEnv(): Record<string, string | undefined> {
  const keys = [
    "YES_HOTEL_TTLOCK_ACCESS_INGEST_ENABLED",
    "TTLOCK_ACCESS_WEBHOOK_SECRET",
    "TTLOCK_ACCESS_IDEMPOTENCY_SECRET",
    "TTLOCK_ACCESS_WEBHOOK_IP_ALLOWLIST",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const out: Record<string, string | undefined> = {};
  for (const k of keys) out[k] = Deno.env.get(k) ?? undefined;
  return out;
}

function clientIp(req: Request): string | null {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    null
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const env = denoEnv();
  const rawText = req.method === "POST" ? await req.text() : "";
  let body: unknown = rawText;
  if (rawText) {
    try {
      body = JSON.parse(rawText);
    } catch {
      body = rawText;
    }
  }

  const enabled = env.YES_HOTEL_TTLOCK_ACCESS_INGEST_ENABLED === "true";
  let ports = null;
  if (enabled) {
    const url = env.SUPABASE_URL;
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    if (url && key) {
      const admin = createClient(url, key, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      ports = createSupabaseFirstRoomAccessPorts(admin);
    }
  }

  const result = await handleTtlockAccessIngest(
    {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
      rawByteLength: new TextEncoder().encode(rawText).length,
      clientIp: clientIp(req),
      env,
    },
    ports,
  );

  const safeLog = buildSafeIngestLog(result.meta);
  console.log("[TTLOCK_ACCESS_INGEST]", JSON.stringify(safeLog));

  return new Response(result.bodyText || TTLOCK_NOTIFY_SUCCESS_BODY, {
    status: result.status,
    headers: {
      ...corsHeaders,
      "Content-Type": result.contentType || "text/plain; charset=utf-8",
    },
  });
});
