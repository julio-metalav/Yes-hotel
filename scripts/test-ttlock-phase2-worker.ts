/**
 * Fase 2: classificação do worker + split de patch sync_* vs status.
 */
import assert from "node:assert/strict";
import { splitCredencialProvisionDbPatch } from "../src/lib/domain/yes-hotel/ttlock-provision-db-patch.ts";
import {
  classifyTtlockPhase2Candidate,
  isPhase2RetryEligibleNow,
} from "../src/lib/domain/yes-hotel/ttlock-provision-phase2.ts";
import { encodeTransientRetryState } from "../src/lib/domain/yes-hotel/ttlock-provision-retry.ts";

function ok(msg: string) {
  console.log("ok:", msg);
}

const itemsReady = [
  { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 1 },
  { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 2 },
  { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 3 },
];

{
  const { core, sync } = splitCredencialProvisionDbPatch({
    status: "provisionada",
    last_sync_attempt_at: "2026-08-13T23:12:36.000Z",
    sync_status: "ok",
    last_sync_error: null,
  });
  assert.equal(core.status, "provisionada");
  assert.equal(core.last_sync_error, undefined);
  assert.equal(sync.sync_status, "ok");
  assert.equal(sync.last_sync_error, null);
  assert.equal(sync.last_sync_attempt_at, "2026-08-13T23:12:36.000Z");
  ok("split: status no core; sync_* separado");
}

{
  const d = classifyTtlockPhase2Candidate({
    credentialStatus: "provisionando",
    codigoCredencial: "7114",
    items: itemsReady,
    senhaEnviadaEm: null,
    acessoLiberado: true,
    reservaAtiva: true,
  });
  assert.equal(d.run, true);
  assert.equal(d.kind, "status_heal");
  assert.equal(d.reason, "itens_3_de_3_status_lag");
  ok("3/3 + status provisionando → status_heal (caso Breno)");
}

{
  const d = classifyTtlockPhase2Candidate({
    credentialStatus: "provisionada",
    codigoCredencial: "7114",
    items: itemsReady,
    senhaEnviadaEm: null,
    acessoLiberado: true,
    reservaAtiva: true,
  });
  assert.equal(d.run, true);
  assert.equal(d.kind, "send_senha");
  ok("3/3 provisionada sem senha_enviada_em → send_senha");
}

{
  const d = classifyTtlockPhase2Candidate({
    credentialStatus: "provisionada",
    codigoCredencial: "7114",
    items: itemsReady,
    senhaEnviadaEm: "2026-08-13T23:20:00.000Z",
    acessoLiberado: true,
    reservaAtiva: true,
  });
  assert.equal(d.run, false);
  assert.equal(d.kind, null);
  ok("completo → não reenvia");
}

{
  const now = new Date("2026-08-13T23:20:00.000Z");
  const d = classifyTtlockPhase2Candidate({
    credentialStatus: "provisionando",
    codigoCredencial: "7114",
    items: [
      { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 1 },
      { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 2 },
      { status_provisionamento: "provisionando", remote_keyboard_pwd_id: null },
    ],
    senhaEnviadaEm: null,
    lastSyncError: encodeTransientRetryState({
      phase: 2,
      count: 1,
      errorClass: "uncertain",
      nextEligibleAt: "2026-08-13T23:21:00.000Z",
    }),
    acessoLiberado: true,
    reservaAtiva: true,
    now,
  });
  assert.equal(d.run, false);
  assert.equal(d.reason, "fase2_aguardando_janela");
  ok("fase 2 respeita nextEligibleAt");
}

{
  const now = new Date("2026-08-13T23:21:01.000Z");
  assert.equal(
    isPhase2RetryEligibleNow(
      encodeTransientRetryState({
        phase: 2,
        count: 1,
        errorClass: "transient",
        nextEligibleAt: "2026-08-13T23:21:00.000Z",
      }),
      now,
    ),
    true,
  );
  const d = classifyTtlockPhase2Candidate({
    credentialStatus: "provisionando",
    codigoCredencial: "7114",
    items: [
      { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 1 },
      { status_provisionamento: "provisionando", remote_keyboard_pwd_id: null },
      { status_provisionamento: "pendente", remote_keyboard_pwd_id: null },
    ],
    senhaEnviadaEm: null,
    lastSyncError: encodeTransientRetryState({
      phase: 2,
      count: 1,
      errorClass: "transient",
      nextEligibleAt: "2026-08-13T23:21:00.000Z",
    }),
    acessoLiberado: true,
    reservaAtiva: true,
    now,
  });
  assert.equal(d.kind, "provision_retry");
  ok("após janela → provision_retry mesmo PIN");
}

{
  const d = classifyTtlockPhase2Candidate({
    credentialStatus: "provisionando",
    codigoCredencial: "7114",
    items: itemsReady,
    senhaEnviadaEm: null,
    acessoLiberado: false,
    reservaAtiva: true,
  });
  assert.equal(d.run, false);
  ok("sem acesso_liberado → não corre");
}

console.log("ok: test-ttlock-phase2-worker");
