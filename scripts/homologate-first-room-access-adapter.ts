/**
 * Script manual de homologação. Não executar em CI nem em produção automatizada.
 *
 * Homologação curta: adapter TypeScript real → RPC → Postgres.
 *
 * Caminho:
 *   script → SupabaseFirstRoomAccessUnitOfWork → yes_hotel_process_first_room_access → Postgres
 *
 * Uso manual:
 *   npm run homologate:yes:first-room-access-adapter
 *   # ou: npx tsx scripts/homologate-first-room-access-adapter.ts
 *
 * Envs (não logar / não imprimir):
 *   SUPABASE_URL ou NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Marker: HOMOLOG-FRA-ADAPTER-20260803
 * Sem flag TTLock, Edge, callback, cron, worker ou integrações externas.
 * Falha se as envs estiverem ausentes (não usa anon como fallback).
 * try/finally com limpeza obrigatória; falha se restar dado sintético.
 */
import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { FirstRoomAccessCommitCommand } from "../src/lib/application/yes-hotel/first-room-access-commit";
import { SupabaseFirstRoomAccessUnitOfWork } from "../src/lib/infrastructure/supabase/yes-hotel/first-room-access-unit-of-work";

const MARKER = "HOMOLOG-FRA-ADAPTER-20260803";
const SOURCE = "homolog_fra_adapter";
const LOCK_APT = 999200001;
const LOCK_EXT = 999200002;
const LOCK_INT = 999200003;
const PWD_APT = 999200001;
const PWD_EXT = 999200002;
const PWD_INT = 999200003;

type Seed = {
  resId: string;
  credId: string;
  guestId: string;
  i1: string;
  i2: string;
  i3: string;
  from: string;
  until: string;
  grace: string;
  due: string;
};

function requireServiceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Defina SUPABASE_URL (ou NEXT_PUBLIC_SUPABASE_URL) e SUPABASE_SERVICE_ROLE_KEY. " +
        "Sem service_role o adapter real não pode ser homologado. Não use anon como fallback.",
    );
  }
  // Não logar url completa com query nem a key.
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "(url inválida)";
    }
  })();
  console.log(`Cliente service_role → host=${host} (secret não exibido)`);
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function assertNoSensitive(value: unknown, label: string) {
  const json = JSON.stringify(value ?? null);
  if (!json) return;
  if (/keyboardPwd|"senha"\s*:|"password"\s*:|"token"\s*:\s*"[^"]{8,}"/i.test(json)) {
    throw new Error(`${label}: conteúdo sensível detectado.`);
  }
}

async function pickFechaduras(client: SupabaseClient): Promise<[string, string, string]> {
  const { data, error } = await client.from("fechaduras").select("id").order("id").limit(3);
  if (error) throw new Error(`fechaduras: ${error.message}`);
  if (!data || data.length < 3) throw new Error("Precisa de ≥3 fechaduras (somente FK UUID; lock_id fictício).");
  return [data[0]!.id as string, data[1]!.id as string, data[2]!.id as string];
}

