/**
 * Edge: leitura somente leitura das reservas do HITS pelo gateway.
 *
 * Só GET. Nenhuma escrita no HITS: não chama HITS direto, não dispara DigiSac,
 * e-mail, TTLock, senha nem cobrança.
 *
 * O Bearer do gateway vive apenas aqui (Deno.env). O chamador autentica com o
 * JWT do usuário ou com a anon key (verify_jwt default = true) e nunca vê o token.
 *
 * Snapshot (HOMO primeiro): quando a chamada tem a forma do scheduler (sem
 * parâmetros de query, sem sessão de usuário) e HITS_SNAPSHOT_WRITE_ENABLED=true,
 * a MESMA leitura é gravada em public.hits_reservas_snapshot pelas RPCs
 * hits_snapshot_sync_* (service_role). Não há segunda rodada ao HITS. A UI lê o
 * snapshot em vez de chamar esta Edge ao vivo. Sem a trava, o comportamento é
 * idêntico ao anterior (rollback = unset da env).
 *
 * Incremental (HOMO primeiro): com HITS_SNAPSHOT_INCREMENTAL_ENABLED=true e a
 * migration 20260925090000 aplicada, o ciclo lê só o que mudou desde o cursor
 * (Type=2 = data de atualização) e busca detalhe só desses ids; zero alterações
 * → zero detalhes. Sem cursor → carga completa inicial (Type=0), que fixa o
 * cursor; com cursor → sempre incremental (não há completa periódica).
 * Canceladas (status 2) saem do snapshot; ausência nunca remove.
 *
 * Env: HITS_GATEWAY_URL, HITS_GATEWAY_TOKEN, HITS_GATEWAY_READ_ENABLED,
 *      HITS_GATEWAY_PROD_READ_ENABLED (exigida =true só quando a URL é o gateway
 *      de produção; libera apenas esta leitura), HITS_GATEWAY_TIMEOUT_MS (opcional),
 *      HITS_SNAPSHOT_WRITE_ENABLED (opcional; grava o snapshot no Supabase),
 *      HITS_SNAPSHOT_INCREMENTAL_ENABLED (opcional; modo incremental Type=2).
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  fetchHitsSandboxReservations,
  fetchHitsUpdatedReservations,
  getHitsGatewayReadConfig,
  assertHitsGatewayReadReady,
  hitsGatewayReadStatus,
} from "../../../src/lib/integrations/hits/hits-gateway-read.ts";
import {
  HITS_SNAPSHOT_WRITE_ENV,
  runHitsSnapshotSync,
  shouldPersistSnapshot,
  type SnapshotRpc,
  type SnapshotSyncState,
} from "../../../src/lib/integrations/hits/hits-snapshot-sync.ts";
import {
  materializarReservaSincronizada,
  type SupabaseAdminLike,
} from "../../../src/lib/integrations/hits/hits-materializar.ts";
import type { SyncedReservation } from "../../../src/lib/domain/yes-hotel/synced-reservation.ts";

/**
 * Materialização automática (desligada por padrão). Com `=true`, ao fim de um
 * ciclo que gravou o snapshot, cada reserva ATIVA lida neste ciclo e ainda sem
 * linha em operacional_reservas é materializada com o MESMO detalhe já lido
 * (zero chamadas extras ao HITS), pelo helper compartilhado com
 * hits-reserva-materializar. MATERIALIZAR ≠ ENVIAR: nenhuma comunicação é
 * disparada aqui. Teto por ciclo para não alongar o tick.
 */
const HITS_AUTO_MATERIALIZAR_ENV = "HITS_AUTO_MATERIALIZAR_ENABLED";
const HITS_AUTO_MATERIALIZAR_MAX_POR_CICLO = 20;

/**
 * Trava do modo incremental (Type=2 + cursor). Exige a migration
 * 20260925090000_hits_snapshot_incremental.sql aplicada no projeto: sem a env,
 * o ciclo é sempre completo (Type=0), idêntico ao anterior.
 */
