/**
 * Edge: prévia somente leitura das reservas do HITS Sandbox pelo gateway.
 *
 * Só GET. Nenhuma escrita: não persiste no Supabase, não chama HITS direto,
 * não dispara DigiSac, e-mail, TTLock, senha nem cobrança.
 *
 * O Bearer do gateway vive apenas aqui (Deno.env). O navegador autentica com o
 * próprio JWT do usuário (verify_jwt default = true) e nunca vê o token.
 *
 * Env: HITS_GATEWAY_URL, HITS_GATEWAY_TOKEN, HITS_GATEWAY_READ_ENABLED,
 *      HITS_GATEWAY_TIMEOUT_MS (opcional).
 */
import {
  fetchHitsSandboxReservations,
  getHitsGatewayReadConfig,
  assertHitsGatewayReadReady,
  hitsGatewayReadStatus,
} from "../../../src/lib/integrations/hits/hits-gateway-read.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseYmd(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function parseInt0(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function denoEnv(): Record<string, string | undefined> {
  const keys = [
    "HITS_GATEWAY_URL",
    "HITS_GATEWAY_TOKEN",
    "HITS_GATEWAY_READ_ENABLED",
    "HITS_GATEWAY_TIMEOUT_MS",
  ];
  const env: Record<string, string | undefined> = {};
  for (const k of keys) env[k] = Deno.env.get(k) ?? undefined;
  return env;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  const config = getHitsGatewayReadConfig(denoEnv());
  const gate = assertHitsGatewayReadReady(config);
  if (!gate.ok) {
    return json(
      {
        ok: false,
        error: gate.reason,
        message: gate.message,
        gateway: hitsGatewayReadStatus(config),
      },
      gate.reason === "gateway_read_disabled" ? 403 : 503,
    );
  }

  const url = new URL(req.url);
  const idsRaw = (url.searchParams.get("ids") ?? "").trim();
  const reservationIds = idsRaw
    ? idsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  try {
    const result = await fetchHitsSandboxReservations({
      config: gate.config,
      dateFrom: parseYmd(url.searchParams.get("date_from")),
      dateTo: parseYmd(url.searchParams.get("date_to")),
      page: parseInt0(url.searchParams.get("page")),
      size: parseInt0(url.searchParams.get("size")),
      reservationIds,
    });

    return json({
      ok: true,
      read_only: true,
      source: "hits_gateway",
      page: result.page,
      size: result.size,
      count: result.rows.length,
      rows: result.rows,
      failed: result.failed,
    });
  } catch (e) {
    // Mensagem já sanitizada pelo HitsError; corta o resto por segurança.
    const msg = e instanceof Error ? e.message.slice(0, 200) : "erro";
    console.error("[HITS_RESERVATIONS_PREVIEW] falha de leitura");
    return json({ ok: false, error: "gateway_read_failed", message: msg }, 502);
  }
});
