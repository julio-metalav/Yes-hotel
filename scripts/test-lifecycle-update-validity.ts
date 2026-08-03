/**
 * Testes da action lifecycle_update_validity (política + orquestração sem senha).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateUpdateValidityAuth,
  executeLifecycleUpdateValidity,
  type CredencialValidityRow,
  type UpdateValidityPorts,
} from "../supabase/functions/_shared/lifecycle-update-validity.ts";
import {
  canCommitValidityToDatabase,
  isValidityAlreadyApplied,
  parseValidityIsoPair,
  rejectPasscodeFields,
  selectProvisionedItemsForValidityUpdate,
} from "../supabase/functions/_shared/lifecycle-update-validity-policy.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const CRED_ID = "64705bcb-6736-4329-96ae-f9413f3bb5d8";
const RESERVA_ID = "5321a46f-5000-43e1-8830-df57f3bc0439";
const WINDOW = {
  valido_de: "2026-08-08T17:00:00.000Z",
  valido_ate: "2026-08-10T15:00:00.000Z",
};
const WRONG_WINDOW = {
  valido_de: "2026-08-08T13:00:00.000Z",
  valido_ate: "2026-08-10T11:00:00.000Z",
};

function baseItens() {
  return [
    {
      id: "i1",
      codigo_logico_destino: "APT-10",
      lock_id_ttlock: "15615492",
      remote_keyboard_pwd_id: 100632532,
      status_provisionamento: "provisionado",
    },
    {
      id: "i2",
      codigo_logico_destino: "GATE-EXT",
      lock_id_ttlock: "25709122",
      remote_keyboard_pwd_id: 23895126,
      status_provisionamento: "provisionado",
    },
    {
      id: "i3",
      codigo_logico_destino: "GATE-INT",
      lock_id_ttlock: "25709168",
      remote_keyboard_pwd_id: 23894770,
      status_provisionamento: "provisionado",
    },
  ];
}

function createPorts(seed: {
  credencial: CredencialValidityRow | null;
  itens?: ReturnType<typeof baseItens>;
  failOnDestino?: string;
}): {
  ports: UpdateValidityPorts;
  state: {
    credencial: CredencialValidityRow | null;
    changeCalls: Array<{ destino: string; startDateMs: number; endDateMs: number; keys: string[] }>;
    dbUpdates: Array<{ valido_de: string; valido_ate: string }>;
  };
} {
  const state = {
    credencial: seed.credencial ? { ...seed.credencial } : null,
    changeCalls: [] as Array<{ destino: string; startDateMs: number; endDateMs: number; keys: string[] }>,
    dbUpdates: [] as Array<{ valido_de: string; valido_ate: string }>,
  };
  const itens = seed.itens ?? baseItens();

  const ports: UpdateValidityPorts = {
    async getCredencial(id) {
      if (!state.credencial || state.credencial.id !== id) return null;
      return { ...state.credencial };
    },
    async getItens() {
      return itens.map((i) => ({ ...i }));
    },
    async getReserva(reservaId) {
      if (reservaId !== RESERVA_ID) return null;
      return { check_in_previsto: "2026-08-08", check_out_previsto: "2026-08-10" };
    },
    async changeItemValidity({ item, startDateMs, endDateMs }) {
      const keys = ["lockId", "keyboardPwdId", "startDate", "endDate", "changeType"];
      state.changeCalls.push({
        destino: item.codigo_logico_destino,
        startDateMs,
        endDateMs,
        keys,
      });
      if (seed.failOnDestino && item.codigo_logico_destino === seed.failOnDestino) {
        throw new Error("TTLock erro 1: simulated change failure");
      }
    },
    async updateCredencialValidity({ credencialId, valido_de, valido_ate }) {
      assert.ok(state.credencial && state.credencial.id === credencialId);
      const senhaAntes = state.credencial.codigo_credencial;
      state.credencial = {
        ...state.credencial,
        valido_de,
        valido_ate,
        codigo_credencial: senhaAntes,
      };
      state.dbUpdates.push({ valido_de, valido_ate });
    },
  };

  return { ports, state };
}

async function main(): Promise<void> {
  // --- Auth: JWT ausente / sem permissão ---
  {
    const missing = evaluateUpdateValidityAuth({
      hasBearerToken: false,
      userResolved: false,
      perfilUsuario: null,
      ativo: false,
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.status, 401);
      assert.match(missing.error, /Autenticação/);
    }

    const noPerm = evaluateUpdateValidityAuth({
      hasBearerToken: true,
      userResolved: true,
      perfilUsuario: "viewer",
      ativo: true,
    });
    assert.equal(noPerm.ok, false);
    if (!noPerm.ok) {
      assert.equal(noPerm.status, 403);
    }

    const okAdmin = evaluateUpdateValidityAuth({
      hasBearerToken: true,
      userResolved: true,
      perfilUsuario: "admin",
      ativo: true,
    });
    assert.equal(okAdmin.ok, true);

    const okRecepcao = evaluateUpdateValidityAuth({
      hasBearerToken: true,
      userResolved: true,
      perfilUsuario: "recepcao",
      ativo: true,
    });
    assert.equal(okRecepcao.ok, true);
  }

  // --- Política: passcode rejeitado ---
  {
    assert.throws(() => rejectPasscodeFields({ passcode: "123456" }), /senha|passcode/i);
    assert.throws(() => rejectPasscodeFields({ newKeyboardPwd: "999999" }), /senha|passcode/i);
    rejectPasscodeFields({
      credencial_id: CRED_ID,
      valido_de: WINDOW.valido_de,
      valido_ate: WINDOW.valido_ate,
    });
  }

  // --- Datas ---
  {
    assert.throws(() => parseValidityIsoPair("nao-e-data", WINDOW.valido_ate), /invalid/i);
    assert.throws(
      () => parseValidityIsoPair(WINDOW.valido_ate, WINDOW.valido_de),
      /posterior/i,
    );
    const ok = parseValidityIsoPair(WINDOW.valido_de, WINDOW.valido_ate);
    assert.equal(ok.valido_de, WINDOW.valido_de);
    assert.equal(ok.valido_ate, WINDOW.valido_ate);
  }

  // --- Item sem remote_keyboard_pwd_id ---
  {
    const { ok, errors } = selectProvisionedItemsForValidityUpdate([
      {
        id: "x",
        codigo_logico_destino: "APT-10",
        lock_id_ttlock: "15615492",
        remote_keyboard_pwd_id: null,
        status_provisionamento: "provisionado",
      },
    ]);
    assert.equal(ok.length, 0);
    assert.ok(errors.some((e) => /remote_keyboard_pwd_id/.test(e)));
  }

  // --- Credencial inexistente ---
  {
    const { ports } = createPorts({ credencial: null });
    const r = await executeLifecycleUpdateValidity(
      { credencial_id: CRED_ID, ...WINDOW },
      ports,
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, 404);
      assert.match(r.error, /não encontrada/i);
      assert.equal(r.database_updated, false);
    }
  }

  // --- Passcode no payload ---
  {
    const { ports, state } = createPorts({
      credencial: {
        id: CRED_ID,
        reserva_id: RESERVA_ID,
        status: "provisionada",
        ...WRONG_WINDOW,
        codigo_credencial: "482910",
      },
    });
    const r = await executeLifecycleUpdateValidity(
      { credencial_id: CRED_ID, ...WINDOW, passcode: "482910" },
      ports,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.status, 400);
    assert.equal(state.changeCalls.length, 0);
    assert.equal(state.dbUpdates.length, 0);
  }

  // --- Data inválida / início > fim via execute ---
  {
    const { ports } = createPorts({
      credencial: {
        id: CRED_ID,
        reserva_id: RESERVA_ID,
        status: "provisionada",
        ...WRONG_WINDOW,
      },
    });
    const bad = await executeLifecycleUpdateValidity(
      { credencial_id: CRED_ID, valido_de: "abc", valido_ate: WINDOW.valido_ate },
      ports,
    );
    assert.equal(bad.ok, false);

    const inverted = await executeLifecycleUpdateValidity(
      {
        credencial_id: CRED_ID,
        valido_de: WINDOW.valido_ate,
        valido_ate: WINDOW.valido_de,
      },
      ports,
    );
    assert.equal(inverted.ok, false);
  }

  // --- Item sem remote id via execute ---
  {
    const itens = baseItens();
    itens[1] = { ...itens[1], remote_keyboard_pwd_id: null as unknown as number };
    const { ports, state } = createPorts({
      credencial: {
        id: CRED_ID,
        reserva_id: RESERVA_ID,
        status: "provisionada",
        ...WRONG_WINDOW,
        codigo_credencial: "482910",
      },
      itens,
    });
    const r = await executeLifecycleUpdateValidity(
      { credencial_id: CRED_ID, ...WINDOW },
      ports,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /remote_keyboard_pwd_id/);
    assert.equal(state.dbUpdates.length, 0);
  }

  // --- Update dos 3 itens + sucesso grava banco + senha intacta ---
  {
    const { ports, state } = createPorts({
      credencial: {
        id: CRED_ID,
        reserva_id: RESERVA_ID,
        status: "provisionada",
        ...WRONG_WINDOW,
        codigo_credencial: "482910",
      },
    });
    const r = await executeLifecycleUpdateValidity(
      { credencial_id: CRED_ID, ...WINDOW },
      ports,
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.database_updated, true);
      assert.equal(r.itens_atualizados, 3);
      assert.equal(r.valido_de, WINDOW.valido_de);
      assert.equal(r.valido_ate, WINDOW.valido_ate);
    }
    assert.equal(state.changeCalls.length, 3);
    assert.deepEqual(
      state.changeCalls.map((c) => c.destino).sort(),
      ["APT-10", "GATE-EXT", "GATE-INT"],
    );
    for (const call of state.changeCalls) {
      assert.equal(call.startDateMs, Date.parse(WINDOW.valido_de));
      assert.equal(call.endDateMs, Date.parse(WINDOW.valido_ate));
      assert.ok(!call.keys.includes("newKeyboardPwd"));
      assert.ok(!call.keys.includes("keyboardPwd"));
    }
    assert.equal(state.dbUpdates.length, 1);
    assert.equal(state.credencial?.codigo_credencial, "482910");
    assert.equal(state.credencial?.valido_de, WINDOW.valido_de);
    assert.equal(state.credencial?.valido_ate, WINDOW.valido_ate);
  }

  // --- Falha no segundo item não atualiza banco ---
  {
    const { ports, state } = createPorts({
      credencial: {
        id: CRED_ID,
        reserva_id: RESERVA_ID,
        status: "provisionada",
        ...WRONG_WINDOW,
        codigo_credencial: "482910",
      },
      failOnDestino: "GATE-EXT",
    });
    const r = await executeLifecycleUpdateValidity(
      { credencial_id: CRED_ID, ...WINDOW },
      ports,
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.database_updated, false);
      assert.ok((r.itens_alterados?.length ?? 0) >= 1);
      assert.ok((r.itens_falha?.length ?? 0) >= 1);
      assert.ok(r.itens_falha?.some((f) => f.codigo_logico_destino === "GATE-EXT"));
      assert.equal(
        canCommitValidityToDatabase([...(r.itens_alterados ?? []), ...(r.itens_falha ?? [])]),
        false,
      );
    }
    assert.equal(state.dbUpdates.length, 0);
    assert.equal(state.credencial?.valido_de, WRONG_WINDOW.valido_de);
    assert.equal(state.credencial?.codigo_credencial, "482910");
  }

  // --- Idempotência ---
  {
    const { ports, state } = createPorts({
      credencial: {
        id: CRED_ID,
        reserva_id: RESERVA_ID,
        status: "provisionada",
        ...WINDOW,
        codigo_credencial: "482910",
      },
    });
    assert.equal(
      isValidityAlreadyApplied(WINDOW.valido_de, WINDOW.valido_ate, WINDOW),
      true,
    );
    const r = await executeLifecycleUpdateValidity(
      { credencial_id: CRED_ID, ...WINDOW },
      ports,
    );
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.idempotent, true);
      assert.equal(r.database_updated, false);
      assert.equal(r.itens_atualizados, 0);
    }
    assert.equal(state.changeCalls.length, 0);
    assert.equal(state.dbUpdates.length, 0);
    assert.equal(state.credencial?.codigo_credencial, "482910");
  }

  // --- Edge registra a action e change não envia senha ---
  {
    const edgeSrc = readFileSync(
      join(root, "supabase/functions/yes-hotel-lifecycle/index.ts"),
      "utf8",
    );
    assert.match(edgeSrc, /lifecycle_update_validity/);
    assert.match(edgeSrc, /handleLifecycleUpdateValidity/);
    assert.match(edgeSrc, /ttlockChangeKeyboardPasswordValidity/);
    assert.match(edgeSrc, /ensureCallerAllowed\(request\)/);
    const changeFn = edgeSrc.slice(
      edgeSrc.indexOf("async function ttlockChangeKeyboardPasswordValidity"),
      edgeSrc.indexOf("type CredencialRow"),
    );
    assert.ok(!/newKeyboardPwd/.test(changeFn));
    assert.ok(!/params\.append\("keyboardPwd"/.test(changeFn));
  }

  console.log("OK test-lifecycle-update-validity");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
