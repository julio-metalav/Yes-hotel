import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleRoomChange } from "../src/lib/application/yes-hotel/credential-lifecycle.ts";
import type {
  CredencialItemRow,
  CredencialRow,
  NovoItemDestino,
  ProvisioningRepository,
} from "../src/lib/application/yes-hotel/provisioning-executor.ts";
import {
  evaluateTtlockReadyForGuestAccess,
  resolveProvisionCredentialStatus,
} from "../src/lib/domain/yes-hotel/ttlock-guest-access-gate.ts";
import type { TtlockClient } from "../src/lib/integrations/ttlock/client.ts";

let cases = 0;
function ok(name: string) {
  cases++;
  console.log("  ok", name);
}

function destino(
  fechadura_id: string,
  lock_id_ttlock: string,
  tipo_destino: string,
  codigo_logico_destino: string,
): NovoItemDestino {
  return { fechadura_id, lock_id_ttlock, tipo_destino, codigo_logico_destino };
}

const DESTINOS: Record<string, NovoItemDestino[]> = {
  "10": [
    destino("f10", "1010", "apartamento", "APT-10"),
    destino("g1e", "19471", "portao_externo", "GATE-1947-EXTERNAL"),
    destino("g1i", "19472", "portao_interno", "GATE-1947-INTERNAL"),
  ],
  "20": [
    destino("f20", "1020", "apartamento", "APT-20"),
    destino("g1e", "19471", "portao_externo", "GATE-1947-EXTERNAL"),
    destino("g1i", "19472", "portao_interno", "GATE-1947-INTERNAL"),
  ],
  "21": [
    destino("f21", "1021", "apartamento", "APT-21"),
    destino("g2e", "19671", "portao_externo", "GATE-1967-EXTERNAL"),
    destino("g2i", "19672", "portao_interno", "GATE-1967-INTERNAL"),
  ],
};

function itemFromDestino(
  d: NovoItemDestino,
  idx: number,
  status: CredencialItemRow["status_provisionamento"] = "provisionado",
): CredencialItemRow {
  return {
    id: "item-" + d.fechadura_id,
    credencial_id: "cred-1",
    fechadura_id: d.fechadura_id,
    lock_id_ttlock: d.lock_id_ttlock,
    tipo_destino: d.tipo_destino,
    codigo_logico_destino: d.codigo_logico_destino,
    status_provisionamento: status,
    ultimo_erro: null,
    provisionado_em: status === "provisionado" ? "2026-09-25T10:00:00.000Z" : null,
    revogado_em: null,
    remote_keyboard_pwd_id: status === "provisionado" ? 8000 + idx : null,
    codigo_enviado: status === "provisionado" ? "1234" : null,
  };
}

function makeRepo(apartamento = "10") {
  const state: {
    apartamento: string;
    credencial: CredencialRow;
    itens: CredencialItemRow[];
  } = {
    apartamento,
    credencial: {
      id: "cred-1",
      reserva_id: "res-1",
      status: "provisionada",
      valido_de: "2026-09-25T17:00:00.000Z",
      valido_ate: "2026-09-27T15:00:00.000Z",
      codigo_credencial: "1234",
      provider_tipo: "ttlock_passcode",
      sync_status: "ok",
      last_sync_attempt_at: null,
      last_sync_error: null,
    },
    itens: DESTINOS[apartamento]!.map((d, i) => itemFromDestino(d, i)),
  };

  const repo: ProvisioningRepository = {
    async getCredencial(id) {
      return id === state.credencial.id ? { ...state.credencial } : null;
    },
    async getCredencialPorReserva() {
      return { ...state.credencial };
    },
    async getCredenciaisPendentes() {
      return [];
    },
    async getItens() {
      return state.itens.map((i) => ({ ...i }));
    },
    async getItensPendentes() {
      return state.itens
        .filter(
          (i) =>
            i.status_provisionamento === "pendente" ||
            i.status_provisionamento === "provisionando" ||
            (i.status_provisionamento === "falhou" && i.remote_keyboard_pwd_id == null),
        )
        .map((i) => ({ ...i }));
    },
    async getItensProvisionados() {
      return state.itens
        .filter(
          (i) =>
            i.status_provisionamento === "provisionado" &&
            i.remote_keyboard_pwd_id != null,
        )
        .map((i) => ({ ...i }));
    },
    async getItensPendentesLimpeza() {
      return state.itens
        .filter((i) => i.status_provisionamento === "pendente_limpeza")
        .map((i) => ({ ...i }));
    },
    async insertItem(_credencialId, d) {
      const row = itemFromDestino(d, state.itens.length + 10, "pendente");
      state.itens.push(row);
      return { ...row };
    },
    async updateCredencial(_id, patch) {
      Object.assign(state.credencial, patch);
    },
    async getCredenciaisComPendenciaSync() {
      return [];
    },
    async updateItem(id, patch) {
      const row = state.itens.find((i) => i.id === id);
      if (!row) throw new Error("item ausente: " + id);
      Object.assign(row, patch);
    },
    async getReservaApartment() {
      return state.apartamento;
    },
    async getFechadurasForApartment(ap) {
      return (DESTINOS[String(Number(ap))] ?? []).map((d) => ({ ...d }));
    },
    async getReservaTtlockCredentialSource() {
      return {
        reserva_id: "res-1",
        apartamento: state.apartamento,
        external_reservation_id: "3298",
        principal_guest_nome: "Hospede Teste",
        hospede_principal: "Hospede Teste",
      };
    },
    async listOccupiedPasscodesOnLocks() {
      return [];
    },
  };

  return { repo, state };
}

