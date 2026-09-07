/**
 * Smoke homologação (NÃO CI): tolerância sintética no apto 34 (lock 16274746).
 * Marker: TESTE-TOLERANCE-PROCESS-AP34-20260813
 *
 * Provisiona/revoga a senha sintética via Edge yes-hotel-lifecycle (creds TTLock do servidor).
 * Não usa reserva/senha do Breno. Não inclui portões.
 * Efeito físico é o contrato do processador: só marca succeeded após changeValidityOnly OK.
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const PROJECT_REF = "minmmecajnmjqlgacfoz";
const MARKER = "TESTE-TOLERANCE-PROCESS-AP34-20260813";
const LOCK_ID = 16274746;
const APTO = "34";
const BRENO_ITEM_ID = "82bb614a-aab0-4123-99f7-270b16cc40b2";
const BRENO_PWD_ID = 104041356;
const PROCESSOR_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/access-tolerance-processor`;
const LIFECYCLE_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/yes-hotel-lifecycle`;
const CRON_WAIT_MS = 150_000;
const POLL_MS = 10_000;

type Admin = SupabaseClient;

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

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitUntil<T>(
  label: string,
  fn: () => Promise<T | null>,
  timeoutMs: number,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = await fn();
    if (v != null) return v;
    await sleep(POLL_MS);
  }
  throw new Error(`timeout aguardando ${label} (${timeoutMs}ms)`);
}

async function invokeProcess(key: string): Promise<Record<string, unknown>> {
  const res = await fetch(PROCESSOR_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      apikey: key,
    },
    body: JSON.stringify({ mode: "process", limit: 20, dry_run: false }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`processor HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function invokeLifecycle(
  key: string,
  action: string,
  reservaId: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(LIFECYCLE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      apikey: key,
      "x-yes-internal-caller": "send-senha",
    },
    body: JSON.stringify({ action, reservaId }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`lifecycle ${action} HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function readBrenoItem(admin: Admin) {
  const { data, error } = await admin
    .from("operacional_credencial_itens")
    .select("id, remote_keyboard_pwd_id, status_provisionamento, updated_at")
    .eq("id", BRENO_ITEM_ID)
    .maybeSingle();
  if (error || !data) throw new Error(`item Breno: ${error?.message ?? "ausente"}`);
  return data;
}

async function main() {
  const { url, key } = loadServiceRole();
  const admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as Admin;

  const brenoBefore = await readBrenoItem(admin);
  if (Number(brenoBefore.remote_keyboard_pwd_id) !== BRENO_PWD_ID) {
    throw new Error("item Breno mudou de keyboardPwdId — abortar smoke");
  }

  const { data: fechadura, error: fErr } = await admin
    .from("fechaduras")
    .select("id")
    .eq("identificador_externo_ttlock", String(LOCK_ID))
    .maybeSingle();
  if (fErr || !fechadura?.id) throw new Error(`fechadura apto 34: ${fErr?.message ?? "ausente"}`);

  const now = Date.now();
  const validFrom = now - 60 * 60_000;
  const validUntil = now + 48 * 60 * 60_000;
  const fromIso = new Date(validFrom).toISOString();
  const untilIso = new Date(validUntil).toISOString();
  const dueIso = new Date(now - 5 * 60_000).toISOString();

  const reservaId = randomUUID();
  const credId = randomUUID();
  const itemId = randomUUID();
  const tolId = randomUUID();

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await invokeLifecycle(key, "lifecycle_cancel", reservaId);
      console.log("lifecycle_cancel: senha sintética revogada no TTLock");
    } catch (e) {
      console.error("cleanup lifecycle_cancel:", e instanceof Error ? e.message : e);
    }
    try {
      await admin.from("operacional_reservas").delete().eq("id", reservaId);
    } catch (e) {
      console.error("cleanup reserva:", e);
    }
    const brenoAfter = await readBrenoItem(admin);
    if (Number(brenoAfter.remote_keyboard_pwd_id) !== BRENO_PWD_ID) {
      throw new Error("senha do Breno teve keyboardPwdId alterado");
    }
    if (brenoAfter.status_provisionamento !== brenoBefore.status_provisionamento) {
      throw new Error("status do item Breno mudou");
    }
    console.log("Q. item Breno intacto (keyboardPwdId e status)");
  };

  try {
    const { error: rErr } = await admin.from("operacional_reservas").insert({
      id: reservaId,
      apartamento: APTO,
      hospede_principal: MARKER,
      check_in_previsto: "2026-08-13",
      check_out_previsto: "2026-08-15",
      pagamento_status: "pendente",
      acesso_liberado: false,
      entrou_no_apto: false,
      origem_externa: "manual",
      external_reservation_id: MARKER,
      status_reserva: "ativa",
    });
    if (rErr) throw new Error(`reserva: ${rErr.message}`);

    const guestId = randomUUID();
    const { error: gErr } = await admin.from("operacional_hospedes").insert({
      id: guestId,
      reserva_id: reservaId,
      nome: MARKER,
      principal: true,
      email: "",
      whatsapp: "",
      guest_role: "primary_adult",
      fnrh_required: false,
      requires_classification: false,
    });
    if (gErr) throw new Error(`hospede: ${gErr.message}`);

    const { data: fnrh } = await admin
      .from("fnrh_hospedes")
      .select("id")
      .eq("reserva_id", reservaId)
      .eq("hospede_id", guestId)
      .maybeSingle();
    if (fnrh?.id) {
      const { error: fUpd } = await admin
        .from("fnrh_hospedes")
        .update({
          status: "confirmado_hospede",
          fnrh_lifecycle_status: "waived",
          waived_reason: MARKER,
          completed_by_user_id: guestId,
        })
        .eq("id", fnrh.id);
      if (fUpd) throw new Error(`fnrh waive: ${fUpd.message}`);
    }

    const { error: cErr } = await admin.from("operacional_credenciais_acesso").insert({
      id: credId,
      reserva_id: reservaId,
      tipo_credencial: "principal",
      status: "pendente",
      valido_de: fromIso,
      valido_ate: untilIso,
      motivo_origem: "checkin_normal",
      provider_tipo: "ttlock_passcode",
    });
    if (cErr) throw new Error(`credencial: ${cErr.message}`);

    const { error: iErr } = await admin.from("operacional_credencial_itens").insert({
      id: itemId,
      credencial_id: credId,
      fechadura_id: fechadura.id,
      lock_id_ttlock: String(LOCK_ID),
      tipo_destino: "apartamento",
      codigo_logico_destino: "APT-34",
      status_provisionamento: "pendente",
    });
    if (iErr) throw new Error(`item: ${iErr.message}`);

    const provision = await invokeLifecycle(key, "lifecycle_provision", reservaId);
    console.log("provision:", {
      ok: provision.ok,
      status: provision.status,
      provisionados: provision.provisionados,
    });

    const { data: itemRow, error: itemReadErr } = await admin
      .from("operacional_credencial_itens")
      .select("remote_keyboard_pwd_id, status_provisionamento")
      .eq("id", itemId)
      .maybeSingle();
    if (itemReadErr || !itemRow?.remote_keyboard_pwd_id) {
      throw new Error(
        `provision sem remote_keyboard_pwd_id: ${itemReadErr?.message ?? itemRow?.status_provisionamento}`,
      );
    }
    const pwdId = Number(itemRow.remote_keyboard_pwd_id);
    if (pwdId === BRENO_PWD_ID) throw new Error("provision reusou keyboardPwdId do Breno");
    console.log(`senha sintética keyboardPwdId=${pwdId} (só lock ${LOCK_ID})`);
    console.log("aguardando 60s para a senha gateway sincronizar na fechadura");
    await sleep(60_000);

    const { error: tErr } = await admin.from("operacional_acesso_tolerancias").insert({
      id: tolId,
      reservation_id: reservaId,
      credential_id: credId,
      first_room_access_at: fromIso,
      grace_started_at: fromIso,
      suspension_due_at: dueIso,
      grace_status: "active",
      grace_mode: "standard_1h",
      pending_payment_at_start: true,
      pending_fnrh_at_start: false,
      current_payment_pending: true,
      current_fnrh_pending: false,
      pending_snapshot: ["pagamento"],
      original_valid_from: fromIso,
      original_valid_until: untilIso,
    });
    if (tErr) throw new Error(`tolerancia: ${tErr.message}`);

    const { error: tiErr } = await admin.from("operacional_acesso_tolerancia_itens").insert({
      tolerance_id: tolId,
      credential_item_id: itemId,
      logical_destination: "APT-34",
      lock_id: LOCK_ID,
      remote_keyboard_pwd_id: pwdId,
      original_valid_from: fromIso,
      original_valid_until: untilIso,
      suspension_status: "pending",
      restore_status: "not_applicable",
    });
    if (tiErr) throw new Error(`tolerancia item: ${tiErr.message}`);

    console.log(`tolerância ${tolId} due=${dueIso} — aguardando cron process`);

    const suspended = await waitUntil(
      "grace_status=suspended via cron",
      async () => {
        const { data } = await admin
          .from("operacional_acesso_tolerancias")
          .select("grace_status, suspended_at, last_error")
          .eq("id", tolId)
          .maybeSingle();
        if (data?.grace_status === "suspended") return data;
        if (data?.grace_status === "error" || data?.grace_status === "partial_failure") {
          throw new Error(`processador falhou: ${data.grace_status} ${data.last_error ?? ""}`);
        }
        return null;
      },
      CRON_WAIT_MS,
    );
    console.log("H. suspensão:", suspended);

    const { data: susItem } = await admin
      .from("operacional_acesso_tolerancia_itens")
      .select("suspension_status, suspended_valid_until, last_error")
      .eq("tolerance_id", tolId)
      .eq("lock_id", LOCK_ID)
      .maybeSingle();
    if (susItem?.suspension_status !== "succeeded") {
      throw new Error(`changeValidityOnly não confirmou: ${JSON.stringify(susItem)}`);
    }
    console.log("H. item homologado succeeded (TTLock confirmou changeValidityOnly)");

    const { data: outboxSus } = await admin
      .from("operacional_acesso_outbox")
      .select("id, event_type, channel, status, idempotency_key")
      .eq("reservation_id", reservaId)
      .order("created_at", { ascending: true });
    if (!(outboxSus ?? []).some((r) => String(r.idempotency_key).includes(`tol:${tolId}:suspended`))) {
      throw new Error("outbox de suspensão ausente");
    }
    console.log("H. outbox suspensão count=", outboxSus?.length);

    const replay = await invokeProcess(key);
    console.log("J. replay process_count=", replay.process_count);
    const { data: outboxReplay } = await admin
      .from("operacional_acesso_outbox")
      .select("id")
      .eq("reservation_id", reservaId);
    if ((outboxReplay ?? []).length !== (outboxSus ?? []).length) {
      throw new Error(
        `replay duplicou outbox: ${outboxSus?.length ?? 0} → ${outboxReplay?.length ?? 0}`,
      );
    }
    console.log("J. idempotência: outbox sem duplicata");

    const dispatched = await waitUntil(
      "dispatch internal_alert sent",
      async () => {
        const { data } = await admin
          .from("operacional_acesso_outbox")
          .select("id, event_type, channel, status")
          .eq("reservation_id", reservaId)
          .eq("event_type", "internal_alert")
          .eq("channel", "whatsapp")
          .maybeSingle();
        if (data?.status === "sent") return data;
        return null;
      },
      CRON_WAIT_MS,
    );
    console.log("K. dispatch interno:", dispatched);

    const { error: payErr } = await admin
      .from("operacional_reservas")
      .update({ pagamento_status: "pago" })
      .eq("id", reservaId);
    if (payErr) throw new Error(`regularizar: ${payErr.message}`);
    console.log("I. pagamento sintético=pago — aguardando cron restore");

    const restored = await waitUntil(
      "grace_status=restored via cron",
      async () => {
        const { data } = await admin
          .from("operacional_acesso_tolerancias")
          .select("grace_status, restored_at, last_error")
          .eq("id", tolId)
          .maybeSingle();
        if (data?.grace_status === "restored") return data;
        if (data?.grace_status === "error") {
          throw new Error(`restore falhou: ${data.last_error ?? ""}`);
        }
        return null;
      },
      CRON_WAIT_MS,
    );
    console.log("I. restauração:", restored);

    const { data: resItem } = await admin
      .from("operacional_acesso_tolerancia_itens")
      .select("restore_status, last_error")
      .eq("tolerance_id", tolId)
      .eq("lock_id", LOCK_ID)
      .maybeSingle();
    if (resItem?.restore_status !== "succeeded") {
      throw new Error(`restore TTLock não confirmou: ${JSON.stringify(resItem)}`);
    }

    const { data: outboxRes } = await admin
      .from("operacional_acesso_outbox")
      .select("id, event_type, channel, status, idempotency_key")
      .eq("reservation_id", reservaId)
      .like("idempotency_key", `tol:${tolId}:restored%`);
    if (!outboxRes?.length) throw new Error("outbox de restauração ausente");
    console.log("I. outbox restore count=", outboxRes.length);

    await cleanup();
    console.log("VEREDITO: PROCESSAMENTO AUTOMÁTICO FUNCIONA EM HOMOLOGAÇÃO");
  } catch (e) {
    console.error(e);
    await cleanup();
    process.exit(1);
  }
}

main();
