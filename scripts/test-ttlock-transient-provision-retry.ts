/**
 * CASOS A–H: retry transitório mesmo PIN + reconciliação + gate guest_access_ready.
 */
import assert from "node:assert/strict";
import {
  processarCredencialDeAcesso,
  type CredencialItemRow,
  type CredencialRow,
  type ProvisioningRepository,
} from "../src/lib/application/yes-hotel/provisioning-executor.ts";
import {
  evaluateTtlockReadyForGuestAccess,
  isLifecycleProvisionAccessReady,
  resolveProvisionCredentialStatus,
} from "../src/lib/domain/yes-hotel/ttlock-guest-access-gate.ts";
import {
  attemptProvisionLockWithSamePinRetry,
  classifyTtlockProvisionError,
  findListedPasscodeMatch,
  parseTransientRetryState,
  encodeTransientRetryState,
} from "../src/lib/domain/yes-hotel/ttlock-provision-retry.ts";
import { TtlockApiError } from "../src/lib/integrations/ttlock/types.ts";
import type { TtlockClient } from "../src/lib/integrations/ttlock/client.ts";

function ok(msg: string) {
  console.log("ok:", msg);
}

function baseCred(): CredencialRow {
  return {
    id: "cred-1",
    reserva_id: "res-1",
    status: "pendente",
    valido_de: "2026-08-12T13:00:00.000Z",
    valido_ate: "2026-08-13T15:00:00.000Z",
    codigo_credencial: "4242",
    provider_tipo: "ttlock_passcode",
    last_sync_error: null,
  };
}

function makeItems(statuses: Array<Partial<CredencialItemRow>>): CredencialItemRow[] {
  const dest = ["portao_externo", "portao_interno", "apartamento"];
  return statuses.map((s, i) => ({
    id: `item-${i + 1}`,
    credencial_id: "cred-1",
    fechadura_id: `f-${i + 1}`,
    lock_id_ttlock: String(100 + i),
    tipo_destino: dest[i] || "apartamento",
    codigo_logico_destino: dest[i] || `d-${i}`,
    status_provisionamento: s.status_provisionamento || "pendente",
    ultimo_erro: s.ultimo_erro ?? null,
    provisionado_em: s.provisionado_em ?? null,
    revogado_em: null,
    remote_keyboard_pwd_id: s.remote_keyboard_pwd_id ?? null,
    codigo_enviado: s.codigo_enviado ?? null,
  }));
}

