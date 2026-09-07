/**
 * Smoke operacional (não CI): simula 1º acesso da reserva E2E via orquestração oficial
 * processFirstRoomAccessEvent → RPC → outbox → access-tolerance-processor (dispatch).
 *
 * Marker: TESTE-E2E-SIMULATED-FIRST-ACCESS
 * Não altera credencial/senha. Não comitar resultado sensível.
 */
import { createClient } from "@supabase/supabase-js";
import { processFirstRoomAccessEvent } from "../src/lib/application/yes-hotel/first-room-access-orchestrator.ts";
import { createSupabaseFirstRoomAccessPorts } from "../src/lib/infrastructure/supabase/yes-hotel/index.ts";
import { ACCESS_EVENT_SOURCE_NOTIFY } from "../src/lib/integrations/ttlock/access-ingest/constants.ts";
import { execSync } from "node:child_process";

const RESERVA_ID = "46b86846-7af7-46e2-8279-2ac1da8a10ee";
const MARKER = "TESTE-E2E-SIMULATED-FIRST-ACCESS";
const PROJECT_REF = "minmmecajnmjqlgacfoz";
const LOCK_ID = 13380336; // APT-35
/** lockDate fixo → mesma idempotency_key no replay */
const LOCK_DATE_MS = Date.parse("2026-08-13T03:10:00.000Z");
const RECORD_TYPE = 4;
const SUCCESS = 1;

