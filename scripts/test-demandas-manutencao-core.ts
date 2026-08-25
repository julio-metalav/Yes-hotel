/**
 * Demandas — ciclo manual (domínio + motor in-memory).
 * Sem I/O remoto. Sem aplicar migration. Sem banco.
 */
import assert from "node:assert/strict";
import {
  DEMANDAS_FOTOS_BUCKET,
  DEMANDAS_MODELOS_PROGRAMADOS_SEED,
  DEMANDAS_STATUS,
  DEMANDAS_TRANSITIONS,
  dashboardCardVisible,
  haversineMeters,
  hotelTodayYmd,
  initialDemandasStatus,
  isDemandasOverdue,
  normalizeTelefoneWhatsapp,
  DemandasEngine,
  evaluateDemandasGeoCheck,
  transitionIsAllowed,
  type DemandasActor,
} from "../src/lib/domain/yes-hotel/index.ts";

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

const TODAY = "2026-08-24";
const PHONE = "+5567999999999";

function actor(
  id: string,
  role: DemandasActor["role"],
  extra: Partial<DemandasActor> = {},
): DemandasActor {
  return { id, role, active: true, telefone_whatsapp: PHONE, ...extra };
}

function setup() {
  const engine = new DemandasEngine({ todayYmd: TODAY, nowIso: "2026-08-24T12:00:00.000Z" });
  engine.users.set("admin", actor("admin", "admin"));
  engine.users.set("recepcao", actor("recepcao", "recepcao"));
  engine.users.set("cafe", actor("cafe", "cafe"));
  engine.users.set("sup", actor("sup", "recepcao"));
  engine.users.set("exe", actor("exe", "cafe"));
  engine.users.set("inativo", actor("inativo", "recepcao", { active: false }));
  engine.users.set("semfone", actor("semfone", "recepcao", { telefone_whatsapp: null }));
  engine.geoConfig = { latitude: -20.469, longitude: -54.62, raio_metros: 200 };
  return engine;
}

function criar(engine: DemandasEngine, actorId: string, extra: Record<string, unknown> = {}) {
  return engine.criar({
    actorId,
    titulo: "Trocar fechadura AP 12",
    descricao: "Local: AP 12, porta de entrada.",
    tipo: "corretiva",
    prioridade: "media",
    data_programada_inicio: TODAY,
    data_prevista_conclusao: "2026-08-26",
    supervisor_id: "sup",
    executor_id: "exe",
    exigir_foto: false,
    sem_local_especifico: false,
    ...extra,
  });
}

const coords = { latitude: -20.469, longitude: -54.62, precisao_metros: 12 };

console.log("\n=== Demandas manutenção predial — núcleo ===\n");

{
  assert.equal(DEMANDAS_STATUS.length, 8);
  for (const status of DEMANDAS_STATUS) {
    assert.equal(typeof status, "string");
  }
  ok("oito status");
}

{
  assert.equal(transitionIsAllowed("agendada", "nao_iniciada"), true);
  assert.equal(transitionIsAllowed("nao_iniciada", "em_andamento"), true);
  assert.equal(transitionIsAllowed("em_correcao", "em_andamento"), true);
  assert.equal(transitionIsAllowed("em_andamento", "pausada"), true);
  assert.equal(transitionIsAllowed("pausada", "em_andamento"), true);
  assert.equal(transitionIsAllowed("em_andamento", "aguardando_validacao"), true);
  assert.equal(transitionIsAllowed("aguardando_validacao", "concluida"), true);
  assert.equal(transitionIsAllowed("aguardando_validacao", "em_correcao"), true);
  assert.equal(transitionIsAllowed("concluida", "em_correcao"), true);
  assert.equal(transitionIsAllowed("nao_iniciada", "cancelada"), true);
  assert.equal(transitionIsAllowed("agendada", "em_andamento"), false);
  assert.equal(transitionIsAllowed("cancelada", "nao_iniciada"), false);
  assert.equal(transitionIsAllowed("concluida", "cancelada"), false);
  assert.equal(Object.keys(DEMANDAS_TRANSITIONS).length, 8);
  ok("transições válidas e inválidas");
}

{
  assert.equal(initialDemandasStatus("2026-08-25", TODAY), "agendada");
  assert.equal(initialDemandasStatus(TODAY, TODAY), "nao_iniciada");
  assert.equal(initialDemandasStatus("2026-08-23", TODAY), "nao_iniciada");
  ok("datas: futura = agendada; hoje/passado = nao_iniciada");
}

{
  assert.equal(
    isDemandasOverdue({
      status: "em_andamento",
      data_prevista_conclusao: "2026-08-23",
      todayYmd: TODAY,
    }),
    true,
  );
  assert.equal(
    isDemandasOverdue({
      status: "concluida",
      data_prevista_conclusao: "2026-08-23",
      todayYmd: TODAY,
    }),
    false,
  );
  ok("vencimento visual não é nono status");
}