function makeRepo(state: {
  cred: CredencialRow;
  itens: CredencialItemRow[];
}): ProvisioningRepository {
  return {
    async getCredencial() {
      return { ...state.cred };
    },
    async getCredencialPorReserva() {
      return { ...state.cred };
    },
    async getCredenciaisPendentes() {
      return [{ ...state.cred }];
    },
    async getItens() {
      return state.itens.map((i) => ({ ...i }));
    },
    async getItensPendentes() {
      return state.itens.filter(
        (i) =>
          i.status_provisionamento === "pendente" ||
          i.status_provisionamento === "provisionando" ||
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
      Object.assign(state.cred, patch);
    },
    async getCredenciaisComPendenciaSync() {
      return [];
    },
    async updateItem(id, patch) {
      const item = state.itens.find((i) => i.id === id);
      if (!item) throw new Error("item " + id);
      Object.assign(item, patch);
    },
    async getReservaApartment() {
      return "35";
    },
    async getFechadurasForApartment() {
      return [];
    },
    async getReservaTtlockCredentialSource() {
      return {
        reserva_id: "res-1",
        apartamento: "35",
        external_reservation_id: "EXT",
        principal_guest_nome: "Teste",
        hospede_principal: "Teste",
      };
    },
    async listOccupiedPasscodesOnLocks() {
      return [];
    },
  };
}

function makeClient(handlers: {
  add: (lockId: string | number, pin: string, n: number) => Promise<number>;
  list?: (lockId: string | number) => Promise<Array<{ keyboardPwdId: number; keyboardPwd?: string }>>;
  delete?: () => Promise<void>;
}): TtlockClient {
  let addN = 0;
  return {
    isAvailable: () => true,
    createKeyboardPassword: async (p) => {
      addN += 1;
      const id = await handlers.add(p.lockId, p.keyboardPwd, addN);
      return { keyboardPwdId: id };
    },
    listKeyboardPasswords: async (p) => {
      if (!handlers.list) return [];
      return handlers.list(p.lockId);
    },
    deleteKeyboardPassword: async () => {
      await handlers.delete?.();
      return { errcode: 0 };
    },
  } as unknown as TtlockClient;
}

async function main() {
  // Classificador
  {
    assert.equal(classifyTtlockProvisionError(new Error("timeout")).transient, true);
    assert.equal(classifyTtlockProvisionError(new Error("timeout")).retrySamePin, true);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    assert.equal(classifyTtlockProvisionError(abort).uncertain, true);
    assert.equal(
      classifyTtlockProvisionError(new Error("TTLock erro -3007: same passcode")).class,
      "collision",
    );
    assert.equal(
      classifyTtlockProvisionError(new TtlockApiError("unauthorized", 401, {})).class,
      "auth_config",
    );
    assert.equal(
      classifyTtlockProvisionError(new TtlockApiError("boom", 503, {})).transient,
      true,
    );
    assert.equal(
      classifyTtlockProvisionError(
        new Error("TTLock: credenciais nao configuradas. Configure TTLOCK_CLIENT_ID"),
      ).class,
      "auth_config",
    );
    ok("classificador transitório / colisão / auth");
  }

  {
    const match = findListedPasscodeMatch(
      [
        { keyboardPwdId: 9, keyboardPwd: "1111" },
        { keyboardPwdId: 42, keyboardPwd: "4242" },
      ],
      "4242",
    );
    assert.equal(match?.keyboardPwdId, 42);
    const enc = encodeTransientRetryState({
      phase: 2,
      count: 3,
      errorClass: "uncertain",
      nextEligibleAt: "2026-01-01T00:00:00.000Z",
    });
    const parsed = parseTransientRetryState(enc);
    assert.equal(parsed?.count, 3);
    assert.equal(parsed?.phase, 2);
    ok("reconciliação list + estado fase 2");
  }

  {
    const r = resolveProvisionCredentialStatus([
      { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 1 },
      { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 2 },
      { status_provisionamento: "provisionando", remote_keyboard_pwd_id: null },
    ]);
    assert.equal(r.status, "provisionando");
    assert.equal(r.allReady, false);
    ok("status provisionando com 2/3");
  }

  // CASO A: timeout → retry mesmo PIN → sucesso
  {
    const state = {
      cred: baseCred(),
      itens: makeItems([{}, {}, {}]),
    };
    let calls = 0;
    const pinSeen = new Set<string>();
    const client = makeClient({
      add: async (_l, pin) => {
        calls++;
        pinSeen.add(pin);
        if (calls === 1) {
          const e = new Error("TTLock add timeout/aborted");
          e.name = "AbortError";
          throw e;
        }
        return 1000 + calls;
      },
      list: async () => [],
    });
    const r = await processarCredencialDeAcesso("cred-1", {
      repository: makeRepo(state),
      ttlockClient: client,
      retry: { shortDelayMs: 0, shortRetryMax: 3, shortBudgetMs: 999999, phase2Max: 5, sleepFn: async () => {} },
    });
    assert.equal(r.accessReady, true);
    assert.equal(r.status, "provisionada");
    assert.equal(pinSeen.size, 1);
    assert.equal([...pinSeen][0], "4242");
    assert.equal(
      evaluateTtlockReadyForGuestAccess(state.cred, state.itens).ready,
      true,
    );
    ok("CASO A timeout → retry mesmo PIN → 3/3");
  }

  // CASO B: 5xx duas vezes → sucesso na terceira
  {
    const state = { cred: baseCred(), itens: makeItems([{}, {}, {}]) };
    let failsLeft = 2;
    const client = makeClient({
      add: async () => {
        if (failsLeft > 0) {
          failsLeft--;
          throw new TtlockApiError("server error", 503, { errcode: -1, errmsg: "busy" });
        }
        return 2001;
      },
      list: async () => [],
    });
    // Força um único lock para isolar contagem de 5xx (3 locks × retries complicam).
    state.itens = makeItems([{}]);
    const r = await processarCredencialDeAcesso("cred-1", {
      repository: makeRepo(state),
      ttlockClient: client,
      retry: { shortDelayMs: 0, shortRetryMax: 5, shortBudgetMs: 999999, sleepFn: async () => {} },
    });
    assert.equal(r.accessReady, true);
    assert.equal(state.cred.codigo_credencial, "4242");
    ok("CASO B 5xx ×2 → mesmo PIN → sucesso");
  }

  // CASO C: -3007 → sem espera transitória; novo PIN (#64)
  {
    const state = { cred: baseCred(), itens: makeItems([{}, {}, {}]) };
    let pinSeq = 0;
    const pins: string[] = [];
    const client = makeClient({
      add: async (_l, pin) => {
        pins.push(pin);
        if (pin === "4242") {
          throw new Error("TTLock erro -3007: The same passcode already exists.");
        }
        return 3000 + pins.length;
      },
      list: async () => [],
      delete: async () => {},
    });
    const r = await processarCredencialDeAcesso("cred-1", {
      repository: makeRepo(state),
      ttlockClient: client,
      passcodeGenerator: () => {
        pinSeq++;
        return `9${pinSeq}99`;
      },
      retry: { shortDelayMs: 0, shortRetryMax: 0, shortBudgetMs: 0, sleepFn: async () => {} },
    });
    assert.equal(r.accessReady, true);
    assert.notEqual(state.cred.codigo_credencial, "4242");
    ok("CASO C -3007 → novo PIN sem retry transitório");
  }

  // CASO D: 401 → sem loop
  {
    const state = { cred: baseCred(), itens: makeItems([{}, {}, {}]) };
    let calls = 0;
    const client = makeClient({
      add: async () => {
        calls++;
        throw new TtlockApiError("unauthorized", 401, {});
      },
      list: async () => [],
    });
    const r = await processarCredencialDeAcesso("cred-1", {
      repository: makeRepo(state),
      ttlockClient: client,
      retry: { shortDelayMs: 0, shortRetryMax: 6, shortBudgetMs: 999999, sleepFn: async () => {} },
    });
    assert.equal(r.accessReady, false);
    assert.equal(r.retryable, false);
    assert.ok(calls <= 3, "sem loop de retries transitórios por lock");
    assert.equal(r.status === "falhou" || r.status === "parcial", true);
    ok("CASO D 401/config → sem loop transitório");
  }

  // CASO E: lock 1–2 OK, lock 3 timeout → mantém 1–2, retry 3, sucesso
  {
    const state = { cred: baseCred(), itens: makeItems([{}, {}, {}]) };
    const attemptsByLock = new Map<string, number>();
    const client = makeClient({
      add: async (lockId) => {
        const k = String(lockId);
        const n = (attemptsByLock.get(k) || 0) + 1;
        attemptsByLock.set(k, n);
        if (k === "102" && n === 1) {
          const e = new Error("gateway timeout");
          e.name = "AbortError";
          throw e;
        }
        return Number(k) * 10 + n;
      },
      list: async () => [],
    });
    const r = await processarCredencialDeAcesso("cred-1", {
      repository: makeRepo(state),
      ttlockClient: client,
      retry: { shortDelayMs: 0, shortRetryMax: 3, shortBudgetMs: 999999, sleepFn: async () => {} },
    });
    assert.equal(r.accessReady, true);
    assert.equal(state.itens.filter((i) => i.status_provisionamento === "provisionado").length, 3);
    assert.equal(state.cred.codigo_credencial, "4242");
    ok("CASO E 2/3 + timeout no 3º → retry mesmo PIN → 3/3");
  }

  // CASO F: timeout mas TTLock criou → reconciliação
  {
    const budget = { sleptMs: 0, maxBudgetMs: 999999 };
    let added = false;
    const r = await attemptProvisionLockWithSamePinRetry({
      passcode: "4242",
      shortRetryMax: 2,
      shortDelayMs: 0,
      budget,
      sleepFn: async () => {},
      addPasscode: async () => {
        if (!added) {
          added = true;
          const e = new Error("timeout after send");
          e.name = "AbortError";
          throw e;
        }
        throw new Error("não deveria recriar");
      },
      listPasscodes: async () => [{ keyboardPwdId: 777, keyboardPwd: "4242" }],
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.reconciled, true);
      assert.equal(r.keyboardPwdId, 777);
    }
    ok("CASO F reconciliação após timeout");
  }

  // CASO G: retries esgotados → falhou, sem guest_access_ready
  {
    const state = {
      cred: { ...baseCred(), last_sync_error: encodeTransientRetryState({
        phase: 2,
        count: 5,
        errorClass: "transient",
        nextEligibleAt: null,
      }) },
      itens: makeItems([{}, {}, {}]),
    };
    const client = makeClient({
      add: async () => {
        throw new TtlockApiError("unavailable", 503, {});
      },
      list: async () => [],
    });
    const r = await processarCredencialDeAcesso("cred-1", {
      repository: makeRepo(state),
      ttlockClient: client,
      retry: {
        shortDelayMs: 0,
        shortRetryMax: 0,
        shortBudgetMs: 0,
        phase2Max: 5,
        sleepFn: async () => {},
      },
    });
    assert.equal(r.accessReady, false);
    assert.equal(r.retryable, false);
    assert.ok(r.status === "falhou" || r.status === "parcial");
    assert.equal(
      evaluateTtlockReadyForGuestAccess(state.cred, state.itens).ready,
      false,
    );
    assert.equal(
      isLifecycleProvisionAccessReady({ ok: false, status: r.status, falhas: r.falhas }),
      false,
    );
    ok("CASO G retries esgotados → falhou sem guest_access_ready");
  }

  // CASO H: replay após sucesso → não reprovisiona
  {
    const state = {
      cred: { ...baseCred(), status: "provisionada" as const },
      itens: makeItems([
        {
          status_provisionamento: "provisionado",
          remote_keyboard_pwd_id: 1,
          codigo_enviado: "4242",
        },
        {
          status_provisionamento: "provisionado",
          remote_keyboard_pwd_id: 2,
          codigo_enviado: "4242",
        },
        {
          status_provisionamento: "provisionado",
          remote_keyboard_pwd_id: 3,
          codigo_enviado: "4242",
        },
      ]),
    };
    let adds = 0;
    const client = makeClient({
      add: async () => {
        adds++;
        return 99;
      },
    });
    const r = await processarCredencialDeAcesso("cred-1", {
      repository: makeRepo(state),
      ttlockClient: client,
      retry: { shortDelayMs: 0, sleepFn: async () => {} },
    });
    assert.equal(adds, 0);
    assert.equal(r.accessReady, true);
    assert.equal(r.status, "provisionada");
    ok("CASO H replay → sem reprovisionar");
  }

  // Transitório intermediário: status provisionando (não falhou)
  {
    const state = { cred: baseCred(), itens: makeItems([{}, {}, {}]) };
    const client = makeClient({
      add: async (lockId) => {
        if (String(lockId) === "102") {
          throw new TtlockApiError("busy", 503, {});
        }
        return Number(lockId) + 50;
      },
      list: async () => [],
    });
    const r = await processarCredencialDeAcesso("cred-1", {
      repository: makeRepo(state),
      ttlockClient: client,
      retry: {
        shortDelayMs: 0,
        shortRetryMax: 0,
        shortBudgetMs: 0,
        phase2Max: 5,
        sleepFn: async () => {},
      },
    });
    assert.equal(r.status, "provisionando");
    assert.equal(r.retryable, true);
    assert.equal(r.accessReady, false);
    assert.equal(
      state.itens.filter((i) => i.status_provisionamento === "provisionado").length,
      2,
    );
    assert.equal(state.itens[2].status_provisionamento, "provisionando");
    ok("2/3 transitório → provisionando (não falhou / sem rollback)");
  }

  console.log("\nTodos os testes de retry transitório TTLock passaram.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