function loadServiceRole(): { url: string; key: string } {
  const raw = execSync(
    `npx supabase projects api-keys --project-ref ${PROJECT_REF} --reveal -o json`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const keys = JSON.parse(raw) as Array<{ name?: string; api_key?: string }>;
  const service = keys.find((k) => k.name === "service_role");
  if (!service?.api_key) throw new Error("service_role ausente");
  return { url: `https://${PROJECT_REF}.supabase.co`, key: service.api_key };
}

function buildIds() {
  const source_event_id = `ttlock_notify:${LOCK_ID}:${LOCK_DATE_MS}:${RECORD_TYPE}:${SUCCESS}:0`;
  const idempotency_key = `sim:${MARKER}:${LOCK_ID}:${LOCK_DATE_MS}:${RECORD_TYPE}:${SUCCESS}`;
  return { source_event_id, idempotency_key };
}

async function runOnce(
  ports: ReturnType<typeof createSupabaseFirstRoomAccessPorts>,
  pwd: string,
  label: string,
) {
  const { source_event_id, idempotency_key } = buildIds();
  const occurred_at = new Date(LOCK_DATE_MS).toISOString();
  const out = await processFirstRoomAccessEvent(
    {
      source: ACCESS_EVENT_SOURCE_NOTIFY,
      source_event_id,
      idempotency_key,
      occurred_at,
      lock_id: LOCK_ID,
      record_type: RECORD_TYPE,
      success: SUCCESS === 1,
      raw_payload_sanitized: {
        lockId: LOCK_ID,
        simulation_marker: MARKER,
        record: {
          recordType: RECORD_TYPE,
          success: SUCCESS,
          lockDate: LOCK_DATE_MS,
          index: 0,
          username_masked: "T***S",
        },
      },
    },
    ports,
    { ephemeral_keyboard_pwd: pwd },
  );
  console.log(
    JSON.stringify({
      step: label,
      status: out.status,
      event_id: out.event_id ?? null,
      ignored_reason: out.ignored_reason ?? null,
    }),
  );
  return out;
}

async function dispatchOutbox(url: string, key: string) {
  const res = await fetch(`${url}/functions/v1/access-tolerance-processor`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      apikey: key,
    },
    body: JSON.stringify({ mode: "dispatch", limit: 20, dry_run: false }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  console.log(
    JSON.stringify({
      step: "dispatch",
      http: res.status,
      ok: body.ok,
      dispatch_count: body.dispatch_count ?? body.dispatched ?? null,
      error: body.error ?? null,
      keys: Object.keys(body),
    }),
  );
  return body;
}

async function audit(client: ReturnType<typeof createClient>) {
  const { data: reserva } = await client
    .from("operacional_reservas")
    .select("entrou_no_apto, acesso_liberado, pagamento_status")
    .eq("id", RESERVA_ID)
    .maybeSingle();

  const { data: events } = await client
    .from("operacional_acesso_eventos")
    .select(
      "id, source, source_event_id, processing_status, ignored_reason, occurred_at, lock_id, raw_payload_sanitized, reservation_id",
    )
    .eq("reservation_id", RESERVA_ID)
    .order("received_at", { ascending: false })
    .limit(5);

  const { data: outbox } = await client
    .from("operacional_acesso_outbox")
    .select("id, event_type, channel, status, idempotency_key, processed_at, last_error, payload")
    .eq("reservation_id", RESERVA_ID)
    .order("available_at", { ascending: false })
    .limit(20);

  const { data: envios } = await client
    .from("operacional_comunicacao_envios")
    .select("canal, status, created_at")
    .eq("reserva_id", RESERVA_ID)
    .gte("created_at", "2026-08-13T03:00:00.000Z")
    .order("created_at", { ascending: false })
    .limit(10);

  const { data: apt } = await client
    .from("apartamentos")
    .select("wifi_ssid, wifi_password")
    .eq("numero", "35")
    .maybeSingle();

  const welcomeRows = (outbox ?? []).filter((o) =>
    String(o.event_type).includes("guest_first_access_welcome"),
  );
  const wifiInPayload = welcomeRows.some((o) => {
    const p = o.payload as { body?: string; body_html?: string } | null;
    const body = `${p?.body ?? ""}\n${p?.body_html ?? ""}`;
    return body.includes("35") && body.includes(String(apt?.wifi_password ?? ""));
  });

  console.log(
    JSON.stringify(
      {
        step: "audit",
        reserva,
        events_count: (events ?? []).length,
        events: (events ?? []).map((e) => ({
          id: e.id,
          status: e.processing_status,
          ignored: e.ignored_reason,
          lock_id: e.lock_id,
          occurred_at: e.occurred_at,
          marker:
            e.raw_payload_sanitized &&
            typeof e.raw_payload_sanitized === "object" &&
            (e.raw_payload_sanitized as { simulation_marker?: string }).simulation_marker,
        })),
        outbox_welcome: welcomeRows.map((o) => ({
          channel: o.channel,
          status: o.status,
          idempotency_key: o.idempotency_key,
          processed_at: o.processed_at,
          last_error: o.last_error,
        })),
        outbox_other: (outbox ?? [])
          .filter((o) => !String(o.event_type).includes("guest_first_access_welcome"))
          .map((o) => ({
            event_type: o.event_type,
            channel: o.channel,
            status: o.status,
            idempotency_key: o.idempotency_key,
          })),
        wifi_ssid: apt?.wifi_ssid ?? null,
        wifi_password_present: Boolean(apt?.wifi_password),
        wifi_in_welcome_payload: wifiInPayload,
        envios_pos_sim: envios ?? [],
      },
      null,
      2,
    ),
  );
}

async function main() {
  const { url, key } = loadServiceRole();
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: cred, error: credErr } = await client
    .from("operacional_credenciais_acesso")
    .select("id, codigo_credencial")
    .eq("reserva_id", RESERVA_ID)
    .eq("tipo_credencial", "principal")
    .maybeSingle();
  if (credErr || !cred?.codigo_credencial) {
    throw new Error("Credencial/código ausente para correlação");
  }
  const pwd = String(cred.codigo_credencial);
  console.log(
    JSON.stringify({
      step: "prep",
      reserva: RESERVA_ID,
      lock_id: LOCK_ID,
      credencial_id: cred.id,
      has_pwd: pwd.length > 0,
      marker: MARKER,
    }),
  );

  const ports = createSupabaseFirstRoomAccessPorts(client, {
    YES_HOTEL_PAGAMENTO_PRESENCIAL_DIFERIDO_ENABLED: "true",
  });

  await runOnce(ports, pwd, "first_run");
  await dispatchOutbox(url, key);
  await audit(client);

  await runOnce(ports, pwd, "replay");
  await dispatchOutbox(url, key);
  await audit(client);

  await client.from("operacional_reserva_eventos").insert({
    reserva_id: RESERVA_ID,
    tipo: "teste_e2e_simulated_first_access",
    titulo: "Simulação controlada de primeiro acesso",
    detalhe: JSON.stringify({
      marker: MARKER,
      lock_id: LOCK_ID,
      source: ACCESS_EVENT_SOURCE_NOTIFY,
      note: "software path; not physical TTLock gateway",
    }),
  });
}

main().catch((e) => {
  console.error("[smoke-e2e-simulate-first-access] FALHOU:", e instanceof Error ? e.message : e);
  process.exit(1);
});
