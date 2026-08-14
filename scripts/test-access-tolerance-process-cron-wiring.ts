/**
 * Wiring do cron de process vs dispatch + contrato dry-run/homolog.
 * Sem rede / sem banco.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAccessToleranceFlags,
  resolveAccessToleranceEffectiveDryRun,
} from "../src/lib/domain/yes-hotel/access-tolerance-flags.ts";
import {
  isTtlockExecutionReal,
  processAccessTolerancesBatch,
  resolveHomologFilter,
} from "../src/lib/application/yes-hotel/access-tolerance-processor.ts";
import { createMockTtlockValidityChangePort } from "../src/lib/application/yes-hotel/access-outbox-dispatcher.ts";
import {
  createFirstRoomAccessMemoryHarness,
  seedActiveTolerance,
} from "../src/lib/application/yes-hotel/testing/first-room-access-memory.ts";
import type { AccessToleranceFlags } from "../src/lib/domain/yes-hotel/access-tolerance-flags.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROCESS_SQL = "supabase/migrations/20260814003954_access_tolerance_process_cron.sql";
const DISPATCH_SQL = "supabase/migrations/20260811220053_access_outbox_dispatch_cron.sql";
const EDGE = "supabase/functions/access-tolerance-processor/index.ts";

const LOCK_HOMOLOG = 16274746;
const RES_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CRED_ID = "ffffffff-1111-4222-8333-444444444444";

function readRepo(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function flags(partial: Partial<AccessToleranceFlags> = {}): AccessToleranceFlags {
  return {
    processorEnabled: true,
    ttlockSuspensionEnabled: true,
    outboxDispatchEnabled: false,
    digisacRealEnabled: false,
    emailRealEnabled: false,
    homologLockIdFilter: LOCK_HOMOLOG,
    digisacInternalNumber: "6721800225",
    ...partial,
  };
}

function ok(label: string) {
  console.log(`  ok ${label}`);
}

async function main() {
  const processSql = readRepo(PROCESS_SQL);
  const dispatchSql = readRepo(DISPATCH_SQL);
  const edgeSrc = readRepo(EDGE);

  assert.ok(processSql.includes("yes-hotel-access-tolerance-process"));
  assert.ok(processSql.includes("'* * * * *'"));
  assert.ok(
    processSql.includes(`body := '{"mode":"process","limit":20,"dry_run":false}'::jsonb`),
  );
  assert.ok(processSql.includes("access-tolerance-processor"));
  assert.ok(processSql.includes("x-access-tolerance-token"));
  assert.ok(processSql.includes("access_tolerance_processor_token"));
  assert.ok(processSql.includes("yes_hotel_edge_anon_key"));
  assert.ok(!processSql.includes("where jobname = 'yes-hotel-access-outbox-dispatch'"));
  assert.ok(!processSql.includes(`body := '{"mode":"dispatch"`));
  ok("cron process SQL: job separado, mode=process, dry_run=false, Vault/auth");

  assert.ok(dispatchSql.includes("yes-hotel-access-outbox-dispatch"));
  assert.ok(dispatchSql.includes(`body := '{"mode":"dispatch","limit":20}'::jsonb`));
  assert.ok(!dispatchSql.includes("yes-hotel-access-tolerance-process"));
  assert.ok(!dispatchSql.includes(`body := '{"mode":"process"`));
  ok("cron dispatch SQL intacto: mode=dispatch, job separado");

  assert.match(edgeSrc, /mode === "process"/);
  assert.match(edgeSrc, /flags\.processorEnabled/);
  assert.match(edgeSrc, /resolveAccessToleranceEffectiveDryRun/);
  ok("edge: mode=process e processorEnabled");

  const off = getAccessToleranceFlags({
    YES_HOTEL_ACCESS_TOLERANCE_PROCESSOR_ENABLED: "false",
  });
  assert.equal(off.processorEnabled, false);
  const on = getAccessToleranceFlags({
    YES_HOTEL_ACCESS_TOLERANCE_PROCESSOR_ENABLED: "true",
  });
  assert.equal(on.processorEnabled, true);
  ok("flag processorEnabled");

  assert.equal(resolveAccessToleranceEffectiveDryRun(undefined, flags()), true);
  assert.equal(resolveAccessToleranceEffectiveDryRun(true, flags()), true);
  assert.equal(resolveAccessToleranceEffectiveDryRun(false, flags()), false);
  assert.equal(
    resolveAccessToleranceEffectiveDryRun(false, flags({ ttlockSuspensionEnabled: false })),
    true,
  );
  assert.equal(
    resolveAccessToleranceEffectiveDryRun(false, flags({ homologLockIdFilter: null })),
    true,
  );
  ok("dry_run:false só sai de dry-run com TTLock + homolog");

  assert.equal(isTtlockExecutionReal(flags(), true), false);
  assert.equal(isTtlockExecutionReal(flags(), false), true);
  assert.equal(isTtlockExecutionReal(flags({ ttlockSuspensionEnabled: false }), false), false);
  const blocked = resolveHomologFilter(flags({ homologLockIdFilter: null }), true);
  assert.equal(blocked.ok, false);
  ok("efeito físico exige dryRun=false + homolog gate");

  const h = createFirstRoomAccessMemoryHarness({
    correlation: {
      correlated: true,
      reservation_id: RES_ID,
      credential_id: CRED_ID,
      within_reservation_window: true,
      original_valid_from: "2026-08-13T12:00:00.000Z",
      original_valid_until: "2026-08-15T15:00:00.000Z",
    },
    pending: {
      payment_status: "pendente",
      guests: [{ id: "p1", role: "principal_adulto", fnrh_status: "completed" }],
    },
    items: [],
    now: new Date("2026-08-13T20:00:00.000Z"),
  });
  const tol = await seedActiveTolerance(h, {
    reservation_id: RES_ID,
    credential_id: CRED_ID,
    suspension_due_at: "2026-08-13T19:00:00.000Z",
    pending_payment: true,
    pending_fnrh: false,
    original_valid_from: "2026-08-13T12:00:00.000Z",
    original_valid_until: "2026-08-15T15:00:00.000Z",
    items: [
      {
        credential_item_id: "item-apt34",
        logical_destination: "APT-34",
        lock_id: LOCK_HOMOLOG,
        remote_keyboard_pwd_id: 1,
      },
      {
        credential_item_id: "item-ext",
        logical_destination: "GATE-EXT",
        lock_id: 10939258,
        remote_keyboard_pwd_id: 2,
      },
      {
        credential_item_id: "item-int",
        logical_destination: "GATE-INT",
        lock_id: 10939408,
        remote_keyboard_pwd_id: 3,
      },
    ],
  });
  const ports = {
    tolerances: h.tolerances,
    pending: h.pendingPort,
    ttlock: createMockTtlockValidityChangePort(),
    outboxQueue: h.outboxQueue,
    clock: h.clock,
  };
  const empty = await processAccessTolerancesBatch(ports, {
    flags: flags({ processorEnabled: false }),
    dryRun: false,
  });
  assert.equal(empty.length, 0);
  assert.equal((await h.tolerances.findById!(tol.id))!.grace_status, "active");
  ok("processorEnabled=false não processa");

  console.log("OK test-access-tolerance-process-cron-wiring");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