{
  assert.equal(normalizeTelefoneWhatsapp("67 99999-9999"), PHONE);
  assert.equal(normalizeTelefoneWhatsapp(null), null);
  assert.throws(() => normalizeTelefoneWhatsapp("123"));
  ok("telefone/WhatsApp normalizado");
}

{
  const zero = haversineMeters(-20.469, -54.62, -20.469, -54.62);
  assert.ok(zero < 0.01);
  const far = haversineMeters(-20.469, -54.62, -20.48, -54.62);
  assert.ok(far > 1000);
  const inside = evaluateDemandasGeoCheck({
    latitude: -20.4691,
    longitude: -54.62,
    precisao_metros: 8,
    sem_local_especifico: false,
    config: { latitude: -20.469, longitude: -54.62, raio_metros: 200 },
  });
  assert.equal(inside.approved, true);
  const outside = evaluateDemandasGeoCheck({
    latitude: -20.48,
    longitude: -54.62,
    precisao_metros: 8,
    sem_local_especifico: false,
    config: { latitude: -20.469, longitude: -54.62, raio_metros: 200 },
  });
  assert.equal(outside.approved, false);
  const skip = evaluateDemandasGeoCheck({
    latitude: 0,
    longitude: 0,
    precisao_metros: null,
    sem_local_especifico: true,
    config: null,
  });
  assert.equal(skip.code, "dispensada");
  const missing = evaluateDemandasGeoCheck({
    latitude: -20.469,
    longitude: -54.62,
    precisao_metros: 5,
    sem_local_especifico: false,
    config: null,
  });
  assert.equal(missing.code, "nao_configurada");
  ok("Haversine, raio e sem local específico");
}

{
  for (const role of ["admin", "recepcao", "cafe"] as const) {
    const engine = setup();
    const row = criar(engine, role);
    assert.equal(row.status, "nao_iniciada");
    assert.equal(engine.listar(role, false).length, 1);
  }
  ok("criação e leitura geral por todos os perfis ativos");
}

{
  const engine = setup();
  assert.throws(() => criar(engine, "inativo"));
  assert.throws(() =>
    criar(engine, "recepcao", { supervisor_id: "semfone", executor_id: "exe" }),
  );
  assert.throws(() =>
    criar(engine, "recepcao", { supervisor_id: "exe", executor_id: "exe" }),
  );
  ok("bloqueio inativo, telefone obrigatório e supervisor ≠ executor");
}

{
  const engine = setup();
  criar(engine, "recepcao");
  criar(engine, "cafe", { titulo: "Outra", executor_id: "cafe", supervisor_id: "sup" });
  assert.equal(engine.listar("exe", true).length, 1);
  assert.equal(engine.listar("cafe", true).length, 1);
  assert.equal(engine.listar("admin", false).length, 2);
  ok("filtro Minhas demandas");
}

{
  const engine = setup();
  const row = criar(engine, "recepcao");
  engine.iniciar("exe", row.id, 1, coords);
  assert.throws(() =>
    engine.editar({
      actorId: "exe",
      demandaId: row.id,
      rowVersion: 2,
      titulo: "Hack",
      descricao: row.descricao,
      tipo: "corretiva",
      prioridade: "alta",
      data_programada_inicio: TODAY,
      data_prevista_conclusao: "2026-08-30",
      supervisor_id: "sup",
      executor_id: "exe",
      exigir_foto: true,
      sem_local_especifico: true,
    }),
  );
  engine.editar({
    actorId: "recepcao",
    demandaId: row.id,
    rowVersion: 2,
    titulo: "Ajuste do criador",
    descricao: row.descricao,
    tipo: "corretiva",
    prioridade: "alta",
    data_programada_inicio: TODAY,
    data_prevista_conclusao: "2026-08-30",
    supervisor_id: "sup",
    executor_id: "exe",
    exigir_foto: true,
    sem_local_especifico: false,
  });
  ok("executor não edita campos; criador edita");
}

{
  const engine = setup();
  const row = criar(engine, "admin", { executor_id: "admin", supervisor_id: "sup" });
  engine.iniciar("admin", row.id, 1, coords);
  engine.enviarValidacao("admin", row.id, 2, coords);
  assert.throws(() => engine.aprovar("admin", row.id, 3));
  engine.aprovar("sup", row.id, 3);
  assert.equal(engine.demandaSnapshot(row.id).status, "concluida");
  ok("autoaprovação proibida; supervisor aprova");
}

{
  const engine = setup();
  const futura = criar(engine, "admin", {
    data_programada_inicio: "2026-09-01",
    data_prevista_conclusao: "2026-09-05",
  });
  assert.equal(futura.status, "agendada");
  assert.throws(() => engine.iniciar("exe", futura.id, 1, coords));
  ok("não inicia agendada antes da data");
}

