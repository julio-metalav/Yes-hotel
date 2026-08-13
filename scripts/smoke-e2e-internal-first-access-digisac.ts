/**
 * Smoke controlado: SOMENTE notificação DigiSac interna (não reprocessa first access).
 * Marker: TESTE-E2E-INTERNAL-FIRST-ACCESS-DIGISAC
 *
 * Não altera entrou_no_apto, welcome do hóspede, senha ou TTLock.
 */
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const PROJECT_REF = "minmmecajnmjqlgacfoz";
const RESERVA = "46b86846-7af7-46e2-8279-2ac1da8a10ee";
const MARKER = "TESTE-E2E-INTERNAL-FIRST-ACCESS-DIGISAC";
const BODY =
  "[TESTE YES HOTEL] Primeiro acesso registrado — apto 35 — Julio Cesar Teste Final. Pagamento: pago. FNRH: concluída. Este é um teste da notificação interna.";

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

async function main() {
  const { url, key } = loadServiceRole();
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const idem = `${MARKER}:${randomUUID()}`;
  const nowIso = new Date().toISOString();
  const schedulerToken = String(process.env.ACCESS_TOLERANCE_PROCESSOR_TOKEN || "").trim();

  const { data: row, error: insErr } = await client
    .from("operacional_acesso_outbox")
    .insert({
      event_type: "internal_first_access",
      channel: "whatsapp",
      reservation_id: RESERVA,
      credential_id: null,
      access_event_id: null,
      tolerance_id: null,
      recipient_ref: null,
      template: "internal_first_access",
      payload: {
        body: BODY,
        simulation_marker: MARKER,
      },
      idempotency_key: idem,
      status: "pending",
      attempts: 0,
      available_at: nowIso,
      processed_at: null,
      last_error: null,
    })
    .select("id, idempotency_key, status")
    .single();
  if (insErr || !row?.id) throw new Error(`enqueue: ${insErr?.message}`);

  await client.from("operacional_reserva_eventos").insert({
    reserva_id: RESERVA,
    tipo: "teste_e2e_internal_digisac",
    titulo: "Smoke DigiSac internal first access",
    detalhe: JSON.stringify({ marker: MARKER, outbox_id: row.id, idem }),
  });

  // Preferir token do scheduler (env); senão tenta service_role; senão aguarda cron.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: key,
  };
  if (schedulerToken) {
    headers["x-access-tolerance-token"] = schedulerToken;
    headers.Authorization = `Bearer ${key}`;
  } else {
    headers.Authorization = `Bearer ${key}`;
  }
  const dispatchRes = await fetch(`${url}/functions/v1/access-tolerance-processor`, {
    method: "POST",
    headers,
    body: JSON.stringify({ mode: "dispatch", limit: 20, dry_run: false }),
  });
  const dispatchBody = (await dispatchRes.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  let final = null as Record<string, unknown> | null;
  for (let i = 0; i < 18; i++) {
    const { data } = await client
      .from("operacional_acesso_outbox")
      .select(
        "id, status, recipient_ref, attempts, last_error, processed_at, payload, idempotency_key",
      )
      .eq("id", row.id)
      .maybeSingle();
    final = (data as Record<string, unknown>) || null;
    if (final && (final.status === "sent" || final.status === "failed")) break;
    await new Promise((r) => setTimeout(r, 10000));
  }

  const payload = (final?.payload || {}) as Record<string, unknown>;
  console.log(
    JSON.stringify(
      {
        marker: MARKER,
        outbox_id: row.id,
        idempotency_key: idem,
        dispatch_http: dispatchRes.status,
        dispatch_ok: dispatchBody.ok ?? null,
        dispatch_count: dispatchBody.dispatch_count ?? null,
        status: final?.status ?? null,
        recipient_ref: final?.recipient_ref ?? null,
        provider_message_id: payload.provider_message_id ?? null,
        provider_accept: payload.provider_accept ?? null,
        destination_kind: payload.destination_kind ?? null,
        destination_masked: payload.destination_masked ?? null,
        last_error: final?.last_error ?? null,
        processed_at: final?.processed_at ?? null,
        note:
          "sent = aceite API DigiSac; Julio valida visualmente no DigiSac (67 2180-0225).",
      },
      null,
      2,
    ),
  );

  if (!final || final.status !== "sent") {
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error("[smoke-internal-digisac] FALHOU:", e instanceof Error ? e.message : e);
  process.exit(1);
});
