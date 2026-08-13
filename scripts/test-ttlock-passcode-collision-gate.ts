/**
 * Casos obrigatórios: PIN sem colisão, idempotência, -3007 retry, gate guest_access_ready, 3/3 locks.
 */
import assert from "node:assert/strict";
import {
  allocateNewTtlockPasscode,
  generateRandomTtlockPasscode,
  isTtlockSamePasscodeError,
  TTLOCK_PASSCODE_COLLISION_RETRY_MAX,
} from "../src/lib/domain/yes-hotel/ttlock-credential-format.ts";
import {
  evaluateTtlockReadyForGuestAccess,
  isLifecycleProvisionAccessReady,
  resolveProvisionCredentialStatus,
} from "../src/lib/domain/yes-hotel/ttlock-guest-access-gate.ts";
import {
  processarCredencialDeAcesso,
  type CredencialItemRow,
  type CredencialRow,
  type ProvisioningRepository,
} from "../src/lib/application/yes-hotel/provisioning-executor.ts";
import type { TtlockClient } from "../src/lib/integrations/ttlock/client.ts";

function ok(msg: string) {
  console.log("ok:", msg);
}

async function main() {
// --- Caso 1: reservas distintas → PINs distintos (aleatório, não marker) ---
{
  const pins = new Set<string>();
  for (let i = 0; i < 20; i++) {
    pins.add(allocateNewTtlockPasscode());
  }
  assert.ok(pins.size >= 2, "aleatório deve variar entre alocações");
  for (const p of pins) {
    assert.equal(p.length, 4);
    assert.match(p, /^\d{4}$/);
  }
  ok("1 PINs aleatórios distintos / formato 4 dígitos");
}

// --- Gate: sem provisioning → não ready ---
{
  const g = evaluateTtlockReadyForGuestAccess(
    { status: "falhou", codigo_credencial: "0812" },
    [
      { status_provisionamento: "falhou", remote_keyboard_pwd_id: null },
      { status_provisionamento: "falhou", remote_keyboard_pwd_id: null },
      { status_provisionamento: "falhou", remote_keyboard_pwd_id: null },
    ],
  );
  assert.equal(g.ready, false);
  assert.equal(g.reason, "status_falhou");
  ok("gate bloqueia status falhou mesmo com passcode");
}

{
  const g = evaluateTtlockReadyForGuestAccess(
    { status: "provisionada", codigo_credencial: "1234" },
    [
      { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 1 },
      { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 2 },
      { status_provisionamento: "falhou", remote_keyboard_pwd_id: null },
    ],
  );
  assert.equal(g.ready, false);
  assert.equal(g.reason, "item_nao_provisionado");
  ok("5 gate bloqueia 2/3 locks");
}

{
  const g = evaluateTtlockReadyForGuestAccess(
    { status: "provisionada", codigo_credencial: "5678" },
    [
      { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 10 },
      { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 11 },
      { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 12 },
    ],
  );
  assert.equal(g.ready, true);
  assert.equal(g.passcode, "5678");
  ok("gate libera só com 3/3 + remote ids");
}

{
  assert.equal(
    isLifecycleProvisionAccessReady({
      ok: true,
      status: "falhou",
      falhas: 3,
    }),
    false,
  );
  assert.equal(
    isLifecycleProvisionAccessReady({
      ok: true,
      status: "provisionada",
      falhas: 0,
    }),
    true,
  );
  assert.equal(
    isLifecycleProvisionAccessReady({
      ok: false,
      status: "falhou",
      falhas: 3,
    }),
    false,
  );
  ok("4 lifecycle ok=false / falhou não é acesso pronto");
}

assert.equal(
  isTtlockSamePasscodeError("TTLock erro -3007: The same passcode already exists."),
  true,
);
assert.equal(TTLOCK_PASSCODE_COLLISION_RETRY_MAX, 3);
ok("detecção -3007");

function makeRepo(opts: {
  credencial: CredencialRow;
  itens: CredencialItemRow[];
  activePins?: string[];
}): ProvisioningRepository & { credencial: CredencialRow; itens: CredencialItemRow[] } {
  const state = {
    credencial: { ...opts.credencial },
    itens: opts.itens.map((i) => ({ ...i })),
  };
  return {
    get credencial() {
      return state.credencial;
    },
    get itens() {
      return state.itens;
    },
    async getCredencial(id) {
      return state.credencial.id === id ? state.credencial : null;
    },
    async getCredencialPorReserva() {
      return state.credencial;
    },
    async getCredenciaisPendentes() {
      return state.credencial.status === "pendente" ? [state.credencial] : [];
    },
    async getItens() {
      return state.itens.map((i) => ({ ...i }));
    },
    async getItensPendentes() {
      return state.itens.filter(
        (i) =>
          i.status_provisionamento === "pendente" ||
          (i.status_provisionamento === "falhou" && i.remote_keyboard_pwd_id == null),
      );
    },
    async getItensProvisionados() {
      return state.itens.filter((i) => i.status_provisionamento === "provisionado");
    },
    async getItensPendentesLimpeza() {
      return [];
    },
    async insertItem() {
      throw new Error("não usado");
    },
    async updateCredencial(_id, patch) {
      Object.assign(state.credencial, patch);
    },
    async getCredenciaisComPendenciaSync() {
      return [];
    },
    async updateItem(id, patch) {
      const row = state.itens.find((i) => i.id === id);
      if (row) Object.assign(row, patch);
    },
    async getReservaApartment() {
      return "35";
    },
    async getFechadurasForApartment() {
      return [];
    },
    async getReservaTtlockCredentialSource() {
      return {
        reserva_id: state.credencial.reserva_id,
        apartamento: "35",
        external_reservation_id: "TESTE-E2E-COMISSIONADA-JULIO-20260812",
        principal_guest_nome: "Julio Cesar",
        hospede_principal: "Julio Cesar",
      };
    },
    async listActivePasscodesOnLocks() {
      return opts.activePins ?? [];
    },
  };
}

function mockTtlock(opts?: {
  failWithCollisionUntilPasscode?: string;
}): TtlockClient & { created: string[]; ids: number[] } {
  const created: string[] = [];
  const ids: number[] = [];
  let nextId = 9000;
  const client = {
    created,
    ids,
    isAvailable() {
      return true;
    },
    async getAccessToken() {
      return "tok";
    },
    async createKeyboardPassword(params: { keyboardPwd: string }) {
      const pin = String(params.keyboardPwd);
      if (
        opts?.failWithCollisionUntilPasscode &&
        pin !== opts.failWithCollisionUntilPasscode
      ) {
        throw new Error("TTLock erro -3007: The same passcode already exists. Please use another one.");
      }
      created.push(pin);
      const keyboardPwdId = nextId++;
      ids.push(keyboardPwdId);
      return { keyboardPwdId };
    },
    async deleteKeyboardPassword() {
      return;
    },
    async changeKeyboardPassword() {
      return;
    },
  };
  return client as unknown as TtlockClient & { created: string[]; ids: number[] };
}

function seedThreeLocks(passcode: string | null, status: CredencialRow["status"] = "pendente") {
  const credencial: CredencialRow = {
    id: "cred-b",
    reserva_id: "res-b",
    status,
    valido_de: "2026-08-14T17:00:00.000Z",
    valido_ate: "2026-08-15T15:00:00.000Z",
    codigo_credencial: passcode,
    provider_tipo: "ttlock_passcode",
  };
  const itens: CredencialItemRow[] = ["apt", "ext", "int"].map((k, idx) => ({
    id: `item-${k}`,
    credencial_id: "cred-b",
    fechadura_id: `f-${idx}`,
    lock_id_ttlock: String(100 + idx),
    tipo_destino: k === "apt" ? "apartamento" : "portao",
    codigo_logico_destino: k.toUpperCase(),
    status_provisionamento: "pendente" as const,
    ultimo_erro: null,
    provisionado_em: null,
    revogado_em: null,
    remote_keyboard_pwd_id: null,
    codigo_enviado: null,
  }));
  return { credencial, itens };
}

// Caso 2: replay mesma credencial → mesmo PIN
{
  const { credencial, itens } = seedThreeLocks("4455");
  const repo = makeRepo({ credencial, itens });
  const ttlock = mockTtlock();
  const r1 = await processarCredencialDeAcesso("cred-b", {
    repository: repo,
    ttlockClient: ttlock,
  });
  assert.equal(r1.accessReady, true);
  assert.equal(r1.passcode, "4455");
  assert.equal(r1.provisionados, 3);
  // replay: itens já provisionados → não cria terceira senha
  const r2 = await processarCredencialDeAcesso("cred-b", {
    repository: repo,
    ttlockClient: ttlock,
  });
  assert.equal(r2.passcode, "4455");
  assert.equal(r2.accessReady, true);
  assert.equal(ttlock.created.length, 3);
  ok("2 replay idempotente: mesmo PIN, sem terceira senha");
}

// Caso 3: -3007 → novo PIN → ready só após sucesso
{
  const { credencial, itens } = seedThreeLocks("0812", "falhou");
  for (const i of itens) {
    i.status_provisionamento = "falhou";
    i.ultimo_erro = "TTLock erro -3007: The same passcode already exists.";
  }
  const repo = makeRepo({ credencial, itens, activePins: ["0812"] });
  // activePins força troca de 0812 antes; se ainda colidir, mock aceita só 7777
  const ttlock = mockTtlock({ failWithCollisionUntilPasscode: "7777" });
  const r = await processarCredencialDeAcesso("cred-b", {
    repository: repo,
    ttlockClient: ttlock,
    passcodeGenerator: (exclude) => {
      if (!exclude || exclude === "0812") return "7777";
      return generateRandomTtlockPasscode(exclude);
    },
  });
  assert.equal(r.accessReady, true);
  assert.equal(r.passcode, "7777");
  assert.notEqual(r.passcode, "0812");
  assert.equal(r.provisionados, 3);
  assert.equal(
    evaluateTtlockReadyForGuestAccess(repo.credencial, repo.itens).ready,
    true,
  );
  ok("3 -3007 / colisão local → novo PIN e guest ready só após sucesso");
}

// Caso 4: falha total → accessReady false
{
  const { credencial, itens } = seedThreeLocks(null);
  const repo = makeRepo({ credencial, itens });
  const ttlock = mockTtlock({ failWithCollisionUntilPasscode: "__never__" });
  const r = await processarCredencialDeAcesso("cred-b", {
    repository: repo,
    ttlockClient: ttlock,
    passcodeGenerator: () => "3333",
  });
  assert.equal(r.accessReady, false);
  assert.equal(r.status, "falhou");
  assert.equal(
    evaluateTtlockReadyForGuestAccess(repo.credencial, repo.itens).ready,
    false,
  );
  ok("4 falha total → sem guest_access_ready");
}

// Caso 5: 1 de 3 falha → não pronto
{
  const resolved = resolveProvisionCredentialStatus([
    { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 1 },
    { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 2 },
    { status_provisionamento: "falhou", remote_keyboard_pwd_id: null },
  ]);
  assert.equal(resolved.allReady, false);
  assert.equal(resolved.status, "parcial");
  ok("5 parcial 2/3 → não provisionada");
}

// Duas reservas: PINs distintos mesmo com marker que colidiria
{
  const a = allocateNewTtlockPasscode(["0812"]);
  const b = allocateNewTtlockPasscode(["0812", a]);
  assert.notEqual(a, "0812");
  assert.notEqual(b, "0812");
  assert.notEqual(a, b);
  ok("1b exclude evita PIN colidente ativo");
}

console.log("ok: test-ttlock-passcode-collision-gate");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
