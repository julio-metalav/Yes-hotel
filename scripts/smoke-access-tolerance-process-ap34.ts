/**
 * Smoke homologação (NÃO CI): tolerância sintética no apto 34 (lock 16274746).
 * Marker: TESTE-TOLERANCE-PROCESS-AP34-20260813
 *
 * Prova cron mode=process → suspensão real na lock homologada → dispatch separado
 * → restore após regularização. Não usa reserva de hóspede. Não inclui portões.
 * Restaura/apaga a senha sintética ao final. Não altera senhas preexistentes.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getTtlockClient } from "../src/lib/integrations/ttlock/client.ts";
import { getTtlockConfig } from "../src/lib/integrations/ttlock/config.ts";
import type { TtlockKeyboardPwdListItem } from "../src/lib/integrations/ttlock/types.ts";

const PROJECT_REF = "minmmecajnmjqlgacfoz";
const MARKER = "TESTE-TOLERANCE-PROCESS-AP34-20260813";
const LOCK_ID = 16274746;
const APTO = "34";
const PROCESSOR_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/access-tolerance-processor`;
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

function snapshotMap(list: TtlockKeyboardPwdListItem[]): Map<number, { start?: number; end?: number; name?: string }> {
  const m = new Map<number, { start?: number; end?: number; name?: string }>();
  for (const p of list) {
    m.set(p.keyboardPwdId, {
      start: p.startDate,
      end: p.endDate,
      name: p.keyboardPwdName,
    });
  }
  return m;
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

async function main() {
  const cfg = getTtlockConfig();
  if (!cfg.hasCredentials) {
    throw new Error("TTLock local ausente — smoke físico requer credenciais TTLock no .env");
  }
  const { url, key } = loadServiceRole();
  const admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as Admin;
  const ttlock = getTtlockClient();

  const beforeList = await ttlock.listKeyboardPasswords({ lockId: LOCK_ID, pageSize: 100 });
  const beforeSnap = snapshotMap(beforeList);
  console.log(`lock ${LOCK_ID}: ${beforeList.length} senhas antes (nenhuma será reusada)`);

  const { data: fechadura, error: fErr } = await admin
    .from("fechaduras")
    .select("id")
    .eq("identificador_externo_ttlock", String(LOCK_ID))
    .maybeSingle();
  if (fErr || !fechadura?.id) throw new Error(`fechadura apto 34: ${fErr?.message ?? "ausente"}`);

  const now = Date.now();
  const validFrom = now - 60 * 60_000;
  const validUntil = now + 48 * 60 * 60_000;
  const pin = String(randomInt(100000, 999999));
  const created = await ttlock.createKeyboardPassword({
    lockId: LOCK_ID,
    keyboardPwd: pin,
    keyboardPwdName: MARKER,
    startDate: validFrom,
    endDate: validUntil,
  });
  const pwdId = created.keyboardPwdId;
  console.log(`senha sintética criada keyboardPwdId=${pwdId} (pin omitido)`);

  const reservaId = randomUUID();
  const credId = randomUUID();
  const itemId = randomUUID();
  const tolId = randomUUID();
  const dueIso = new Date(now - 5 * 60_000).toISOString();
  const fromIso = new Date(validFrom).toISOString();
  const untilIso = new Date(validUntil).toISOString();

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await admin.from("operacional_reservas").delete().eq("id", reservaId);
    } catch (e) {
      console.error("cleanup reserva:", e);
    }
    try {
      await ttlock.deleteKeyboardPassword({ lockId: LOCK_ID, keyboardPwdId: pwdId });
      console.log(`senha sintética ${pwdId} removida da lock`);
    } catch (e) {
      console.error("cleanup TTLock (remover senha sintética manualmente):", e);
    }
    const afterList = await ttlock.listKeyboardPasswords({ lockId: LOCK_ID, pageSize: 100 });
    for (const [id, prev] of beforeSnap) {
      const cur = afterList.find((p) => p.keyboardPwdId === id);
      if (!cur) {
        throw new Error(`senha preexistente ${id} sumiu — abortar e inspecionar lock 16274746`);
      }
      if (cur.startDate !== prev.start || cur.endDate !== prev.end) {
        throw new Error(
          `senha preexistente ${id} (${prev.name ?? "?"}) teve validade alterada — restaurar manualmente`,
        );
      }
    }
    if (afterList.some((p) => p.keyboardPwdId === pwdId)) {
      throw new Error(`senha sintética ${pwdId} ainda na lock após delete`);
    }
    console.log("senhas preexistentes da lock 16274746 inalteradas");
  };

  try {
    const { error: rErr } = await admin.from("operacional_reservas").insert({
      id: reservaId,
      apartamento: APTO,
      hospede_principal: MARKER,
      check_in_previsto: "2026-08-13",
      check_out_previsto: "2026-08-15",
      pagamento_status: "pendente",
      acesso_liberado: true,
      entrou_no_apto: true,
      origem_externa: "manual",
      external_reservation_id: MARKER,
      status_reserva: "ativa",
    });
    if (rErr) throw new Error(`reserva: ${rErr.message}`);

    const { error: cErr } = await admin.from("operacional_credenciais_acesso").insert({
      id: credId,
      reserva_id: reservaId,
      tipo_credencial: "principal",
      status: "provisionada",
      valido_de: fromIso,
      valido_ate: untilIso,
      motivo_origem: "checkin_normal",
      codigo_credencial: pin,
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
      status_provisionamento: "provisionado",
      remote_keyboard_pwd_id: pwdId,
    });
    if (iErr) throw new Error(`item: ${iErr.message}`);

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

    const afterSuspend = await ttlock.listKeyboardPasswords({ lockId: LOCK_ID, pageSize: 100 });
    const synth = afterSuspend.find((p) => p.keyboardPwdId === pwdId);
    if (!synth) throw new Error("senha sintética sumiu após suspend");
    if (synth.endDate == null || synth.endDate >= validUntil - 60_000) {
      throw new Error(`changeValidityOnly não encurtou endDate (ainda ${synth.endDate})`);
    }
    console.log(`H. TTLock endDate suspenso=${synth.endDate} (original ${validUntil})`);

    const { data: outboxSus } = await admin
      .from("operacional_acesso_outbox")
      .select("id, event_type, channel, status, idempotency_key")
      .eq("reservation_id", reservaId)
      .order("created_at", { ascending: true });
    const susKeys = (outboxSus ?? []).map((r) => r.idempotency_key);
    if (!susKeys.some((k) => String(k).includes(`tol:${tolId}:suspended`))) {
      throw new Error("outbox de suspensão ausente");
    }
    console.log("H. outbox suspensão:", outboxSus);

    const replay = await invokeProcess(key);
    console.log("J. replay process:", {
      process_count: replay.process_count,
      process_actions: replay.process_actions,
    });
    const { data: outboxReplay } = await admin
      .from("operacional_acesso_outbox")
      .select("id, idempotency_key")
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
          .select("id, event_type, channel, status, recipient_ref")
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

    const afterRestore = await ttlock.listKeyboardPasswords({ lockId: LOCK_ID, pageSize: 100 });
    const synthR = afterRestore.find((p) => p.keyboardPwdId === pwdId);
    if (!synthR) throw new Error("senha sintética sumiu após restore");
    if (synthR.endDate == null || Math.abs(synthR.endDate - validUntil) > 5_000) {
      throw new Error(`restore não devolveu endDate original (agora ${synthR.endDate})`);
    }
    console.log(`I. TTLock endDate restaurado=${synthR.endDate}`);

    const { data: outboxRes } = await admin
      .from("operacional_acesso_outbox")
      .select("id, event_type, channel, status, idempotency_key")
      .eq("reservation_id", reservaId)
      .like("idempotency_key", `tol:${tolId}:restored%`);
    if (!outboxRes?.length) throw new Error("outbox de restauração ausente");
    console.log("I. outbox restore:", outboxRes);

    await cleanup();
    console.log("Q. lock de teste: senha sintética removida; preexistentes intactas");
    console.log("VEREDITO: PROCESSAMENTO AUTOMÁTICO FUNCIONA EM HOMOLOGAÇÃO");
  } catch (e) {
    console.error(e);
    await cleanup();
    process.exit(1);
  }
}

main();