function makeTtlock(opts?: {
  failDeleteLock?: string;
  collideAddLock?: string;
}) {
  const created: Array<{ lockId: string; pin: string }> = [];
  const deleted: Array<{ lockId: string; remoteId: number }> = [];
  let seq = 9000;
  const client = {
    isAvailable() {
      return true;
    },
    async createKeyboardPassword(params: {
      lockId: string | number;
      keyboardPwd: string;
    }) {
      const lockId = String(params.lockId);
      if (opts?.collideAddLock === lockId) {
        throw new Error(
          "TTLock erro -3007: The same passcode already exists. Please use another one.",
        );
      }
      created.push({ lockId, pin: String(params.keyboardPwd) });
      return { keyboardPwdId: seq++ };
    },
    async deleteKeyboardPassword(params: {
      lockId: string | number;
      keyboardPwdId: number;
    }) {
      const lockId = String(params.lockId);
      if (opts?.failDeleteLock === lockId) throw new Error("delete failed");
      deleted.push({ lockId, remoteId: params.keyboardPwdId });
      return { errcode: 0 };
    },
    async listKeyboardPasswords() {
      return [];
    },
  } as unknown as TtlockClient;
  return { client, created, deleted };
}

async function main() {
  console.log("\n== room change HITS -> TTLock ==");

  // Troca dentro do mesmo bloco: quarto antigo sai; portões compartilhados ficam;
  // quarto novo recebe exatamente o mesmo PIN.
  {
    const { repo, state } = makeRepo("10");
    const tt = makeTtlock();
    const r = await handleRoomChange(
      "res-1",
      { repository: repo, ttlockClient: tt.client },
      "20",
    );
    assert.equal(r.limpezaAntigaPendente, 0);
    assert.equal(r.passcode, "1234");
    assert.equal(state.credencial.codigo_credencial, "1234");
    assert.deepEqual(tt.deleted.map((x) => x.lockId), ["1010"]);
    assert.deepEqual(tt.created, [{ lockId: "1020", pin: "1234" }]);
    assert.equal(
      state.itens.find((i) => i.codigo_logico_destino === "APT-10")!.status_provisionamento,
      "revogado",
    );
    assert.equal(
      state.itens.find((i) => i.codigo_logico_destino === "GATE-1947-EXTERNAL")!
        .status_provisionamento,
      "provisionado",
    );
    assert.equal(
      state.itens.find((i) => i.codigo_logico_destino === "APT-20")!.status_provisionamento,
      "provisionado",
    );
    assert.equal(r.status, "provisionada");
    ok("10 -> 20 mantém portões do bloco e provisiona novo quarto com o mesmo PIN");
  }

  // Troca de bloco: remove quarto + dois portões antigos antes de criar os 3 novos.
  {
    const { repo, state } = makeRepo("10");
    const tt = makeTtlock();
    const r = await handleRoomChange(
      "res-1",
      { repository: repo, ttlockClient: tt.client },
      "21",
    );
    assert.equal(r.passcode, "1234");
    assert.deepEqual(
      new Set(tt.deleted.map((x) => x.lockId)),
      new Set(["1010", "19471", "19472"]),
    );
    assert.deepEqual(
      new Set(tt.created.map((x) => x.lockId)),
      new Set(["1021", "19671", "19672"]),
    );
    assert.ok(tt.created.every((x) => x.pin === "1234"));
    assert.equal(state.credencial.codigo_credencial, "1234");
    assert.equal(r.status, "provisionada");
    ok("10 -> 21 remove bloco antigo e cria bloco novo sem trocar o PIN");
  }

  // Falha ao remover o quarto antigo: fail-closed, não cria acesso no novo.
  {
    const { repo, state } = makeRepo("10");
    const tt = makeTtlock({ failDeleteLock: "1010" });
    const r = await handleRoomChange(
      "res-1",
      { repository: repo, ttlockClient: tt.client },
      "20",
    );
    assert.equal(r.limpezaAntigaPendente, 1);
    assert.equal(tt.created.length, 0);
    assert.equal(state.credencial.codigo_credencial, "1234");
    assert.equal(
      state.itens.find((i) => i.codigo_logico_destino === "APT-10")!.status_provisionamento,
      "pendente_limpeza",
    );
    assert.equal(state.itens.some((i) => i.codigo_logico_destino === "APT-20"), false);
    ok("falha de delete no antigo bloqueia o novo quarto");
  }

  // Colisão no novo quarto: a credencial NÃO pode ganhar um PIN diferente.
  {
    const { repo, state } = makeRepo("10");
    const tt = makeTtlock({ collideAddLock: "1020" });
    const r = await handleRoomChange(
      "res-1",
      { repository: repo, ttlockClient: tt.client },
      "20",
    );
    assert.equal(state.credencial.codigo_credencial, "1234");
    assert.equal(r.passcode, "1234");
    assert.equal(r.status, "parcial");
    assert.ok(r.erros.some((e) => /PIN existente foi preservado|Colisão TTLock/.test(e)));
    ok("colisão no destino falha sem substituir a senha existente");
  }

  // Itens revogados são histórico do quarto anterior, não requisito ativo.
  {
    const itens = [
      { status_provisionamento: "revogado", remote_keyboard_pwd_id: 1 },
      { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 2 },
      { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 3 },
      { status_provisionamento: "provisionado", remote_keyboard_pwd_id: 4 },
    ];
    const resolved = resolveProvisionCredentialStatus(itens);
    assert.equal(resolved.status, "provisionada");
    assert.equal(resolved.allReady, true);
    assert.equal(
      evaluateTtlockReadyForGuestAccess(
        { status: "provisionada", codigo_credencial: "1234" },
        itens,
      ).ready,
      true,
    );
    ok("gate ignora itens revogados do apartamento anterior");
  }

  // Wiring do novo pipeline: scheduler detecta divergência e chama lifecycle
  // interno; não há geração de nova senha no room change.
  {
    const root = process.cwd();
    const preview = readFileSync(
      join(root, "supabase/functions/hits-reservations-preview/index.ts"),
      "utf8",
    );
    const lifecycle = readFileSync(
      join(root, "supabase/functions/yes-hotel-lifecycle/index.ts"),
      "utf8",
    );
    assert.match(preview, /detectarMudancasApartamentoNoCiclo/);
    assert.match(preview, /action:\s*"lifecycle_room_change"/);
    assert.match(preview, /x-yes-internal-caller":\s*"hits-reservations-preview"/);
    assert.match(lifecycle, /"hits-reservations-preview"/);
    assert.match(lifecycle, /action === "lifecycle_room_change"/);
    assert.match(lifecycle, /handleRoomChange\(/);
    assert.doesNotMatch(
      lifecycle.slice(
        lifecycle.indexOf("async function handleLifecycleRoomChange"),
        lifecycle.indexOf("async function handleCancelOrCheckout"),
      ),
      /lifecycle_gerar_nova_senha/,
    );
    ok("snapshot -> lifecycle_room_change ligado sem chamar gerar_nova_senha");
  }

  console.log(`\nOK test-hits-room-change-reconcile (${cases} casos)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
