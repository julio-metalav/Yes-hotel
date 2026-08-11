/**
 * Edge: processador de tolerâncias + dispatcher outbox.
 *
 * - dry-run é o DEFAULT (execução real só com flags + homolog lock + dry_run=false server-side)
 * - Batch: service_role ou token scheduler (comparação constant-time)
 * - mode=manual: DESABILITADO neste PR (sem tabela de auditoria compatível)
 * - Senders: DigiSac/Resend reais somente com flag+config; nunca mock silencioso
 * - Sem cron neste PR
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { processAccessTolerancesBatch } from "../../../src/lib/application/yes-hotel/access-tolerance-processor.ts";
import {
  createMockTtlockValidityChangePort,
  dispatchAccessOutboxBatch,
} from "../../../src/lib/application/yes-hotel/access-outbox-dispatcher.ts";
import { getAccessToleranceFlags } from "../../../src/lib/domain/yes-hotel/access-tolerance-flags.ts";
import { createSupabaseFirstRoomAccessPorts } from "../../../src/lib/infrastructure/supabase/yes-hotel/index.ts";
import { SupabaseAccessOutboxQueuePort } from "../../../src/lib/infrastructure/supabase/yes-hotel/access-outbox-queue.ts";
import { buildProductionAccessCommunicationSender } from "../../../src/lib/infrastructure/comunicacao/access-communication-senders.ts";
import { TtlockChangeValidityAdapter } from "../../../src/lib/integrations/ttlock/access-ingest/ttlock-change-validity-adapter.ts";
import { getTtlockClient } from "../../../src/lib/integrations/ttlock/client.ts";
import { constantTimeEqual } from "../../../src/lib/integrations/ttlock/access-ingest/constant-time.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-access-tolerance-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const processorToken = (Deno.env.get("ACCESS_TOLERANCE_PROCESSOR_TOKEN") ?? "").trim();

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function sanitizeClientError(code: string): { ok: false; error: string } {
  return { ok: false, error: code };
}

async function authorizeBatch(req: Request): Promise<{ ok: boolean; kind?: string }> {
  const auth = req.headers.get("Authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token && constantTimeEqual(token, serviceRoleKey)) {
      return { ok: true, kind: "service_role" };
    }
  }
  if (processorToken) {
    const header = (req.headers.get("x-access-tolerance-token") ?? "").trim();
    if (header && constantTimeEqual(header, processorToken)) {
      return { ok: true, kind: "scheduler_token" };
    }
  }
  return { ok: false };
}

function denoFlagsEnv(): Record<string, string | undefined> {
  const keys = [
    "YES_HOTEL_ACCESS_TOLERANCE_PROCESSOR_ENABLED",
    "YES_HOTEL_TTLOCK_SUSPENSION_ENABLED",
    "YES_HOTEL_ACCESS_OUTBOX_DISPATCH_ENABLED",
    "YES_HOTEL_ACCESS_DIGISAC_REAL_ENABLED",
    "YES_HOTEL_ACCESS_EMAIL_REAL_ENABLED",
    "YES_HOTEL_PAGAMENTO_PRESENCIAL_DIFERIDO_ENABLED",
    "YES_HOTEL_TTLOCK_HOMOLOG_LOCK_ID",
    "YES_HOTEL_DIGISAC_INTERNAL_NUMBER",
    "DIGISAC_USE_MOCK",
    "DIGISAC_API_BASE_URL",
    "DIGISAC_API_TOKEN",
    "DIGISAC_SERVICE_ID",
    "DIGISAC_USER_ID",
    "DIGISAC_MESSAGES_PATH",
    "RESEND_API_KEY",
    "RESEND_FROM_EMAIL",
    "YES_HOTEL_RESEND_FROM",
  ];
  const env: Record<string, string | undefined> = {};
  for (const k of keys) env[k] = Deno.env.get(k) ?? undefined;
  return env;
}

/**
 * dry-run default true.
 * Cliente pode forçar dry_run=true; dry_run=false só vale se servidor autorizar execução real.
 */