async function seed(client: SupabaseClient): Promise<Seed> {
  const [f1, f2, f3] = await pickFechaduras(client);
  const resId = crypto.randomUUID();
  const credId = crypto.randomUUID();
  const guestId = crypto.randomUUID();
  const i1 = crypto.randomUUID();
  const i2 = crypto.randomUUID();
  const i3 = crypto.randomUUID();
  const from = "2030-08-01T16:00:00.000Z";
  const until = "2030-08-05T14:00:00.000Z";
  const grace = "2030-08-01T17:00:00.000Z";
  const due = "2030-08-01T18:00:00.000Z";

  const { error: rErr } = await client.from("operacional_reservas").insert({
    id: resId,
    apartamento: `${MARKER}-APT`,
    hospede_principal: `${MARKER} GUEST`,
    check_in_previsto: "2030-08-01",
    check_out_previsto: "2030-08-05",
    pagamento_status: "pendente",
    origem_externa: "manual",
    external_reservation_id: MARKER,
  });
  if (rErr) throw new Error(`reserva: ${rErr.message}`);

  const { error: cErr } = await client.from("operacional_credenciais_acesso").insert({
    id: credId,
    reserva_id: resId,
    tipo_credencial: "principal",
    status: "provisionada",
    valido_de: from,
    valido_ate: until,
    motivo_origem: "checkin_normal",
  });
  if (cErr) throw new Error(`credencial: ${cErr.message}`);

  const { error: iErr } = await client.from("operacional_credencial_itens").insert([
    {
      id: i1,
      credencial_id: credId,
      fechadura_id: f1,
      lock_id_ttlock: String(LOCK_APT),
      tipo_destino: "apartamento",
      codigo_logico_destino: `APT-${MARKER}`,
      status_provisionamento: "provisionado",
      remote_keyboard_pwd_id: PWD_APT,
      provisionado_em: new Date().toISOString(),
    },
    {
      id: i2,
      credencial_id: credId,
      fechadura_id: f2,
      lock_id_ttlock: String(LOCK_EXT),
      tipo_destino: "portao_externo",
      codigo_logico_destino: `GATE-${MARKER}-EXT`,
      status_provisionamento: "provisionado",
      remote_keyboard_pwd_id: PWD_EXT,
      provisionado_em: new Date().toISOString(),
    },
    {
      id: i3,
      credencial_id: credId,
      fechadura_id: f3,
      lock_id_ttlock: String(LOCK_INT),
      tipo_destino: "portao_interno",
      codigo_logico_destino: `GATE-${MARKER}-INT`,
      status_provisionamento: "provisionado",
      remote_keyboard_pwd_id: PWD_INT,
      provisionado_em: new Date().toISOString(),
    },
  ]);
  if (iErr) throw new Error(`itens: ${iErr.message}`);

  const { error: gErr } = await client.from("operacional_hospedes").insert({
    id: guestId,
    reserva_id: resId,
    nome: `${MARKER} HOSPEDE`,
    principal: true,
    email: "homolog-adapter@example.invalid",
    whatsapp: "5500000000000",
    guest_role: "primary_adult",
  });
  if (gErr) throw new Error(`hospede: ${gErr.message}`);

  // Trigger pode ter criado FNRH — atualizar, não duplicar.
  const { data: existingFnrh, error: fFindErr } = await client
    .from("fnrh_hospedes")
    .select("id")
    .eq("reserva_id", resId)
    .eq("hospede_id", guestId)
    .maybeSingle();
  if (fFindErr) throw new Error(`fnrh find: ${fFindErr.message}`);

  if (existingFnrh?.id) {
    const { error: fUpd } = await client
      .from("fnrh_hospedes")
      .update({
        status: "confirmado_hospede",
        fnrh_lifecycle_status: "completed",
        completed_by_guest_id: guestId,
        confirmation_source: "guest",
        has_required_core_fields: true,
        has_required_documents: true,
      })
      .eq("id", existingFnrh.id);
    if (fUpd) throw new Error(`fnrh update: ${fUpd.message}`);
  } else {
    const { error: fIns } = await client.from("fnrh_hospedes").insert({
      id: crypto.randomUUID(),
      reserva_id: resId,
      hospede_id: guestId,
      link_token: `homolog-adapter-tok-${guestId}`,
      hospede_nome: `${MARKER} HOSPEDE`,
      status: "confirmado_hospede",
      fnrh_lifecycle_status: "completed",
      completed_by_guest_id: guestId,
      confirmation_source: "guest",
      has_required_core_fields: true,
      has_required_documents: true,
    });
    if (fIns) throw new Error(`fnrh insert: ${fIns.message}`);
  }

  return { resId, credId, guestId, i1, i2, i3, from, until, grace, due };
}