const HITS_SNAPSHOT_INCREMENTAL_ENV = "HITS_SNAPSHOT_INCREMENTAL_ENABLED";

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
    "HITS_GATEWAY_PROD_READ_ENABLED",
    "HITS_GATEWAY_TIMEOUT_MS",
  ];
  const env: Record<string, string | undefined> = {};
  for (const k of keys) env[k] = Deno.env.get(k) ?? undefined;
  return env;
}

/**
 * Cliente service_role só para as RPCs do snapshot, criado apenas quando a
 * chamada vai persistir. O caminho sem snapshot não toca o banco.
 */
function snapshotAdmin(): {
  rpc: SnapshotRpc;
  readState: () => Promise<SnapshotSyncState | null>;
  admin: SupabaseAdminLike;
} | null {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return {
    admin,
    rpc: (fn, args) => admin.rpc(fn, args),
    // Só leitura do cursor (linha única). service_role bypassa RLS.
    readState: async () => {
      const { data, error } = await admin
        .from("hits_snapshot_sync_state")
        .select("last_cursor_at")
        .eq("id", true)
        .maybeSingle();
      if (error) return null;
      return (data as SnapshotSyncState | null) ?? null;
    },
  };
}

/**
 * Materializa as reservas ativas deste ciclo que ainda não têm linha em
 * operacional_reservas. Entrada: linhas do snapshot lidas agora + detalhes já
 * normalizados (onDetail). Só banco: 1 SELECT de existência + escrita do helper.
 * Sem HITS, sem envio, sem apagar. Teto por ciclo; erros são contados, não
 * derrubam o tick.
 */
