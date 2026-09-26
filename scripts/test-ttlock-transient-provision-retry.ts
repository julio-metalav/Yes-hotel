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
  itemNeedsProvisionRetry,
  parseTransientRetryState,
  encodeTransientRetryState,
} from "../src/lib/domain/yes-hotel/ttlock-provision-retry.ts";
import { syncStatusForProvisionResult } from "../src/lib/domain/yes-hotel/ttlock-guest-access-gate.ts";
import { classifyTtlockPhase2Candidate } from "../src/lib/domain/yes-hotel/ttlock-provision-phase2.ts";
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
      return state.itens.filter((i) => itemNeedsProvisionRetry(i));
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
    // O lock isolado é a porta do apartamento: portão sozinho não deixa a credencial pronta.
    state.itens = makeItems([{}]);
    state.itens[0]!.tipo_destino = "apartamento";
    state.itens[0]!.codigo_logico_destino = "APT-35";
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

  {
    assert.equal(itemNeedsProvisionRetry({ status_provisionamento: "falhou", remote_keyboard_pwd_id: 41640128 }), true);
    assert.equal(itemNeedsProvisionRetry({ status_provisionamento: "revogado", remote_keyboard_pwd_id: 1 }), false);
    assert.equal(syncStatusForProvisionResult("provisionada"), "ok");
    assert.equal(syncStatusForProvisionResult("parcial"), "partial");
    assert.equal(syncStatusForProvisionResult("falhou"), "failed");
    assert.equal(
      findListedPasscodeMatch(
        [
          { keyboardPwdId: 1, keyboardPwd: "7575" },
          { keyboardPwdId: 2, keyboardPwd: "7575" },
        ],
        "7575",
      ),
      null,
    );
    ok("falhou com remote id volta ao retry; listagem ambígua não escolhe id");
  }

  {
    const r = await attemptProvisionLockWithSamePinRetry({
      passcode: "7575",
      shortRetryMax: 0,
      shortDelayMs: 0,
      budget: { sleptMs: 0, maxBudgetMs: 0 },
      sleepFn: async () => {},
      addPasscode: async () => {
        throw new Error("TTLock erro -3007: The same passcode already exists. Please use another one.");
      },
      listPasscodes: async () => [{ keyboardPwdId: 118066476, keyboardPwd: "7575" }],
      knownKeyboardPwdId: 118066476,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.reconciled, true);
      assert.equal(r.keyboardPwdId, 118066476);
    }
    ok("-3007 com o PIN exato na fechadura reconcilia e adota o keyboardPwdId");
  }

  {
    let listed = 0;
    const r = await attemptProvisionLockWithSamePinRetry({
      passcode: "7575",
      shortRetryMax: 0,
      shortDelayMs: 0,
      budget: { sleptMs: 0, maxBudgetMs: 0 },
      sleepFn: async () => {},
      addPasscode: async () => {
        throw new Error("TTLock erro -3007: The same passcode already exists.");
      },
      listPasscodes: async () => {
        listed++;
        return [{ keyboardPwdId: 999, keyboardPwd: "7575" }];
      },
      pinClaimAllowed: true,
      knownKeyboardPwdId: null,
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.stillRetryable, false);
      assert.equal(r.uncertain, false);
    }
    assert.equal(listed, 0);
    ok("-3007 sem remote id e sem tentativa incerta não adota o PIN da fechadura");
  }

  {
    let adds = 0;
    const r = await attemptProvisionLockWithSamePinRetry({
      passcode: "7575",
      shortRetryMax: 1,
      shortDelayMs: 0,
      budget: { sleptMs: 0, maxBudgetMs: 1 },
      sleepFn: async () => {},
      addPasscode: async () => {
        adds++;
        if (adds === 1) throw new Error("timeout");
        throw new Error("TTLock erro -3007: The same passcode already exists.");
      },
      listPasscodes: async () =>
        adds === 1 ? [] : [{ keyboardPwdId: 118066476, keyboardPwd: "7575" }],
      pinClaimAllowed: true,
      knownKeyboardPwdId: null,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.reconciled, true);
      assert.equal(r.keyboardPwdId, 118066476);
    }
    ok("-3007 sem remote id reconcilia só depois de tentativa incerta");
  }

  {
    const r = await attemptProvisionLockWithSamePinRetry({
      passcode: "7575",
      shortRetryMax: 0,
      shortDelayMs: 0,
      budget: { sleptMs: 0, maxBudgetMs: 0 },
      sleepFn: async () => {},
      addPasscode: async () => {
        throw new Error("TTLock erro -3007: The same passcode already exists.");
      },
      listPasscodes: async () => [{ keyboardPwdId: 99, keyboardPwd: "7575" }],
      pinClaimAllowed: false,
      knownKeyboardPwdId: 41640128,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.stillRetryable, false);
    ok("-3007 com PIN de outra credencial não marca provisionado");
  }

  {
    const r = await attemptProvisionLockWithSamePinRetry({
      passcode: "7575",
      shortRetryMax: 0,
      shortDelayMs: 0,
      budget: { sleptMs: 0, maxBudgetMs: 0 },
      sleepFn: async () => {},
      addPasscode: async () => {
        throw new Error("timeout");
      },
      listPasscodes: async () => {
        throw new Error("lock offline");
      },
    });
    assert.equal(r.ok, false);
    ok("timeout com listagem indisponível não vira sucesso");
  }

  {
    const state = {
      cred: { ...baseCred(), codigo_credencial: "7575", status: "parcial" as const, sync_status: "ok" as const },
      itens: makeItems([
        { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 11 },
        { status_provisionamento: "falhou", remote_keyboard_pwd_id: 22, ultimo_erro: "TTLock erro -3007" },
        { status_provisionamento: "falhou", remote_keyboard_pwd_id: 33, ultimo_erro: "Abortado: colisão" },
      ]),
    };
    const pins = new Set<string>();
    const client = makeClient({
      add: async (_lock, pin) => {
        pins.add(pin);
        throw new Error("TTLock erro -3007: The same passcode already exists.");
      },
      list: async (lockId) => {
        const id = Number(lockId);
        return [{ keyboardPwdId: id === 100 ? 11 : id === 101 ? 22 : 33, keyboardPwd: "7575" }];
      },
    });
    const r = await processarCredencialDeAcesso("cred-1", {
      repository: makeRepo(state),
      ttlockClient: client,
      retry: { shortDelayMs: 0, shortRetryMax: 0, shortBudgetMs: 0, sleepFn: async () => {} },
    });
    assert.equal(r.accessReady, true);
    assert.equal(r.status, "provisionada");
    assert.equal(state.cred.codigo_credencial, "7575");
    assert.equal(pins.size, 1);
    assert.equal(state.cred.sync_status, "ok");
    assert.equal(state.itens.every((i) => i.status_provisionamento === "provisionado"), true);
    ok("parcial 1/3 + falhou com remote id completa 3/3 no mesmo PIN");
  }

  {
    const state = {
      cred: { ...baseCred(), codigo_credencial: "7575", status: "parcial" as const, sync_status: "ok" as const },
      itens: makeItems([
        { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 11 },
        { status_provisionamento: "falhou", remote_keyboard_pwd_id: 22 },
        { status_provisionamento: "falhou", remote_keyboard_pwd_id: 33 },
      ]),
    };
    const repo = makeRepo(state);
    repo.listOccupiedPasscodesOnLocks = async () => ["7575"];
    const client = makeClient({
      add: async () => {
        throw new Error("TTLock erro -3007: The same passcode already exists.");
      },
      list: async () => [{ keyboardPwdId: 999, keyboardPwd: "7575" }],
    });
    const r = await processarCredencialDeAcesso("cred-1", {
      repository: repo,
      ttlockClient: client,
      passcodeGenerator: () => {
        throw new Error("não pode gerar PIN novo");
      },
      retry: { shortDelayMs: 0, shortRetryMax: 0, shortBudgetMs: 0, sleepFn: async () => {} },
    });
    assert.equal(r.accessReady, false);
    assert.equal(state.cred.codigo_credencial, "7575");
    assert.equal(state.cred.sync_status, "partial");
    assert.notEqual(state.cred.sync_status, "ok");
    const retryState = parseTransientRetryState(state.cred.last_sync_error);
    assert.ok(retryState?.nextEligibleAt);
    const nextEligibleAt = Date.parse(String(retryState?.nextEligibleAt));
    assert.equal(Number.isFinite(nextEligibleAt), true);
    const phase2Input = {
      credentialStatus: state.cred.status,
      codigoCredencial: state.cred.codigo_credencial,
      items: state.itens,
      senhaEnviadaEm: "2026-09-26T00:00:00.000Z",
      lastSyncError: state.cred.last_sync_error,
      acessoLiberado: true,
      reservaAtiva: true,
    };
    const beforeWindow = classifyTtlockPhase2Candidate({
      ...phase2Input,
      now: new Date(nextEligibleAt - 1_000),
    });
    assert.equal(beforeWindow.run, false);
    assert.equal(beforeWindow.reason, "fase2_aguardando_janela");
    const afterWindow = classifyTtlockPhase2Candidate({
      ...phase2Input,
      now: new Date(nextEligibleAt + 1_000),
    });
    assert.equal(afterWindow.run, true);
    assert.equal(afterWindow.kind, "provision_retry");
    ok("PIN já aplicado e não reconciliável permanece 7575, sync parcial, sem envio");
    ok("parcial com falha persistente espera nextEligibleAt antes de novo retry");
  }

  console.log("\nTodos os testes de retry transitório TTLock passaram.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
