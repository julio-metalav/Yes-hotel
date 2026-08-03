/**
 * Testes essenciais: Gerar nova senha + configuração do scheduler 13h.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  replaceCredentialWithNewPasscode,
} from "../src/lib/application/yes-hotel/credential-lifecycle";
import {
  aplicarLiberacaoCredenciais13h,
  resetCredentialReleaseOrchestratorLocks,
  type CredentialReleasePorts,
  type CredentialReleaseReservationState,
} from "../src/lib/application/yes-hotel/credential-release-orchestrator";
import type {
  CredencialItemRow,
  CredencialRow,
  NovoItemDestino,
  ProvisioningRepository,
} from "../src/lib/application/yes-hotel/provisioning-executor";
import { generateRandomTtlockPasscode } from "../src/lib/domain/yes-hotel/ttlock-credential-format";
import type { TtlockClient } from "../src/lib/integrations/ttlock";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function createMemoryRepo(seed: {
  credencial: CredencialRow;
  itens: CredencialItemRow[];
}): ProvisioningRepository & {
  credencial: CredencialRow;
  itens: CredencialItemRow[];
} {
  const state = {
    credencial: { ...seed.credencial },
    itens: seed.itens.map((i) => ({ ...i })),
  };

  const repo: ProvisioningRepository & typeof state = {
    ...state,
    async getCredencial(id) {
      return state.credencial.id === id ? { ...state.credencial } : null;
    },
    async getCredencialPorReserva(reservaId) {
      return state.credencial.reserva_id === reservaId
        ? { ...state.credencial }
        : null;
    },
    async getCredenciaisPendentes() {
      return state.credencial.status === "pendente" ? [{ ...state.credencial }] : [];
    },
    async getItens(credencialId) {
      return state.itens
        .filter((i) => i.credencial_id === credencialId)
        .map((i) => ({ ...i }));
    },
    async getItensPendentes(credencialId) {
      return state.itens
        .filter(
          (i) =>
            i.credencial_id === credencialId &&
            i.status_provisionamento === "pendente",
        )
        .map((i) => ({ ...i }));
    },
    async getItensProvisionados(credencialId) {
      return state.itens
        .filter(
          (i) =>
            i.credencial_id === credencialId &&
            i.status_provisionamento === "provisionado",
        )
        .map((i) => ({ ...i }));
    },
    async getItensPendentesLimpeza(credencialId) {
      return state.itens
        .filter(
          (i) =>
            i.credencial_id === credencialId &&
            i.status_provisionamento === "pendente_limpeza",
        )
        .map((i) => ({ ...i }));
    },
    async insertItem(_credencialId: string, _destino: NovoItemDestino) {
      throw new Error("insertItem não usado neste teste");
    },
    async updateCredencial(id, patch) {
      if (state.credencial.id !== id) return;
      Object.assign(state.credencial, patch);
    },
    async getCredenciaisComPendenciaSync() {
      return [];
    },
    async updateItem(id, patch) {
      const item = state.itens.find((i) => i.id === id);
      if (item) Object.assign(item, patch);
    },
    async getReservaApartment() {
      return "01";
    },
    async getReservaTtlockCredentialSource(reservaId) {
      return {
        reserva_id: reservaId,
        apartamento: "01",
        external_reservation_id: "EXT-1001",
        principal_guest_nome: "Ana Silva",
        hospede_principal: "Ana Silva",
      };
    },
    async getFechadurasForApartment() {
      return [];
    },
  };
  return repo;
}

function createMockTtlock(options?: {
  failDelete?: boolean;
  failCreate?: boolean;
}): TtlockClient & { createdPasscodes: string[]; deletedIds: number[] } {
  const createdPasscodes: string[] = [];
  const deletedIds: number[] = [];
  let nextId = 9000;
  const client = {
    createdPasscodes,
    deletedIds,
    isAvailable() {
      return true;
    },
    async createKeyboardPassword(params: { keyboardPwd: string }) {
      if (options?.failCreate) throw new Error("Falha simulada ao criar passcode");
      createdPasscodes.push(String(params.keyboardPwd));
      nextId += 1;
      return { keyboardPwdId: nextId };
    },
    async deleteKeyboardPassword(params: { keyboardPwdId: number }) {
      if (options?.failDelete) throw new Error("Falha simulada ao revogar passcode");
      deletedIds.push(Number(params.keyboardPwdId));
    },
    async changeKeyboardPassword() {
      return;
    },
  };
  return client as unknown as TtlockClient & {
    createdPasscodes: string[];
    deletedIds: number[];
  };
}

function seedCredencial(passcode = "1234") {
  const credencial: CredencialRow = {
    id: "cred-1",
    reserva_id: "res-1",
    status: "provisionada",
    valido_de: "2026-08-03T13:00:00.000Z",
    valido_ate: "2026-08-05T12:00:00.000Z",
    codigo_credencial: passcode,
    provider_tipo: "ttlock_passcode",
  };
  const itens: CredencialItemRow[] = [
    {
      id: "item-1",
      credencial_id: "cred-1",
      fechadura_id: "fech-1",
      lock_id_ttlock: "100",
      tipo_destino: "apartamento",
      codigo_logico_destino: "APT-01",
      status_provisionamento: "provisionado",
      ultimo_erro: null,
      provisionado_em: "2026-08-03T12:00:00.000Z",
      revogado_em: null,
      remote_keyboard_pwd_id: 555,
      codigo_enviado: passcode,
    },
  ];
  return { credencial, itens };
}

async function main() {
  // 1) reenvio mantém a mesma senha (sem chamar replace)
  {
    const { credencial, itens } = seedCredencial("4321");
    const repo = createMemoryRepo({ credencial, itens });
    const ttlock = createMockTtlock();
    const passcodeReenvio = (await repo.getCredencial("cred-1"))!.codigo_credencial;
    assert.equal(passcodeReenvio, "4321");
    assert.equal(ttlock.createdPasscodes.length, 0);
    assert.equal(ttlock.deletedIds.length, 0);
  }

  // 2+3+5) gerar nova senha cria nova credencial; anterior revogada; provisiona só a nova
  {
    const { credencial, itens } = seedCredencial("4321");
    const repo = createMemoryRepo({ credencial, itens });
    const ttlock = createMockTtlock();
    const result = await replaceCredentialWithNewPasscode("cred-1", {
      repository: repo,
      ttlockClient: ttlock,
      passcodeGenerator: () => "8877",
    });
    assert.equal(result.bloqueadoPorLimpeza, false);
    assert.equal(result.passcodeAnterior, "4321");
    assert.equal(result.passcode, "8877");
    assert.ok(result.provisionados >= 1);
    assert.deepEqual(ttlock.deletedIds, [555]);
    assert.deepEqual(ttlock.createdPasscodes, ["8877"]);
    assert.equal(repo.credencial.codigo_credencial, "8877");
    assert.ok(repo.itens[0].remote_keyboard_pwd_id != null);
    assert.notEqual(repo.itens[0].remote_keyboard_pwd_id, 555);
  }

  // 4) falha ao gerar a nova → sem provisionamento útil (envio não deve ocorrer)
  {
    const { credencial, itens } = seedCredencial("1111");
    const repo = createMemoryRepo({ credencial, itens });
    const ttlock = createMockTtlock({ failCreate: true });
    const result = await replaceCredentialWithNewPasscode("cred-1", {
      repository: repo,
      ttlockClient: ttlock,
      passcodeGenerator: () => "2222",
    });
    assert.ok(result.falhas > 0 || result.provisionados === 0);
    assert.equal(ttlock.deletedIds.length, 1);
    assert.equal(result.provisionados, 0);
  }

  // 3b) falha de revogação → pendente_limpeza; não cria nova
  {
    const { credencial, itens } = seedCredencial("3333");
    const repo = createMemoryRepo({ credencial, itens });
    const ttlock = createMockTtlock({ failDelete: true });
    const result = await replaceCredentialWithNewPasscode("cred-1", {
      repository: repo,
      ttlockClient: ttlock,
      passcodeGenerator: () => "4444",
    });
    assert.equal(result.bloqueadoPorLimpeza, true);
    assert.equal(result.limpezaPendente, 1);
    assert.equal(result.passcode, "3333");
    assert.equal(repo.itens[0].status_provisionamento, "pendente_limpeza");
    assert.equal(ttlock.createdPasscodes.length, 0);
  }

  // 6) concorrência: duas solicitações não criam duas novas senhas
  {
    const { credencial, itens } = seedCredencial("5555");
    const repo = createMemoryRepo({ credencial, itens });
    let createCalls = 0;
    const base = createMockTtlock();
    const slowClient = {
      ...base,
      async createKeyboardPassword(params: { keyboardPwd: string }) {
        createCalls += 1;
        await new Promise((r) => setTimeout(r, 50));
        return base.createKeyboardPassword(params);
      },
      async deleteKeyboardPassword(params: { keyboardPwdId: number }) {
        await new Promise((r) => setTimeout(r, 20));
        return base.deleteKeyboardPassword(params);
      },
    } as unknown as TtlockClient;

    const p1 = replaceCredentialWithNewPasscode("cred-1", {
      repository: repo,
      ttlockClient: slowClient,
      passcodeGenerator: () => "6666",
    });
    await new Promise((r) => setTimeout(r, 5));
    const p2 = replaceCredentialWithNewPasscode("cred-1", {
      repository: repo,
      ttlockClient: slowClient,
      passcodeGenerator: () => "7777",
    });
    const [a, b] = await Promise.all([p1, p2]);
    const oks = [a, b].filter((r) => r.provisionados > 0 && !r.bloqueadoPorLimpeza);
    const blocked = [a, b].filter((r) =>
      r.erros.some((e) => /em andamento/i.test(e)),
    );
    assert.equal(oks.length, 1, "apenas uma geração deve concluir");
    assert.ok(blocked.length >= 1, "segunda deve ser bloqueada");
    assert.ok(createCalls <= 1, "não deve criar dois passcodes remotos");
  }

  // 7) gatilho 13h já enviado é ignorado
  {
    resetCredentialReleaseOrchestratorLocks();
    const agora = new Date(Date.UTC(2026, 7, 3, 18, 0));
    const rows: CredentialReleaseReservationState[] = [
      {
        reservaId: "res-ja",
        pagamentoStatus: "pendente",
        fnrhStatus: "pendente",
        senhaEnviada: true,
        dataHoraCheckin: new Date(Date.UTC(2026, 7, 3, 14, 0)),
        email: "a@x.invalid",
        whatsapp: "1",
        acessoLiberado: true,
        cancelada: false,
        encerrada: false,
        temCredencialValida: true,
        ultimaFalhaTipo: null,
      },
    ];
    let sendCalls = 0;
    const ports: CredentialReleasePorts = {
      async loadReservation(id) {
        return rows.find((r) => r.reservaId === id) ?? null;
      },
      async listCheckinsOnDate() {
        return rows;
      },
      async ensureAccessLiberated() {
        return { ok: true };
      },
      async sendCredentials() {
        sendCalls += 1;
        return { ok: true };
      },
      async registerEvent() {},
      now: () => agora,
    };
    const batch = await aplicarLiberacaoCredenciais13h(ports, {
      timeZone: "UTC",
      dataHoraAtual: agora,
      dateYmd: "2026-08-03",
    });
    assert.equal(batch.enviadas, 0);
    assert.ok(batch.ignoradas >= 1);
    assert.equal(sendCalls, 0);
  }

  // 8) configuração do scheduler aponta para a função correta
  {
    const sql = readFileSync(
      join(root, "supabase/pending/senha-auto-envio-cron.sql"),
      "utf8",
    );
    assert.match(sql, /PENDENTE DE APLICAÇÃO/);
    assert.match(sql, /senha-auto-envio/);
    assert.match(sql, /"mode":"13h"/);
    assert.match(sql, /x-senha-scheduler-token/);
    assert.match(sql, /5 17 \* \* \*/);
    const doc = readFileSync(
      join(root, "docs/YES_HOTEL_SENHA_AUTO_ENVIO_SCHEDULER.md"),
      "utf8",
    );
    assert.match(doc, /senha-auto-envio/);
    assert.match(doc, /SENHA_SCHEDULER_TOKEN/);
  }

  {
    const a = generateRandomTtlockPasscode("1234");
    assert.equal(a.length, 4);
    assert.notEqual(a, "1234");
  }

  console.log("Gerar nova senha + scheduler 13h: testes essenciais concluídos.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