{
  const engine = setup();
  const row = criar(engine, "cafe");
  engine.iniciar("exe", row.id, 1, coords);
  engine.pausar("exe", row.id, 2, "chuva");
  assert.throws(() => engine.pausar("exe", row.id, 3, "de novo"));
  engine.retomar("exe", row.id, 3);
  engine.enviarValidacao("exe", row.id, 4, coords);
  engine.rejeitar("sup", row.id, 5, "refazer silicone");
  engine.iniciar("exe", row.id, 6, coords);
  engine.enviarValidacao("exe", row.id, 7, coords);
  engine.aprovar("sup", row.id, 8);
  engine.reabrir("cafe", row.id, 9, "vazou de novo");
  assert.equal(engine.demandaSnapshot(row.id).status, "em_correcao");
  ok("pausa, duas pausas, rejeição, reabertura e justificativas");
}

{
  const engine = setup();
  const row = criar(engine, "admin");
  assert.throws(() => engine.cancelar("exe", row.id, 1, "nao"));
  engine.cancelar("admin", row.id, 1, "não faz mais sentido");
  assert.throws(() => engine.reabrir("admin", row.id, 2, "x"));
  ok("cancelamento por criador/admin; cancelada não reabre por este fluxo");
}

{
  const engine = setup();
  const row = criar(engine, "admin", { exigir_foto: false });
  engine.iniciar("exe", row.id, 1, coords);
  engine.enviarValidacao("exe", row.id, 2, coords);
  ok("foto facultativa permite envio");
}

{
  const engine = setup();
  const row = criar(engine, "admin", { exigir_foto: true });
  engine.iniciar("exe", row.id, 1, coords);
  assert.throws(() => engine.enviarValidacao("exe", row.id, 2, coords));
  engine.clock.nowIso = "2026-08-24T12:01:00.000Z";
  engine.incluirFoto({
    actorId: "exe",
    demandaId: row.id,
    etapa: "durante",
    storage_path: `${row.id}/a.jpg`,
    mime: "image/jpeg",
    tamanho_bytes: 1200,
    created_at: "2026-08-24T12:01:00.000Z",
  });
  engine.enviarValidacao("exe", row.id, 2, coords);
  engine.rejeitar("sup", row.id, 3, "foto ruim");
  engine.iniciar("exe", row.id, 4, coords);
  assert.throws(() => engine.enviarValidacao("exe", row.id, 5, coords));
  engine.clock.nowIso = "2026-08-24T13:00:00.000Z";
  engine.incluirFoto({
    actorId: "exe",
    demandaId: row.id,
    etapa: "correcao",
    storage_path: `${row.id}/b.jpg`,
    mime: "image/jpeg",
    tamanho_bytes: 1300,
    created_at: "2026-08-24T13:00:00.000Z",
  });
  engine.enviarValidacao("exe", row.id, 5, coords);
  ok("foto obrigatória e nova foto após rejeição");
}

{
  const engine = setup();
  const row = criar(engine, "admin", { sem_local_especifico: true });
  engine.geoConfig = null;
  engine.iniciar("exe", row.id, 1, { latitude: 0, longitude: 0, precisao_metros: null });
  const blocked = setup();
  blocked.geoConfig = null;
  const other = criar(blocked, "admin");
  assert.throws(() =>
    blocked.iniciar("exe", other.id, 1, coords),
  );
  assert.equal(blocked.geoChecks.at(-1)?.resultado, "nao_configurada");
  ok("geo obrigatória, tentativa recusada registrada, dispensa sem local");
}

{
  const engine = setup();
  const row = criar(engine, "admin");
  assert.throws(() => engine.forbidDelete(row.id));
  assert.throws(() => engine.forbidHistoricoMutation());
  assert.ok(engine.historico.length >= 1);
  ok("histórico append-only e delete físico proibido");
}

{
  assert.equal(DEMANDAS_FOTOS_BUCKET, "demandas-fotos");
  assert.equal(DEMANDAS_MODELOS_PROGRAMADOS_SEED.length, 18);
  assert.equal(
    DEMANDAS_MODELOS_PROGRAMADOS_SEED.every((item) => item.nome.length > 5),
    true,
  );
  ok("bucket privado e 18 modelos seed no contrato de domínio");
}

{
  const cafe = actor("c", "cafe");
  const recepcao = actor("r", "recepcao");
  const admin = actor("a", "admin");
  assert.equal(dashboardCardVisible("minhas_demandas", cafe), true);
  assert.equal(dashboardCardVisible("demandas", recepcao), true);
  assert.equal(dashboardCardVisible("checkin", cafe), false);
  assert.equal(dashboardCardVisible("usuarios", cafe), false);
  assert.equal(dashboardCardVisible("financeiro", recepcao), false);
  assert.equal(dashboardCardVisible("financeiro", admin), true);
  assert.equal(dashboardCardVisible("gestao", recepcao), true);
  ok("cards do dashboard comum por perfil");
}

{
  assert.match(hotelTodayYmd(new Date("2026-08-24T16:00:00.000Z")), /^\d{4}-\d{2}-\d{2}$/);
  ok("timezone America/Campo_Grande na data civil");
}

console.log(`\nOK test-demandas-manutencao-core (${passed} casos)\n`);