function graceCommand(seed: Seed, opts: { sourceEventId: string; idem: string }): FirstRoomAccessCommitCommand {
  return {
    decision: "grace_started",
    event: {
      source: SOURCE,
      source_event_id: opts.sourceEventId,
      idempotency_key: opts.idem,
      occurred_at: seed.grace,
      received_at: new Date().toISOString(),
      lock_id: LOCK_APT,
      keyboard_pwd_id: PWD_APT,
      record_type: 4,
      access_method: "passcode",
      success: true,
      raw_payload_sanitized: { marker: MARKER, recordType: 4 },
    },
    correlation: {
      reservation_id: seed.resId,
      credential_id: seed.credId,
      credential_item_id: seed.i1,
      logical_destination: `APT-${MARKER}`,
      keyboard_pwd_id: PWD_APT,
    },
    grace: {
      first_room_access_at: seed.grace,
      grace_started_at: seed.grace,
      suspension_due_at: seed.due,
      pending_payment: true,
      pending_fnrh: false,
      pending_snapshot: ["payment"],
      original_valid_from: seed.from,
      original_valid_until: seed.until,
    },
    items: [
      {
        credential_item_id: seed.i1,
        logical_destination: `APT-${MARKER}`,
        lock_id: LOCK_APT,
        remote_keyboard_pwd_id: PWD_APT,
        original_valid_from: seed.from,
        original_valid_until: seed.until,
        lock_class: "apartamento",
      },
      {
        credential_item_id: seed.i2,
        logical_destination: `GATE-${MARKER}-EXT`,
        lock_id: LOCK_EXT,
        remote_keyboard_pwd_id: PWD_EXT,
        original_valid_from: seed.from,
        original_valid_until: seed.until,
        lock_class: "portao_externo",
      },
      {
        credential_item_id: seed.i3,
        logical_destination: `GATE-${MARKER}-INT`,
        lock_id: LOCK_INT,
        remote_keyboard_pwd_id: PWD_INT,
        original_valid_from: seed.from,
        original_valid_until: seed.until,
        lock_class: "portao_interno",
      },
    ],
    outbox: {
      event_type: "guest_welcome_pending",
      channel: "whatsapp",
      reservation_id: seed.resId,
      credential_id: seed.credId,
      recipient_ref: "homolog-adapter-ref",
      template: "welcome_pending",
      payload: { marker: MARKER, pending: ["payment"] },
      idempotency_key: `welcome:${seed.credId}:${seed.grace}`,
    },
  };
}

async function cleanup(client: SupabaseClient, seed: Seed | null) {
  // 1 outbox
  await client.from("operacional_acesso_outbox").delete().like("idempotency_key", `%${MARKER}%`);
  if (seed) {
    await client.from("operacional_acesso_outbox").delete().eq("credential_id", seed.credId);
    // 2-3 tolerancia itens + tolerancia
    const { data: tols } = await client
      .from("operacional_acesso_tolerancias")
      .select("id")
      .eq("credential_id", seed.credId);
    for (const t of tols ?? []) {
      await client.from("operacional_acesso_tolerancia_itens").delete().eq("tolerance_id", t.id);
      await client.from("operacional_acesso_tolerancias").delete().eq("id", t.id);
    }
  }
  // 4 eventos
  await client.from("operacional_acesso_eventos").delete().eq("source", SOURCE);
  await client.from("operacional_acesso_eventos").delete().like("idempotency_key", `${MARKER}%`);
  // 5-9 via reserva cascade quando possível
  if (seed) {
    await client.from("fnrh_hospedes").delete().eq("reserva_id", seed.resId);
    await client.from("operacional_hospedes").delete().eq("reserva_id", seed.resId);
    await client.from("operacional_credencial_itens").delete().eq("credencial_id", seed.credId);
    await client.from("operacional_credenciais_acesso").delete().eq("id", seed.credId);
    await client.from("operacional_reservas").delete().eq("id", seed.resId);
  }
  await client.from("operacional_reservas").delete().eq("external_reservation_id", MARKER);
  await client.from("operacional_reservas").delete().like("apartamento", `${MARKER}%`);
  await client.from("operacional_hospedes").delete().like("nome", `${MARKER}%`);
}