async function materializarNovasDoCiclo(
  admin: SupabaseAdminLike,
  rows: ReadonlyArray<{ external_reservation_id: string; status_reserva: string }>,
  detalhes: Map<string, SyncedReservation>,
): Promise<Record<string, unknown>> {
  const ids = rows
    .filter((r) => r.status_reserva !== "cancelada")
    .map((r) => String(r.external_reservation_id || "").trim())
    .filter((id) => id && detalhes.has(id));
  const out = { habilitada: true, candidatas: 0, criadas: 0, reusadas: 0, erros: 0, ignoradas_teto: 0 };
  if (ids.length === 0) return out;

  const { data: existentes, error } = await admin
    .from("operacional_reservas")
    .select("external_reservation_id")
    .eq("origem_externa", "hits")
    .in("external_reservation_id", ids);
  if (error) {
    console.error("[HITS_AUTO_MATERIALIZAR] leitura de existentes falhou", { code: error.code });
    return { ...out, erros: 1 };
  }
  const jaLocal = new Set(
    ((existentes ?? []) as Array<{ external_reservation_id: string }>).map((r) =>
      String(r.external_reservation_id),
    ),
  );
  const novas = ids.filter((id) => !jaLocal.has(id));
  out.candidatas = novas.length;

  for (const id of novas) {
    if (out.criadas + out.reusadas + out.erros >= HITS_AUTO_MATERIALIZAR_MAX_POR_CICLO) {
      out.ignoradas_teto += 1;
      continue;
    }
    const synced = detalhes.get(id);
    if (!synced) continue;
    try {
      const r = await materializarReservaSincronizada({
        admin,
        externalId: id,
        synced,
        log: (msg, extra) => console.error(msg, extra ?? {}),
      });
      if (!r.ok) out.erros += 1;
      else if (r.reserva_criada) out.criadas += 1;
      else out.reusadas += 1;
    } catch (_e) {
      out.erros += 1;
    }
  }
  return out;
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

  // Detalhes já normalizados deste ciclo (id → SyncedReservation), para a
  // materialização automática reaproveitar sem nova leitura no HITS.
  const detalhes = new Map<string, SyncedReservation>();
  const onDetail = (id: string, synced: SyncedReservation) => {
    detalhes.set(id, synced);
  };

  const read = () =>
    fetchHitsSandboxReservations({
      config: gate.config,
      dateFrom: parseYmd(url.searchParams.get("date_from")),
      dateTo: parseYmd(url.searchParams.get("date_to")),
      page: parseInt0(url.searchParams.get("page")),
      size: parseInt0(url.searchParams.get("size")),
      reservationIds,
      onDetail,
    });

  const decision = shouldPersistSnapshot({
    writeEnabled: Deno.env.get(HITS_SNAPSHOT_WRITE_ENV),
    searchParams: url.searchParams,
    authorization: req.headers.get("authorization"),
  });
  const admin = decision.persist ? snapshotAdmin() : null;
  const incrementalEnabled = (Deno.env.get(HITS_SNAPSHOT_INCREMENTAL_ENV) ?? "").trim() === "true";
  const autoMaterializarEnabled =
    (Deno.env.get(HITS_AUTO_MATERIALIZAR_ENV) ?? "").trim() === "true";
  let materializacao: Record<string, unknown> = {
    habilitada: autoMaterializarEnabled,
    candidatas: 0,
    criadas: 0,
    reusadas: 0,
    erros: 0,
  };

  // Incremental (Type=2): só os ids alterados na janela, detalhe só deles.
  // Mesma cadência/orçamento/retries da leitura completa.
  const readIncremental = (window: { from: string; to: string }, todayYmd: string) =>
    fetchHitsUpdatedReservations({
      config: gate.config,
      updatedFrom: window.from,
      updatedTo: window.to,
      todayYmd,
      onDetail,
    });

  const startedAt = Date.now();
  let result: Awaited<ReturnType<typeof read>>;
  let snapshot: Record<string, unknown>;

  if (decision.persist && admin) {
    // Uma leitura só: a mesma rodada alimenta a resposta e o snapshot.
    const run = await runHitsSnapshotSync({
      rpc: admin.rpc,
      batchId: crypto.randomUUID(),
      read,
      ...(incrementalEnabled ? { readState: admin.readState, readIncremental } : {}),
    });
    snapshot = run.snapshot;
    if (run.readError || !run.result) {
      const msg =
        run.readError instanceof Error ? run.readError.message.slice(0, 200) : "erro";
      console.error("[HITS_RESERVATIONS_PREVIEW] falha de leitura", {
        snapshot_stage: run.snapshot.persisted ? null : run.snapshot.stage,
      });
      return json({ ok: false, error: "gateway_read_failed", message: msg, snapshot }, 502);
    }
    result = run.result;

    // Materialização automática: só após snapshot gravado, só reservas ativas
    // lidas neste ciclo (detalhe já em memória) e ainda sem linha local.
    // Idempotente pelo helper; nenhuma chamada ao HITS; nenhum envio.
    if (autoMaterializarEnabled && run.snapshot.persisted) {
      materializacao = await materializarNovasDoCiclo(admin.admin, result.rows, detalhes);
    }
  } else {
    snapshot = decision.persist
      ? { persisted: false, reason: "service_role_unavailable" }
      : { persisted: false, reason: decision.reason };
    try {
      result = await read();
    } catch (e) {
      // Mensagem já sanitizada pelo HitsError; corta o resto por segurança.
      const msg = e instanceof Error ? e.message.slice(0, 200) : "erro";
      console.error("[HITS_RESERVATIONS_PREVIEW] falha de leitura");
      return json({ ok: false, error: "gateway_read_failed", message: msg, snapshot }, 502);
    }
  }

  // Log de sucesso: só metadados não sensíveis (sem hóspede/apto/IDs/token).
  console.log("[HITS_RESERVATIONS_PREVIEW] ok", {
    count: result.rows.length,
    pages_fetched: result.pages_fetched,
    failed_count: result.failed.length,
    stopped_reason: result.stopped_reason,
    listing_complete: result.listing_complete,
    elapsed_ms: result.elapsed_ms,
    duration_ms: Date.now() - startedAt,
    snapshot,
    materializacao,
  });

  return json({
    ok: true,
    read_only: true,
    source: "hits_gateway",
    page: result.page,
    size: result.size,
    pages_fetched: result.pages_fetched,
    stopped_reason: result.stopped_reason,
    listing_complete: result.listing_complete,
    elapsed_ms: result.elapsed_ms,
    count: result.rows.length,
    rows: result.rows,
    failed: result.failed,
    snapshot,
    materializacao,
  });
});