function resolveEffectiveDryRun(
  bodyDryRun: unknown,
  flags: ReturnType<typeof getAccessToleranceFlags>,
): boolean {
  // Ausente ou true → dry-run
  if (bodyDryRun !== false) return true;
  // Cliente pediu real: só se flags TTLock + homolog lock
  if (!flags.ttlockSuspensionEnabled) return true;
  if (flags.homologLockIdFilter == null) return true;
  return false;
}

async function resolveRecipients(reservationId: string) {
  const { data: hop } = await admin
    .from("operacional_hospedes")
    .select("whatsapp, email, principal")
    .eq("reserva_id", reservationId)
    .eq("principal", true)
    .maybeSingle();
  const phone = String(hop?.whatsapp ?? "").replace(/\D/g, "") || null;
  const email = String(hop?.email ?? "").trim() || null;
  return { phone_digits: phone, email };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse(sanitizeClientError("method_not_allowed"), 405);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const mode = String(body.mode ?? "process_and_dispatch");

  // Ações manuais removidas deste PR — sem auditoria append-only compatível.
  if (mode === "manual") {
    return jsonResponse(
      {
        ok: false,
        error: "manual_actions_disabled",
        message:
          "Ações manuais desabilitadas até existir trilha de auditoria append-only dedicada.",
      },
      501,
    );
  }

  const authz = await authorizeBatch(req);
  if (!authz.ok) {
    return jsonResponse(sanitizeClientError("unauthorized"), 401);
  }

  const env = denoFlagsEnv();
  const flags = getAccessToleranceFlags(env);
  const limit = Math.min(Number(body.limit ?? 20) || 20, 50);
  const dryRun = resolveEffectiveDryRun(body.dry_run, flags);

  const basePorts = createSupabaseFirstRoomAccessPorts(admin, env);
  const outboxQueue = new SupabaseAccessOutboxQueuePort(admin);

  const realTtlock = flags.ttlockSuspensionEnabled && !dryRun && flags.homologLockIdFilter != null;
  const ttlock = realTtlock
    ? new TtlockChangeValidityAdapter(getTtlockClient())
    : createMockTtlockValidityChangePort();

  const processorPorts = {
    tolerances: basePorts.tolerances,
    pending: basePorts.pending,
    ttlock,
    outboxQueue,
    clock: basePorts.clock,
    presencialDiferidoAudit: basePorts.presencialDiferidoAudit,
  };

  const sender = buildProductionAccessCommunicationSender(
    {
      digisacRealEnabled: flags.digisacRealEnabled,
      emailRealEnabled: flags.emailRealEnabled,
    },
    env,
  );

  try {
    const processResults =
      mode === "dispatch"
        ? []
        : flags.processorEnabled
          ? await processAccessTolerancesBatch(processorPorts, {
              flags,
              batchLimit: limit,
              dryRun,
            })
          : [];

    const dispatchResults =
      mode === "process"
        ? []
        : await dispatchAccessOutboxBatch(
            {
              queue: outboxQueue,
              sender,
              clock: basePorts.clock,
              resolveRecipients,
            },
            { flags, limit },
          );

    return jsonResponse({
      ok: true,
      mode,
      dry_run: dryRun,
      flags: {
        processor: flags.processorEnabled,
        ttlock: flags.ttlockSuspensionEnabled,
        dispatch: flags.outboxDispatchEnabled,
        digisac_real: flags.digisacRealEnabled,
        email_real: flags.emailRealEnabled,
        homolog_lock: flags.homologLockIdFilter != null,
      },
      process_count: processResults.length,
      process_actions: processResults.map((r) => ({
        tolerance_id: r.tolerance_id,
        action: r.action,
        simulation_only: r.simulation_only ?? false,
        error: r.error ?? null,
      })),
      dispatch_count: dispatchResults.length,
      dispatch_summary: dispatchResults.map((r) => ({
        id: r.id,
        status: r.status,
        channel: r.channel,
        error: r.error ?? null,
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 200) : "error";
    console.error("[ACCESS_TOLERANCE_PROCESSOR]", msg);
    return jsonResponse(sanitizeClientError("internal_error"), 500);
  }
});
