/**
 * Diagnóstico read-only TTLock /v3/lockRecord/list.
 * Auth: ACCESS_TOLERANCE_PROCESSOR_TOKEN (mesmo do scheduler) ou service_role.
 * NÃO processa first access. NÃO retorna keyboardPwd em claro.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import md5 from "npm:md5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-access-tolerance-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const serviceRoleKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
const processorToken = (Deno.env.get("ACCESS_TOLERANCE_PROCESSOR_TOKEN") ?? "").trim();
const ttlockClientId = Deno.env.get("TTLOCK_CLIENT_ID") ?? "";
const ttlockClientSecret = Deno.env.get("TTLOCK_CLIENT_SECRET") ?? "";
const ttlockUsername = Deno.env.get("TTLOCK_USERNAME") ?? "";
const ttlockPassword = Deno.env.get("TTLOCK_PASSWORD") ?? "";
const TTLOCK_TOKEN_DEFAULT = "https://api.sciener.com/oauth2/token";
const TTLOCK_API_BASE_DEFAULT = "https://api.sciener.com";
const ttlockTokenUrl =
  (Deno.env.get("TTLOCK_TOKEN_URL") ?? "").trim() || TTLOCK_TOKEN_DEFAULT;
const ttlockApiBase = (
  (Deno.env.get("TTLOCK_API_BASE_URL") ?? "").trim() || TTLOCK_API_BASE_DEFAULT
).replace(/\/+$/, "");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function ctEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

function authorize(req: Request): boolean {
  const auth = req.headers.get("Authorization") ?? "";
  if (auth.startsWith("Bearer ") && serviceRoleKey) {
    const t = auth.slice(7).trim();
    if (t && ctEqual(t, serviceRoleKey)) return true;
  }
  if (processorToken) {
    const h = (req.headers.get("x-access-tolerance-token") ?? "").trim();
    if (h && ctEqual(h, processorToken)) return true;
  }
  return false;
}

function maskPwd(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v);
  if (s.length <= 2) return "***";
  return `${s.slice(0, 1)}${"*".repeat(Math.max(1, s.length - 2))}${s.slice(-1)}`;
}

async function getToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: ttlockClientId,
    client_secret: ttlockClientSecret,
    username: ttlockUsername,
    password: md5(ttlockPassword),
    grant_type: "password",
  });
  const res = await fetch(ttlockTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok || (data.errcode && data.errcode !== 0) || !data.access_token) {
    throw new Error(`token_failed:${data.errcode ?? res.status}:${data.errmsg ?? "no_token"}`);
  }
  return String(data.access_token);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!authorize(req)) return json({ ok: false, error: "unauthorized" }, 401);

  if (!ttlockClientId || !ttlockClientSecret || !ttlockUsername || !ttlockPassword) {
    return json({ ok: false, error: "ttlock_credentials_missing" }, 500);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const lockId = Number(body.lockId ?? 16274746);
  const startDate = Number(body.startDate ?? Date.parse("2026-08-11T22:35:00.000Z"));
  const endDate = Number(body.endDate ?? Date.parse("2026-08-11T22:43:00.000Z"));

  try {
    const token = await getToken();
    const form = new URLSearchParams({
      clientId: ttlockClientId,
      accessToken: token,
      lockId: String(lockId),
      startDate: String(startDate),
      endDate: String(endDate),
      pageNo: "1",
      pageSize: "100",
      date: String(Date.now()),
    });
    const res = await fetch(`${ttlockApiBase}/v3/lockRecord/list`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const data = await res.json();
    if (data.errcode && data.errcode !== 0) {
      return json({
        ok: false,
        error: "ttlock_api_error",
        errcode: data.errcode,
        errmsg: data.errmsg,
        apiBase: ttlockApiBase,
        clientId_prefix: ttlockClientId.slice(0, 4) + "…",
      }, 502);
    }

    const list = Array.isArray(data.list) ? data.list : [];
    const targetMs = Date.parse("2026-08-11T22:39:51.000Z");
    const records = list.map((r: Record<string, unknown>) => ({
      lockId: r.lockId ?? lockId,
      recordType: r.recordType,
      success: r.success,
      lockDate: r.lockDate,
      serverDate: r.serverDate,
      keyboardPwd_present: r.keyboardPwd != null && String(r.keyboardPwd).length > 0,
      keyboardPwd_masked: maskPwd(r.keyboardPwd),
      recordId: r.recordId ?? r.id ?? null,
    }));
    const match =
      records.find((r) => {
        const d = Number(r.lockDate);
        return Number.isFinite(d) && Math.abs(d - targetMs) <= 5000;
      }) ?? null;

    // touch createClient so jsr import stays used if bundler tree-shakes
    void createClient;

    return json({
      ok: true,
      apiBase: ttlockApiBase,
      clientId_prefix: ttlockClientId.slice(0, 4) + "…",
      lockId,
      startDate,
      endDate,
      records_count: records.length,
      found_target_183951: Boolean(match),
      match,
      records,
    });
  } catch (e) {
    return json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      apiBase: ttlockApiBase,
    }, 500);
  }
});