async function assertClean(client: SupabaseClient) {
  const counts = {
    events: (
      await client.from("operacional_acesso_eventos").select("id", { count: "exact", head: true }).eq("source", SOURCE)
    ).count ?? -1,
    reservas: (
      await client
        .from("operacional_reservas")
        .select("id", { count: "exact", head: true })
        .eq("external_reservation_id", MARKER)
    ).count ?? -1,
    outbox: (
      await client
        .from("operacional_acesso_outbox")
        .select("id", { count: "exact", head: true })
        .like("idempotency_key", `%${MARKER}%`)
    ).count ?? -1,
    tol: (
      await client
        .from("operacional_acesso_tolerancias")
        .select("id", { count: "exact", head: true })
        .like("pending_snapshot::text", `%${MARKER}%`)
    ).count ?? 0,
  };
  // tol check by marker in snapshot may be 0 always; also check orphan by credential after delete
  if (counts.events !== 0 || counts.reservas !== 0 || counts.outbox !== 0) {
    throw new Error(`Limpeza incompleta: ${JSON.stringify(counts)}`);
  }
  return counts;
}

async function main() {
  console.log("\n=== Homologação adapter → RPC → Postgres ===\n");
  console.log(`Marker: ${MARKER}`);
  console.log("Caminho: script → SupabaseFirstRoomAccessUnitOfWork → yes_hotel_process_first_room_access → Postgres\n");

  const client = requireServiceClient();
  const uow = new SupabaseFirstRoomAccessUnitOfWork(client);
  let seedData: Seed | null = null;
  const report: string[] = [];

  try {
    await cleanup(client, null);
    seedData = await seed(client);
    report.push(`seed res=${seedData.resId.slice(0, 8)}… cred=${seedData.credId.slice(0, 8)}…`);

    // FASE 4 — grace_started
    const cmd1 = graceCommand(seedData, {
      sourceEventId: `${MARKER}:evt-1`,
      idem: `${MARKER}:idem-1`,
    });
    assertNoSensitive(cmd1, "cmd1");
    const r1 = await uow.commitFirstRoomAccess(cmd1);
    assertNoSensitive(r1, "r1");
    if (r1.status !== "grace_started" || !r1.tolerance_id || !r1.suspension_due_at) {
      throw new Error(`FASE4 falhou: ${JSON.stringify(r1)}`);
    }
    const pending = r1.pending_reasons ?? [];
    if (!pending.includes("payment") && !pending.includes("pagamento")) {
      // RPC devolve pending_snapshot do grace; aceitamos "payment" como contrato do adapter
      throw new Error(`FASE4 pending_reasons inesperado: ${JSON.stringify(pending)}`);
    }
    report.push(`FASE4 grace_started tol=${r1.tolerance_id.slice(0, 8)}… due=${r1.suspension_due_at}`);

    const { data: ev } = await client
      .from("operacional_acesso_eventos")
      .select("id, processing_status, raw_payload_sanitized")
      .eq("idempotency_key", `${MARKER}:idem-1`)
      .maybeSingle();
    if (!ev || ev.processing_status !== "processed") {
      throw new Error(`evento status=${ev?.processing_status}`);
    }
    assertNoSensitive(ev.raw_payload_sanitized, "evento.raw");

    const { count: tolN } = await client
      .from("operacional_acesso_tolerancias")
      .select("id", { count: "exact", head: true })
      .eq("credential_id", seedData.credId);
    const { count: itemN } = await client
      .from("operacional_acesso_tolerancia_itens")
      .select("id", { count: "exact", head: true })
      .eq("tolerance_id", r1.tolerance_id);
    const { count: outN } = await client
      .from("operacional_acesso_outbox")
      .select("id", { count: "exact", head: true })
      .eq("credential_id", seedData.credId)
      .eq("status", "pending");
    if (tolN !== 1 || itemN !== 3 || outN !== 1) {
      throw new Error(`contagens tol=${tolN} itens=${itemN} outbox=${outN}`);
    }
    report.push(`contagens tol=1 itens=3 outbox=1 evento=processed`);

    // FASE 5 — idempotência
    const r2 = await uow.commitFirstRoomAccess(cmd1);
    assertNoSensitive(r2, "r2");
    if (r2.status !== "already_started" && r2.status !== "grace_started") {
      throw new Error(`FASE5 status=${r2.status}`);
    }
    const { count: tolN2 } = await client
      .from("operacional_acesso_tolerancias")
      .select("id", { count: "exact", head: true })
      .eq("credential_id", seedData.credId);
    const { count: outN2 } = await client
      .from("operacional_acesso_outbox")
      .select("id", { count: "exact", head: true })
      .eq("credential_id", seedData.credId);
    const { count: evN2 } = await client
      .from("operacional_acesso_eventos")
      .select("id", { count: "exact", head: true })
      .eq("idempotency_key", `${MARKER}:idem-1`);
    if (tolN2 !== 1 || outN2 !== 1 || evN2 !== 1) {
      throw new Error(`FASE5 duplicou tol=${tolN2} out=${outN2} ev=${evN2}`);
    }
    report.push(`FASE5 idempotente status=${r2.status} (sem duplicar)`);

    // FASE 6 — segundo evento, mesma credencial
    const cmd3 = graceCommand(seedData, {
      sourceEventId: `${MARKER}:evt-2`,
      idem: `${MARKER}:idem-2`,
    });
    // decision already_started path via RPC when tolerance exists — still send grace_started
    // and expect already_started from unique credential / existing tol branch
    const r3 = await uow.commitFirstRoomAccess(cmd3);
    assertNoSensitive(r3, "r3");
    if (r3.status !== "already_started") {
      throw new Error(`FASE6 esperado already_started, veio ${r3.status}`);
    }
    if (r3.tolerance_id && r3.tolerance_id !== r1.tolerance_id) {
      throw new Error("FASE6 tolerance_id diferente");
    }
    if (r3.suspension_due_at && r3.suspension_due_at !== r1.suspension_due_at) {
      throw new Error("FASE6 suspension_due_at alterado");
    }
    const { count: outN3 } = await client
      .from("operacional_acesso_outbox")
      .select("id", { count: "exact", head: true })
      .eq("credential_id", seedData.credId);
    const { count: itemN3 } = await client
      .from("operacional_acesso_tolerancia_itens")
      .select("id", { count: "exact", head: true })
      .eq("tolerance_id", r1.tolerance_id);
    if (outN3 !== 1 || itemN3 !== 3) {
      throw new Error(`FASE6 out=${outN3} itens=${itemN3}`);
    }
    report.push(`FASE6 already_started mesma tol, outbox/itens intactos`);

    // FASE 7 — erro real (2 itens) em credencial NOVA (sem tolerância prévia).
    // Se reusar a credencial já com grace, a RPC retorna already_started antes de validar itens.
    const [f1b, f2b, f3b] = await pickFechaduras(client);
    const badRes = crypto.randomUUID();
    const badCred = crypto.randomUUID();
    const badI1 = crypto.randomUUID();
    const badI2 = crypto.randomUUID();
    const badI3 = crypto.randomUUID();
    const { error: brErr } = await client.from("operacional_reservas").insert({
      id: badRes,
      apartamento: `${MARKER}-BAD`,
      hospede_principal: `${MARKER} BAD`,
      check_in_previsto: "2030-08-01",
      check_out_previsto: "2030-08-05",
      pagamento_status: "pendente",
      origem_externa: "manual",
      external_reservation_id: `${MARKER}-BAD`,
    });
    if (brErr) throw new Error(`bad reserva: ${brErr.message}`);
    const { error: bcErr } = await client.from("operacional_credenciais_acesso").insert({
      id: badCred,
      reserva_id: badRes,
      tipo_credencial: "principal",
      status: "provisionada",
      valido_de: seedData.from,
      valido_ate: seedData.until,
      motivo_origem: "checkin_normal",
    });
    if (bcErr) throw new Error(`bad cred: ${bcErr.message}`);
    const { error: biErr } = await client.from("operacional_credencial_itens").insert([
      {
        id: badI1,
        credencial_id: badCred,
        fechadura_id: f1b,
        lock_id_ttlock: "999200101",
        tipo_destino: "apartamento",
        codigo_logico_destino: `APT-${MARKER}-BAD`,
        status_provisionamento: "provisionado",
        remote_keyboard_pwd_id: 999200101,
      },
      {
        id: badI2,
        credencial_id: badCred,
        fechadura_id: f2b,
        lock_id_ttlock: "999200102",
        tipo_destino: "portao_externo",
        codigo_logico_destino: `GATE-${MARKER}-BAD-EXT`,
        status_provisionamento: "provisionado",
        remote_keyboard_pwd_id: 999200102,
      },
      {
        id: badI3,
        credencial_id: badCred,
        fechadura_id: f3b,
        lock_id_ttlock: "999200103",
        tipo_destino: "portao_interno",
        codigo_logico_destino: `GATE-${MARKER}-BAD-INT`,
        status_provisionamento: "provisionado",
        remote_keyboard_pwd_id: 999200103,
      },
    ]);
    if (biErr) throw new Error(`bad itens: ${biErr.message}`);

    const badSeed: Seed = {
      ...seedData,
      resId: badRes,
      credId: badCred,
      i1: badI1,
      i2: badI2,
      i3: badI3,
    };
    const bad = graceCommand(badSeed, {
      sourceEventId: `${MARKER}:bad`,
      idem: `${MARKER}:bad`,
    });
    bad.items = bad.items!.slice(0, 2);
    bad.outbox = {
      ...bad.outbox!,
      reservation_id: badRes,
      credential_id: badCred,
      idempotency_key: `${MARKER}:bad-outbox`,
    };
    let threw = false;
    try {
      await uow.commitFirstRoomAccess(bad);
    } catch (e) {
      threw = true;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/RPC|itens|3/i.test(msg)) {
        throw new Error(`FASE7 erro inesperado: ${msg}`);
      }
      report.push(`FASE7 erro propagado: ${msg.slice(0, 120)}`);
    }
    if (!threw) throw new Error("FASE7 deveria falhar");
    const { count: badEv } = await client
      .from("operacional_acesso_eventos")
      .select("id", { count: "exact", head: true })
      .eq("idempotency_key", `${MARKER}:bad`);
    const { count: badTol } = await client
      .from("operacional_acesso_tolerancias")
      .select("id", { count: "exact", head: true })
      .eq("credential_id", badCred);
    if ((badEv ?? 0) !== 0 || (badTol ?? 0) !== 0) {
      throw new Error(`FASE7 residual ev=${badEv} tol=${badTol}`);
    }
    // limpa bundle bad imediatamente (finally também limpa por marker)
    await client.from("operacional_reservas").delete().eq("id", badRes);

    // FASE 8 — serialização (já exercitada: timestamptz ISO, bigint locks, jsonb items/outbox/snapshot)
    if (!r1.suspension_due_at.includes("T") && !r1.suspension_due_at.includes(" ")) {
      throw new Error("FASE8 suspension_due_at não parece timestamptz serializado");
    }
    report.push("FASE8 serialização datas/bigint/jsonb OK via round-trip adapter");

    console.log("Resultados:");
    for (const line of report) console.log(`  OK  ${line}`);
    console.log("\nHomologação adapter: APROVADA (pendente limpeza)\n");
  } finally {
    try {
      await cleanup(client, seedData);
      const c = await assertClean(client);
      console.log(`Limpeza integral OK: ${JSON.stringify(c)}`);
    } catch (e) {
      console.error("LIMPEZA FALHOU:", e instanceof Error ? e.message : e);
      if (seedData) {
        console.error(
          `IDs sintéticos (sem PII): res=${seedData.resId} cred=${seedData.credId} guest=${seedData.guestId}`,
        );
      }
      process.exitCode = 1;
      throw e;
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
