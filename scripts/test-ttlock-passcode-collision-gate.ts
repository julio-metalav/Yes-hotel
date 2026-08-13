/**
 * Regressões: unicidade global de PIN por fechadura + gate + rollback parcial.
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
  collectOccupiedPasscodesFromRows,
  itemMayStillHoldPasscodeOnLock,
  shouldRollbackPartialPasscodeAttempt,
} from "../src/lib/domain/yes-hotel/ttlock-passcode-uniqueness.ts";
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
  // --- Unicidade local (sem filtro temporal) ---
  {
    const rows = [
      {
        credencial_id: "old-expired",
        codigo_credencial: "1111",
        status_provisionamento: "provisionado",
        remote_keyboard_pwd_id: 1,
      },
      {
        credencial_id: "future",
        codigo_credencial: "2222",
        status_provisionamento: "provisionado",
        remote_keyboard_pwd_id: 2,
      },
      {
        credencial_id: "inactive-like",
        codigo_credencial: "3333",
        status_provisionamento: "falhou",
        remote_keyboard_pwd_id: null,
      },
      {
        credencial_id: "revoked-ok",
        codigo_credencial: "4444",
        status_provisionamento: "revogado",
        remote_keyboard_pwd_id: 9,
      },
      {
        credencial_id: "cleanup",
        codigo_credencial: "5555",
        status_provisionamento: "pendente_limpeza",
        remote_keyboard_pwd_id: 5,
      },
    ];
    const occupied = collectOccupiedPasscodesFromRows(rows, "current");
    assert.ok(occupied.has("1111"), "CASO A vencida ocupa");
    assert.ok(occupied.has("2222"), "CASO B futura ocupa");
    assert.ok(occupied.has("3333"), "CASO C falhou/inativa ocupa");
    assert.ok(!occupied.has("4444"), "revogado confirmado não ocupa");
    assert.ok(occupied.has("5555"), "pendente_limpeza ocupa");
    assert.equal(itemMayStillHoldPasscodeOnLock({ status_provisionamento: "revogado", remote_keyboard_pwd_id: 1 }), false);
    ok("A/B/C unicidade global sem filtro temporal");
  }

  {
    assert.equal(
      shouldRollbackPartialPasscodeAttempt({
        collisionOnAnyLock: true,
        provisionedInRound: 2,
        credentialNeverFullyProvisioned: true,
      }),
      true,
    );
    assert.equal(
      shouldRollbackPartialPasscodeAttempt({
        collisionOnAnyLock: true,
        provisionedInRound: 0,
        credentialNeverFullyProvisioned: true,
      }),
      false,
    );
    ok("rollback parcial só quando houve aceite + colisão");
  }

  // Gate
  {
    assert.equal(
      evaluateTtlockReadyForGuestAccess(
        { status: "falhou", codigo_credencial: "0812" },
        [
          { status_provisionamento: "falhou", remote_keyboard_pwd_id: null },
          { status_provisionamento: "falhou", remote_keyboard_pwd_id: null },
          { status_provisionamento: "falhou", remote_keyboard_pwd_id: null },
        ],
      ).ready,
      false,
    );
    assert.equal(
      isLifecycleProvisionAccessReady({ ok: false, status: "falhou", falhas: 3 }),
      false,
    );
    assert.equal(isTtlockSamePasscodeError("TTLock erro -3007: same passcode"), true);
    assert.equal(TTLOCK_PASSCODE_COLLISION_RETRY_MAX, 3);
    ok("gate + -3007");
  }

  function makeRepo(opts: {
    credencial: CredencialRow;
    itens: CredencialItemRow[];
    occupiedPins?: string[];
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
        return state.itens.filter((i) => i.status_provisionamento === "pendente_limpeza");
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
          external_reservation_id: "TESTE-MARKER-20260812",
          principal_guest_nome: "Julio Cesar",
          hospede_principal: "Julio Cesar",
        };
      },
      async listOccupiedPasscodesOnLocks() {
        return opts.occupiedPins ?? [];
      },
    };
  }

  function mockTtlock(opts?: {
    /** lockId → se true, -3007 */
    collideOnLock?: (lockId: string, pin: string) => boolean;
    failDelete?: boolean;
  }): TtlockClient & {
    created: Array<{ lockId: string; pin: string; id: number }>;
    deleted: number[];
  } {
    const created: Array<{ lockId: string; pin: string; id: number }> = [];
    const deleted: number[] = [];
    let nextId = 9000;
    const client = {
      created,
      deleted,
      isAvailable() {
        return true;
      },
      async getAccessToken() {
        return "tok";
      },
      async createKeyboardPassword(params: { lockId: string | number; keyboardPwd: string }) {
        const lockId = String(params.lockId);
        const pin = String(params.keyboardPwd);
        if (opts?.collideOnLock?.(lockId, pin)) {
          throw new Error("TTLock erro -3007: The same passcode already exists. Please use another one.");
        }
        const keyboardPwdId = nextId++;
        created.push({ lockId, pin, id: keyboardPwdId });
        return { keyboardPwdId };
      },
      async deleteKeyboardPassword(params: { keyboardPwdId: number }) {
        if (opts?.failDelete) throw new Error("delete failed");
        deleted.push(Number(params.keyboardPwdId));
      },
      async changeKeyboardPassword() {
        return;
      },
    };
    return client as unknown as TtlockClient & {
      created: Array<{ lockId: string; pin: string; id: number }>;
      deleted: number[];
    };
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
    const itens: CredencialItemRow[] = [
      ["apt", "100"],
      ["ext", "101"],
      ["int", "102"],
    ].map(([k, lock], idx) => ({
      id: `item-${k}`,
      credencial_id: "cred-b",
      fechadura_id: `f-${idx}`,
      lock_id_ttlock: lock,
      tipo_destino: k === "apt" ? "apartamento" : "portao",
      codigo_logico_destino: String(k).toUpperCase(),
      status_provisionamento: "pendente" as const,
      ultimo_erro: null,
      provisionado_em: null,
      revogado_em: null,
      remote_keyboard_pwd_id: null,
      codigo_enviado: null,
    }));
    return { credencial, itens };
  }

  // CASO D: PIN ocupado em um portão → rejeitar candidato localmente
  {
    const { credencial, itens } = seedThreeLocks("4726");
    const repo = makeRepo({ credencial, itens, occupiedPins: ["4726"] });
    const ttlock = mockTtlock();
    const r = await processarCredencialDeAcesso("cred-b", {
      repository: repo,
      ttlockClient: ttlock,
      passcodeGenerator: (exclude) => {
        const set = new Set(
          typeof exclude === "string"
            ? [exclude]
            : exclude
              ? [...exclude]
              : [],
        );
        if (!set.has("9999")) return "9999";
        return "8888";
      },
    });
    assert.notEqual(r.passcode, "4726");
    assert.equal(r.accessReady, true);
    assert.equal(r.passcode, "9999");
    ok("D PIN livre no apto mas ocupado em portão → outro PIN");
  }

  // CASO E: 1º e 2º aceitam, 3º -3007 → rollback → novo PIN nos 3
  {
    const { credencial, itens } = seedThreeLocks("4321");
    const repo = makeRepo({ credencial, itens, occupiedPins: [] });
    const ttlock = mockTtlock({
      collideOnLock: (lockId, pin) => pin === "4321" && lockId === "102",
    });
    const r = await processarCredencialDeAcesso("cred-b", {
      repository: repo,
      ttlockClient: ttlock,
      passcodeGenerator: (exclude) => {
        const set = new Set(
          typeof exclude === "string"
            ? [exclude]
            : exclude
              ? [...exclude]
              : [],
        );
        if (!set.has("4321") && !set.has("7654")) return "4321";
        return "7654";
      },
    });
    assert.equal(r.accessReady, true);
    assert.equal(r.passcode, "7654");
    assert.ok(ttlock.deleted.length >= 2, "rollback removeu aceites parciais");
    const finals = ttlock.created.filter((c) => c.pin === "7654");
    assert.equal(finals.length, 3);
    assert.ok(repo.itens.every((i) => i.status_provisionamento === "provisionado"));
    assert.ok(repo.itens.every((i) => i.remote_keyboard_pwd_id != null));
    ok("E parcial + -3007 → rollback + novo PIN 3/3");
  }

  // CASO F: replay mesma reserva
  {
    const { credencial, itens } = seedThreeLocks("4455");
    const repo = makeRepo({ credencial, itens });
    const ttlock = mockTtlock();
    const r1 = await processarCredencialDeAcesso("cred-b", {
      repository: repo,
      ttlockClient: ttlock,
    });
    assert.equal(r1.passcode, "4455");
    const r2 = await processarCredencialDeAcesso("cred-b", {
      repository: repo,
      ttlockClient: ttlock,
    });
    assert.equal(r2.passcode, "4455");
    assert.equal(ttlock.created.length, 3);
    ok("F replay idempotente mesmo PIN");
  }

  // CASO G: reservas diferentes → PINs diferentes
  {
    const a = allocateNewTtlockPasscode(["0812"]);
    const b = allocateNewTtlockPasscode(["0812", a]);
    assert.notEqual(a, b);
    assert.notEqual(a, "0812");
    ok("G reservas distintas → PINs distintos");
  }

  // CASO H: 3 tentativas falham → ok=false / sem guest ready
  {
    const { credencial, itens } = seedThreeLocks(null);
    const repo = makeRepo({ credencial, itens });
    const ttlock = mockTtlock({
      collideOnLock: () => true,
    });
    const r = await processarCredencialDeAcesso("cred-b", {
      repository: repo,
      ttlockClient: ttlock,
      passcodeGenerator: (exclude) => generateRandomTtlockPasscode(exclude),
    });
    assert.equal(r.accessReady, false);
    assert.equal(r.status, "falhou");
    assert.equal(
      evaluateTtlockReadyForGuestAccess(repo.credencial, repo.itens).ready,
      false,
    );
    ok("H 3 falhas → sem guest_access_ready");
  }

  // Rollback falha → não accessReady
  {
    const { credencial, itens } = seedThreeLocks("4321");
    const repo = makeRepo({ credencial, itens });
    const ttlock = mockTtlock({
      collideOnLock: (lockId, pin) => pin === "4321" && lockId === "102",
      failDelete: true,
    });
    const r = await processarCredencialDeAcesso("cred-b", {
      repository: repo,
      ttlockClient: ttlock,
      passcodeGenerator: () => "4321",
    });
    assert.equal(r.accessReady, false);
    assert.equal(r.rollbackFailed, true);
    assert.ok(repo.itens.some((i) => i.status_provisionamento === "pendente_limpeza"));
    ok("rollback falhou → falha operacional sem envio");
  }

  {
    const resolved = resolveProvisionCredentialStatus([
      { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 1 },
      { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 2 },
      { status_provisionamento: "falhou", remote_keyboard_pwd_id: null },
    ]);
    assert.equal(resolved.allReady, false);
    assert.equal(resolved.status, "parcial");
    ok("parcial 2/3 não provisionada");
  }

  console.log("ok: test-ttlock-passcode-collision-gate");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
