/**
 * Troca de apartamento HITS: mesmo PIN, revoga o antigo antes de abrir o novo,
 * replay não repete, falha não conclui.
 * Não fala com TTLock, HITS nem Supabase.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleRoomChange } from "../src/lib/application/yes-hotel/credential-lifecycle.ts";
import type {
  CredencialItemRow,
  CredencialRow,
  NovoItemDestino,
  ProvisioningRepository,
} from "../src/lib/application/yes-hotel/provisioning-executor.ts";
import { decidirTrocaApartamento } from "../src/lib/domain/yes-hotel/hits-room-change.ts";
import { reconciliarTrocaApartamentoHits } from "../src/lib/integrations/hits/hits-room-change.ts";
import type { SyncedReservation } from "../src/lib/domain/yes-hotel/synced-reservation.ts";

const PIN = "4321";
let seq = 0;
const nid = () => `id-${++seq}`;

type World = {
  apartment: string;
  cred: CredencialRow;
  itens: CredencialItemRow[];
  deleted: string[];
  created: string[];
  messages: number[];
  failDelete: boolean;
  failCreate: boolean;
};

function destino(apt: string): NovoItemDestino[] {
  const n = Number(apt);
  const gate = n <= 20 ? "1947" : "1967";
  return [
    { fechadura_id: `door-${apt}`, lock_id_ttlock: `lock-door-${apt}`, tipo_destino: "apartamento", codigo_logico_destino: `APT-${apt}` },
    { fechadura_id: `ext-${gate}`, lock_id_ttlock: `lock-ext-${gate}`, tipo_destino: "portao_externo", codigo_logico_destino: `GATE-${gate}-EXTERNAL` },
    { fechadura_id: `int-${gate}`, lock_id_ttlock: `lock-int-${gate}`, tipo_destino: "portao_interno", codigo_logico_destino: `GATE-${gate}-INTERNAL` },
  ];
}

function seed(apt: string, remote: boolean, pin: string | null): World {
  const credId = nid();
  const itens = destino(apt).map((d) => ({
    id: nid(),
    credencial_id: credId,
    fechadura_id: d.fechadura_id,
    lock_id_ttlock: d.lock_id_ttlock,
    tipo_destino: d.tipo_destino,
    codigo_logico_destino: d.codigo_logico_destino,
    status_provisionamento: remote ? "provisionado" as const : "pendente" as const,
    ultimo_erro: null,
    provisionado_em: remote ? "2026-09-26T17:00:00.000Z" : null,
    revogado_em: null,
    remote_keyboard_pwd_id: remote ? 1000 + Number(apt) : null,
    codigo_enviado: remote ? pin : null,
  }));
  return {
    apartment: apt,
    cred: {
      id: credId,
      reserva_id: "reserva-1",
      status: remote ? "provisionada" : "pendente",
      valido_de: "2026-09-26T17:00:00.000Z",
      valido_ate: "2026-09-27T15:00:00.000Z",
      codigo_credencial: pin,
      provider_tipo: "ttlock_passcode",
      sync_status: "ok",
      last_sync_error: null,
    },
    itens,
    deleted: [],
    created: [],
    messages: [],
    failDelete: false,
    failCreate: false,
  };
}

function repoOf(world: World): ProvisioningRepository {
  return {
    async getCredencial(id) {
      return world.cred.id === id ? world.cred : null;
    },
    async getCredencialPorReserva() {
      return world.cred;
    },
    async getCredenciaisPendentes() {
      return [];
    },
    async getItens() {
      return world.itens.map((i) => ({ ...i }));
    },
    async getItensPendentes() {
      return world.itens.filter((i) => i.status_provisionamento === "pendente");
    },
    async getItensProvisionados() {
      return world.itens.filter((i) => i.status_provisionamento === "provisionado");
    },
    async getItensPendentesLimpeza() {
      return world.itens.filter((i) => i.status_provisionamento === "pendente_limpeza");
    },
    async insertItem(credencialId, destinoItem) {
      const row: CredencialItemRow = {
        id: nid(),
        credencial_id: credencialId,
        fechadura_id: destinoItem.fechadura_id,
        lock_id_ttlock: destinoItem.lock_id_ttlock,
        tipo_destino: destinoItem.tipo_destino,
        codigo_logico_destino: destinoItem.codigo_logico_destino,
        status_provisionamento: "pendente",
        ultimo_erro: null,
        provisionado_em: null,
        revogado_em: null,
        remote_keyboard_pwd_id: null,
        codigo_enviado: null,
      };
      world.itens.push(row);
      return row;
    },
    async updateCredencial(_id, patch) {
      Object.assign(world.cred, patch);
    },
    async getCredenciaisComPendenciaSync() {
      return [];
    },
    async updateItem(id, patch) {
      const item = world.itens.find((i) => i.id === id);
      if (item) Object.assign(item, patch);
    },
    async getReservaApartment() {
      return world.apartment;
    },
    async getFechadurasForApartment(code) {
      const norm = String(Number(code)).padStart(2, "0");
      return destino(norm);
    },
    async getReservaTtlockCredentialSource() {
      return {
        reserva_id: world.cred.reserva_id,
        apartamento: world.apartment,
        external_reservation_id: "3500",
        principal_guest_nome: "Hospede",
        hospede_principal: "Hospede",
      };
    },
    async listOccupiedPasscodesOnLocks() {
      return [];
    },
  };
}

function clientOf(world: World) {
  return {
    isAvailable: () => true,
    async deleteKeyboardPassword(params: { lockId: number | string }) {
      if (world.failDelete) throw new Error("delete_falhou");
      world.deleted.push(String(params.lockId));
    },
    async createKeyboardPassword(params: { lockId: number | string; keyboardPwd: string }) {
      if (world.failCreate) throw new Error("create_falhou");
      assert.equal(params.keyboardPwd, world.cred.codigo_credencial);
      world.created.push(String(params.lockId));
      return { keyboardPwdId: 7000 + world.created.length };
    },
    async listKeyboardPasswords() {
      return [];
    },
  };
}

async function move(world: World, novo: string) {
  return handleRoomChange(world.cred.reserva_id, {
    repository: repoOf(world),
    ttlockClient: clientOf(world) as never,
    retry: { shortRetryMax: 0, shortDelayMs: 0, shortBudgetMs: 0, phase2Max: 0, sleepFn: async () => {} },
  }, novo);
}

function ativos(world: World, apt: string) {
  return world.itens.filter(
    (i) => i.codigo_logico_destino === `APT-${apt}` && i.status_provisionamento === "provisionado",
  );
}

let passed = 0;
const ok = (name: string) => {
  passed += 1;
  console.log(`ok ${passed}. ${name}`);
};

async function main() {
console.log("\n== decisão ==");
assert.deepEqual(decidirTrocaApartamento({ apartamentoLocal: "10", apartamentoHits: "10" }), { acao: "noop" });
assert.deepEqual(decidirTrocaApartamento({ apartamentoLocal: "010", apartamentoHits: "10" }), { acao: "noop" });
assert.deepEqual(decidirTrocaApartamento({ apartamentoLocal: "", apartamentoHits: "20" }), { acao: "noop" });
assert.deepEqual(decidirTrocaApartamento({ apartamentoLocal: "10", apartamentoHits: "20" }), {
  acao: "atualizar",
  de: "10",
  para: "20",
});
ok("sem mudança, código equivalente e local vazio não disparam troca");

console.log("\n== mesmo apartamento ==");
{
  const world = seed("10", true, PIN);
  const antes = world.deleted.length;
  const r = await move(world, "10");
  assert.equal(r.concluida, true);
  assert.equal(r.motivo, "noop");
  assert.equal(world.deleted.length, antes);
  assert.equal(world.created.length, 0);
  assert.equal(world.cred.codigo_credencial, PIN);
  assert.equal(world.messages.length, 0);
  ok("1. sem mudança: nenhuma revogação, nenhum PIN novo, nenhuma mensagem");
}

console.log("\n== 10 → 20 ==");
{
  const world = seed("10", true, PIN);
  const r = await move(world, "20");
  assert.equal(r.concluida, true);
  assert.equal(r.motivo, "reconciliada");
  assert.equal(r.pinPreservado, true);
  assert.equal(world.cred.codigo_credencial, PIN);
  assert.equal(ativos(world, "10").length, 0);
  assert.equal(ativos(world, "20").length, 1);
  assert.ok(world.deleted.length > 0);
  assert.ok(world.created.some((id) => id.includes("door-20")));
  assert.equal(world.messages.length, 0);
  const simultaneo = ativos(world, "10").length > 0 && ativos(world, "20").length > 0;
  assert.equal(simultaneo, false);
  ok("2. 10 → 20 mantém o PIN, tira o antigo e abre o novo");

  world.apartment = "20";
  const deleted = world.deleted.length;
  const created = world.created.length;
  const replay = await move(world, "20");
  assert.equal(replay.motivo, "noop");
  assert.equal(world.deleted.length, deleted);
  assert.equal(world.created.length, created);
  assert.equal(world.cred.codigo_credencial, PIN);
  ok("3. replay de 10 → 20 é no-op");

  const r30 = await move(world, "30");
  assert.equal(r30.concluida, true);
  assert.equal(world.cred.codigo_credencial, PIN);
  assert.equal(ativos(world, "20").length, 0);
  assert.equal(ativos(world, "30").length, 1);
  assert.equal(ativos(world, "10").length, 0);
  ok("4. 10 → 20 → 30 preserva o PIN e só o último fica ativo");
}

console.log("\n== antes da senha ==");
{
  const world = seed("10", false, null);
  const r = await move(world, "20");
  assert.equal(r.motivo, "apenas_local");
  assert.equal(r.concluida, true);
  assert.equal(world.deleted.length, 0);
  assert.equal(world.created.length, 0);
  assert.equal(world.cred.codigo_credencial, null);
  assert.equal(ativos(world, "10").length, 0);
  const novo = world.itens.find((i) => i.codigo_logico_destino === "APT-20");
  assert.equal(novo?.status_provisionamento, "pendente");
  assert.equal(world.messages.length, 0);
  ok("5. troca antes da credencial só aponta o apto novo, sem revogação remota e sem PIN");
}

console.log("\n== falha ao remover o antigo ==");
{
  const world = seed("10", true, PIN);
  world.failDelete = true;
  const r = await move(world, "20");
  assert.equal(r.concluida, false);
  assert.equal(r.motivo, "revogacao_pendente");
  assert.equal(world.created.length, 0);
  assert.equal(world.cred.codigo_credencial, PIN);
  assert.equal(world.apartment, "10");
  assert.ok(String(world.cred.last_sync_error || "").includes("pendente"));
  const antigoAinda = world.itens.some(
    (i) => i.codigo_logico_destino === "APT-10" && i.status_provisionamento === "pendente_limpeza",
  );
  assert.equal(antigoAinda, true);
  ok("6. falha ao remover o antigo não provisiona o novo e não conclui");
}

console.log("\n== falha ao criar o novo e retry ==");
{
  const world = seed("10", true, PIN);
  world.failCreate = true;
  const r = await move(world, "20");
  assert.equal(r.concluida, false);
  assert.equal(r.motivo, "provisionamento_falhou");
  assert.equal(world.cred.codigo_credencial, PIN);
  assert.equal(ativos(world, "20").length, 0);
  assert.equal(ativos(world, "10").length, 0);
  assert.equal(world.apartment, "10");
  ok("7. falha ao provisionar o novo mantém o PIN e não declara sucesso");

  world.failCreate = false;
  const retry = await move(world, "20");
  assert.equal(retry.concluida, true);
  assert.equal(world.cred.codigo_credencial, PIN);
  assert.equal(ativos(world, "20").length, 1);
  assert.equal(ativos(world, "10").length, 0);
  ok("8. retry depois da falha parcial conclui com o mesmo PIN");
}

console.log("\n== mesmo bloco ==");
{
  const world = seed("10", true, PIN);
  const r = await move(world, "12");
  assert.equal(r.concluida, true);
  assert.equal(world.cred.codigo_credencial, PIN);
  const portao = world.itens.find((i) => i.fechadura_id === "ext-1947");
  assert.equal(portao?.status_provisionamento, "provisionado");
  assert.equal(world.deleted.includes("lock-ext-1947"), false);
  assert.equal(ativos(world, "10").length, 0);
  assert.equal(ativos(world, "12").length, 1);
  ok("9. mesmo bloco não deixa o portão sem acesso e não duplica a credencial");
}

console.log("\n== ciclo HITS ==");
{
  const synced = (apt: string): SyncedReservation => ({
    provider: "hits",
    externalReservationId: "3500",
    sourceUpdatedAt: null,
    syncedAt: null,
    reservationStatus: "ativa",
    checkIn: "2026-09-26",
    checkOut: "2026-09-27",
    apartmentCode: apt,
    mainGuestName: "Hospede",
    guests: [],
    adults: 1,
    minors: 0,
    totalGuests: 1,
    mealPlanDesc: null,
    paymentStatus: "pago",
    phone: null,
    email: null,
    channelManager: null,
    salesChannel: null,
    billingEntity: null,
    reservationChannelId: null,
    reservationBalanceDue: 0,
    reservationTotalAmount: 0,
    classificacaoComissionamento: null,
    rawSanitized: {},
  });
  const reservas = [{ id: "reserva-1", origem_externa: "hits", external_reservation_id: "3500", apartamento: "10" }];
  const creds: Array<Record<string, unknown>> = [];
  const admin = {
    from(table: string) {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let payload: Record<string, unknown> | null = null;
      const q: Record<string, unknown> = {};
      const rows = table === "operacional_reservas" ? reservas : creds;
      q.select = () => q;
      q.eq = (k: string, v: unknown) => {
        filters.push((row) => row[k] === v);
        return q;
      };
      q.update = (p: Record<string, unknown>) => {
        payload = p;
        return q;
      };
      q.maybeSingle = () => q;
      q.then = (resolve: (v: unknown) => unknown) => {
        const found = rows.filter((row) => filters.every((f) => f(row as Record<string, unknown>)));
        if (payload) {
          found.forEach((row) => Object.assign(row, payload));
          return Promise.resolve({ data: found.map((row) => ({ id: (row as { id: string }).id })), error: null }).then(resolve);
        }
        return Promise.resolve({ data: found[0] ?? null, error: null }).then(resolve);
      };
      return q;
    },
  };

  const igual = await reconciliarTrocaApartamentoHits({
    admin,
    externalId: "3500",
    synced: synced("10"),
  });
  assert.equal(igual.acao, "noop");
  assert.equal(reservas[0]!.apartamento, "10");

  const semCred = await reconciliarTrocaApartamentoHits({
    admin,
    externalId: "3500",
    synced: synced("20"),
  });
  assert.equal(semCred.acao, "apartamento");
  assert.equal(reservas[0]!.apartamento, "20");
  reservas[0]!.apartamento = "10";

  creds.push({ id: "cred-1", reserva_id: "reserva-1", status: "provisionada", tipo_credencial: "principal" });
  let chamadas = 0;
  const falha = await reconciliarTrocaApartamentoHits({
    admin,
    externalId: "3500",
    synced: synced("20"),
    aplicarTroca: async () => {
      chamadas += 1;
      return { ok: false, motivo: "revogacao_pendente" };
    },
  });
  assert.equal(falha.ok, false);
  assert.equal(reservas[0]!.apartamento, "10");
  assert.equal(chamadas, 1);

  const okRemoto = await reconciliarTrocaApartamentoHits({
    admin,
    externalId: "3500",
    synced: synced("20"),
    aplicarTroca: async () => ({ ok: true, motivo: "reconciliada" }),
  });
  assert.equal(okRemoto.acao, "lifecycle");
  assert.equal(reservas[0]!.apartamento, "10", "o ciclo não avança o apartamento; o lifecycle faz isso depois do sucesso");
  ok("10–12. ciclo: no-op, sem credencial, falha não conclui, sucesso delega sem mensagem");
}

console.log("\n== sem mensagem e sem PIN na resposta ==");
{
  const lifecycle = readFileSync("supabase/functions/yes-hotel-lifecycle/index.ts", "utf8");
  const handler = lifecycle.slice(lifecycle.indexOf("async function handleLifecycleRoomChange"));
  const body = handler.slice(0, handler.indexOf("\nDeno.serve"));
  assert.equal(body.includes("send-senha"), false);
  assert.equal(body.includes("passcode"), false);
  assert.equal(body.includes("if (!result.concluida)"), true);
  const remote = readFileSync("src/lib/integrations/hits/hits-room-change-remote.ts", "utf8");
  assert.equal(remote.includes("send-senha"), false);
  assert.equal(remote.includes("lifecycle_room_change"), true);
  ok("sem envio de senha e a resposta do lifecycle não devolve o PIN");
}

console.log(`\n${passed} testes de troca de apartamento ok`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
