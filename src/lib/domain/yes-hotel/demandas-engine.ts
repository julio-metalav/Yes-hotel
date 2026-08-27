/**
 * Motor in-memory do ciclo manual de Demandas — usado em testes locais
 * sem aplicar migration. Espelha as invariantes das RPCs.
 */

import { evaluateDemandasGeoCheck, type DemandasGeoConfig } from "./demandas-geo.ts";
import { demandasDigisacNotificacaoStatus } from "./demandas-telefone.ts";
import {
  type DemandasAcao,
  type DemandasActor,
  type DemandasAnexoEtapa,
  type DemandasGeoEtapa,
  type DemandasPrioridade,
  type DemandasRecord,
  type DemandasStatus,
  type DemandasTipo,
  assertAssignablePair,
  assertDates,
  canAccessDemandas,
  canPerformDemandasAction,
  canStartScheduled,
  fotoObrigatoriaNoEnvio,
  demandasHotelTodayYmd,
  initialDemandasStatus,
  isDemandasMinhas,
  statusAposAcao,
  transitionIsAllowed,
} from "./demandas-policy.ts";

export type DemandasPausa = {
  id: string;
  demanda_id: string;
  usuario_id: string;
  inicio: string;
  fim: string | null;
  motivo: string | null;
};

export type DemandasHistorico = {
  id: string;
  demanda_id: string;
  usuario_id: string;
  acao: string;
  estado_anterior: unknown;
  estado_novo: unknown;
  justificativa: string | null;
  origem: string;
  criado_em: string;
};

export type DemandasAnexo = {
  id: string;
  demanda_id: string;
  usuario_id: string;
  storage_path: string;
  etapa: DemandasAnexoEtapa;
  mime: string;
  tamanho_bytes: number;
  created_at: string;
};

export type DemandasGeoCheckRow = {
  id: string;
  demanda_id: string;
  usuario_id: string;
  etapa: DemandasGeoEtapa;
  resultado: string;
};

export type DemandasAcaoResultado =
  | { ok: true; demanda: DemandasEngineDemanda }
  | {
      ok: false;
      code: string;
      message: string;
      geo_check_id: string | null;
    };

export type DemandasEngineDemanda = DemandasRecord & {
  titulo: string;
  descricao: string;
  tipo: DemandasTipo;
  prioridade: DemandasPrioridade;
  row_version: number;
  deleted: boolean;
};

type Clock = { nowIso: string; todayYmd: string };

function nextId(prefix: string): string {
  return `${prefix}_${Math.random().toString(16).slice(2, 10)}`;
}

export class DemandasEngine {
  users = new Map<string, DemandasActor>();
  demandas = new Map<string, DemandasEngineDemanda>();
  pausas: DemandasPausa[] = [];
  historico: DemandasHistorico[] = [];
  anexos: DemandasAnexo[] = [];
  geoChecks: DemandasGeoCheckRow[] = [];
  geoConfig: DemandasGeoConfig | null = null;
  storageObjects = new Set<string>();
  clock: Clock;

  constructor(clock?: Partial<Clock>) {
    this.clock = {
      nowIso: clock?.nowIso ?? new Date().toISOString(),
      todayYmd: clock?.todayYmd ?? demandasHotelTodayYmd(),
    };
  }

  private actor(id: string): DemandasActor {
    const user = this.users.get(id);
    if (!user) {
      throw new Error("demandas_usuario_inativo");
    }
    if (!user.active) {
      throw new Error("demandas_usuario_inativo");
    }
    return user;
  }

  listarAtribuiveis(): Array<{
    id: string;
    nome: string;
    perfil_usuario: string;
  }> {
    return [...this.users.values()]
      .filter((user) => canAccessDemandas(user))
      .map((user) => ({
        id: user.id,
        nome: user.id,
        perfil_usuario: String(user.role),
      }))
      .sort((a, b) => a.nome.localeCompare(b.nome));
  }

  private demanda(id: string): DemandasEngineDemanda {
    const row = this.demandas.get(id);
    if (!row || row.deleted) {
      throw new Error("demandas_nao_encontrada");
    }
    return row;
  }

  private appendHistorico(
    demanda: DemandasEngineDemanda,
    user: DemandasActor,
    acao: string,
    anterior: unknown,
    novo: unknown,
    justificativa: string | null,
  ): void {
    this.historico.push({
      id: nextId("hist"),
      demanda_id: demanda.id,
      usuario_id: user.id,
      acao,
      estado_anterior: anterior,
      estado_novo: novo,
      justificativa,
      origem: "rpc",
      criado_em: this.clock.nowIso,
    });
  }

  private bump(demanda: DemandasEngineDemanda, expectedVersion: number): void {
    if (demanda.row_version !== expectedVersion) {
      throw new Error("demandas_concurrency");
    }
    demanda.row_version += 1;
  }

  private requireAction(
    acao: DemandasAcao,
    user: DemandasActor,
    demanda?: DemandasEngineDemanda,
  ): void {
    if (!canPerformDemandasAction(acao, user, demanda)) {
      throw new Error("demandas_forbidden");
    }
  }

  private requireJustificativa(value: string | null | undefined): string {
    const text = String(value ?? "").trim();
    if (!text) {
      throw new Error("demandas_justificativa_obrigatoria");
    }
    return text;
  }

  private openPause(demandaId: string): DemandasPausa | undefined {
    return this.pausas.find((p) => p.demanda_id === demandaId && p.fim === null);
  }

  private closeOpenPause(demandaId: string): void {
    const open = this.openPause(demandaId);
    if (open) {
      open.fim = this.clock.nowIso;
    }
  }

  private lastRejeicaoOuReabertura(demandaId: string): string | null {
    const events = this.historico.filter(
      (h) =>
        h.demanda_id === demandaId &&
        (h.acao === "rejeitar" || h.acao === "reabrir"),
    );
    return events.at(-1)?.criado_em ?? null;
  }

  private recordGeo(
    demanda: DemandasEngineDemanda,
    user: DemandasActor,
    etapa: DemandasGeoEtapa,
    coords: { latitude: number; longitude: number; precisao_metros: number | null },
  ): DemandasAcaoResultado | { ok: true; approved: true } {
    const result = evaluateDemandasGeoCheck({
      latitude: coords.latitude,
      longitude: coords.longitude,
      precisao_metros: coords.precisao_metros,
      sem_local_especifico: demanda.sem_local_especifico,
      config: this.geoConfig,
    });
    const geoId = nextId("geo");
    this.geoChecks.push({
      id: geoId,
      demanda_id: demanda.id,
      usuario_id: user.id,
      etapa,
      resultado: result.code,
    });
    if (result.approved) {
      return { ok: true, approved: true };
    }
    const code =
      result.code === "nao_configurada"
        ? "demandas_geo_nao_configurada"
        : result.code === "coordenada_invalida"
          ? "demandas_coordenada_invalida"
          : "demandas_geo_recusada";
    return {
      ok: false,
      code,
      message: result.message ?? code,
      geo_check_id: geoId,
    };
  }

  liberarAgendada(demanda: DemandasEngineDemanda, user: DemandasActor): void {
    if (
      demanda.status === "agendada" &&
      demanda.data_programada_inicio <= this.clock.todayYmd
    ) {
      const anterior = demanda.status;
      demanda.status = "nao_iniciada";
      this.appendHistorico(demanda, user, "liberar_agendada", anterior, demanda.status, null);
    }
  }

  criar(input: {
    actorId: string;
    titulo: string;
    descricao: string;
    tipo: DemandasTipo;
    prioridade: DemandasPrioridade;
    data_programada_inicio: string;
    data_prevista_conclusao: string;
    supervisor_id: string;
    executor_id: string;
    exigir_foto: boolean;
    sem_local_especifico: boolean;
  }): DemandasEngineDemanda {
    const actor = this.actor(input.actorId);
    this.requireAction("criar", actor);
    const titulo = input.titulo.trim();
    const descricao = input.descricao.trim();
    if (!titulo || !descricao) {
      throw new Error("demandas_titulo_descricao_obrigatorios");
    }
    assertDates(input.data_programada_inicio, input.data_prevista_conclusao);
    const supervisor = this.actor(input.supervisor_id);
    const executor = this.actor(input.executor_id);
    assertAssignablePair({ supervisor, executor });

    const status = initialDemandasStatus(
      input.data_programada_inicio,
      this.clock.todayYmd,
    );
    const row: DemandasEngineDemanda = {
      id: nextId("dem"),
      titulo,
      descricao,
      tipo: input.tipo,
      prioridade: input.prioridade,
      criador_id: actor.id,
      supervisor_id: supervisor.id,
      executor_id: executor.id,
      status,
      exigir_foto: input.exigir_foto,
      sem_local_especifico: input.sem_local_especifico,
      data_programada_inicio: input.data_programada_inicio,
      data_prevista_conclusao: input.data_prevista_conclusao,
      row_version: 1,
      deleted: false,
    };
    this.demandas.set(row.id, row);
    this.appendHistorico(row, actor, "criar", null, {
      status,
      supervisor_digisac: demandasDigisacNotificacaoStatus(
        supervisor.telefone_whatsapp,
      ),
      executor_digisac: demandasDigisacNotificacaoStatus(
        executor.telefone_whatsapp,
      ),
    }, null);
    return row;
  }

  editar(input: {
    actorId: string;
    demandaId: string;
    rowVersion: number;
    titulo: string;
    descricao: string;
    tipo: DemandasTipo;
    prioridade: DemandasPrioridade;
    data_programada_inicio: string;
    data_prevista_conclusao: string;
    supervisor_id: string;
    executor_id: string;
    exigir_foto: boolean;
    sem_local_especifico: boolean;
  }): DemandasEngineDemanda {
    const actor = this.actor(input.actorId);
    const demanda = this.demanda(input.demandaId);
    this.requireAction("editar", actor, demanda);
    if (demanda.status === "concluida" || demanda.status === "cancelada") {
      throw new Error("demandas_transicao_invalida");
    }
    this.bump(demanda, input.rowVersion);
    assertDates(input.data_programada_inicio, input.data_prevista_conclusao);
    const supervisor = this.actor(input.supervisor_id);
    const executor = this.actor(input.executor_id);
    assertAssignablePair({ supervisor, executor });
    const anterior = { ...demanda };
    demanda.titulo = input.titulo.trim();
    demanda.descricao = input.descricao.trim();
    demanda.tipo = input.tipo;
    demanda.prioridade = input.prioridade;
    demanda.data_programada_inicio = input.data_programada_inicio;
    demanda.data_prevista_conclusao = input.data_prevista_conclusao;
    demanda.supervisor_id = supervisor.id;
    demanda.executor_id = executor.id;
    demanda.exigir_foto = input.exigir_foto;
    demanda.sem_local_especifico = input.sem_local_especifico;
    this.appendHistorico(demanda, actor, "editar", anterior, {
      ...demanda,
      supervisor_digisac: demandasDigisacNotificacaoStatus(
        supervisor.telefone_whatsapp,
      ),
      executor_digisac: demandasDigisacNotificacaoStatus(
        executor.telefone_whatsapp,
      ),
    }, null);
    return demanda;
  }

  iniciar(
    actorId: string,
    demandaId: string,
    rowVersion: number,
    coords: { latitude: number; longitude: number; precisao_metros: number | null },
  ): DemandasAcaoResultado {
    const actor = this.actor(actorId);
    const demanda = this.demanda(demandaId);
    this.requireAction("iniciar", actor, demanda);
    if (demanda.status === "agendada" && demanda.data_programada_inicio > this.clock.todayYmd) {
      throw new Error("demandas_ainda_agendada");
    }
    if (
      demanda.status !== "agendada" &&
      demanda.status !== "nao_iniciada" &&
      demanda.status !== "em_correcao"
    ) {
      throw new Error("demandas_transicao_invalida");
    }
    const geo = this.recordGeo(demanda, actor, "inicio", coords);
    if (!geo.ok) {
      return geo;
    }
    this.liberarAgendada(demanda, actor);
    if (!canStartScheduled(demanda, this.clock.todayYmd)) {
      throw new Error("demandas_ainda_agendada");
    }
    if (demanda.status !== "nao_iniciada" && demanda.status !== "em_correcao") {
      throw new Error("demandas_transicao_invalida");
    }
    const next = statusAposAcao("iniciar", demanda.status);
    this.bump(demanda, rowVersion);
    const anterior = demanda.status;
    demanda.status = next;
    this.appendHistorico(demanda, actor, "iniciar", anterior, next, null);
    return { ok: true, demanda };
  }

  pausar(actorId: string, demandaId: string, rowVersion: number, motivo: string | null): DemandasEngineDemanda {
    const actor = this.actor(actorId);
    const demanda = this.demanda(demandaId);
    this.requireAction("pausar", actor, demanda);
    if (this.openPause(demanda.id)) {
      throw new Error("demandas_pausa_aberta");
    }
    const next = statusAposAcao("pausar", demanda.status);
    this.bump(demanda, rowVersion);
    this.pausas.push({
      id: nextId("pause"),
      demanda_id: demanda.id,
      usuario_id: actor.id,
      inicio: this.clock.nowIso,
      fim: null,
      motivo,
    });
    const anterior = demanda.status;
    demanda.status = next;
    this.appendHistorico(demanda, actor, "pausar", anterior, next, motivo);
    return demanda;
  }

  retomar(actorId: string, demandaId: string, rowVersion: number): DemandasEngineDemanda {
    const actor = this.actor(actorId);
    const demanda = this.demanda(demandaId);
    this.requireAction("retomar", actor, demanda);
    const next = statusAposAcao("retomar", demanda.status);
    this.bump(demanda, rowVersion);
    this.closeOpenPause(demanda.id);
    const anterior = demanda.status;
    demanda.status = next;
    this.appendHistorico(demanda, actor, "retomar", anterior, next, null);
    return demanda;
  }

  enviarValidacao(
    actorId: string,
    demandaId: string,
    rowVersion: number,
    coords: { latitude: number; longitude: number; precisao_metros: number | null },
  ): DemandasAcaoResultado {
    const actor = this.actor(actorId);
    const demanda = this.demanda(demandaId);
    this.requireAction("enviar_validacao", actor, demanda);
    const next = statusAposAcao("enviar_validacao", demanda.status);
    const geo = this.recordGeo(demanda, actor, "envio_validacao", coords);
    if (!geo.ok) {
      return geo;
    }
    const lastEvent = this.lastRejeicaoOuReabertura(demanda.id);
    if (
      fotoObrigatoriaNoEnvio({
        exigir_foto: demanda.exigir_foto,
        anexos: this.anexos.filter((a) => a.demanda_id === demanda.id),
        last_rejeicao_ou_reabertura_at: lastEvent,
      })
    ) {
      throw new Error("demandas_foto_obrigatoria");
    }
    this.bump(demanda, rowVersion);
    this.closeOpenPause(demanda.id);
    const anterior = demanda.status;
    demanda.status = next;
    this.appendHistorico(demanda, actor, "enviar_validacao", anterior, next, null);
    return { ok: true, demanda };
  }

  aprovar(actorId: string, demandaId: string, rowVersion: number): DemandasEngineDemanda {
    const actor = this.actor(actorId);
    const demanda = this.demanda(demandaId);
    this.requireAction("aprovar", actor, demanda);
    const next = statusAposAcao("aprovar", demanda.status);
    this.bump(demanda, rowVersion);
    const anterior = demanda.status;
    demanda.status = next;
    this.appendHistorico(demanda, actor, "aprovar", anterior, next, null);
    return demanda;
  }

  rejeitar(
    actorId: string,
    demandaId: string,
    rowVersion: number,
    justificativa: string,
  ): DemandasEngineDemanda {
    const actor = this.actor(actorId);
    const demanda = this.demanda(demandaId);
    this.requireAction("rejeitar", actor, demanda);
    const motivo = this.requireJustificativa(justificativa);
    const next = statusAposAcao("rejeitar", demanda.status);
    this.bump(demanda, rowVersion);
    const anterior = demanda.status;
    demanda.status = next;
    this.appendHistorico(demanda, actor, "rejeitar", anterior, next, motivo);
    return demanda;
  }

  cancelar(
    actorId: string,
    demandaId: string,
    rowVersion: number,
    justificativa: string,
  ): DemandasEngineDemanda {
    const actor = this.actor(actorId);
    const demanda = this.demanda(demandaId);
    this.requireAction("cancelar", actor, demanda);
    const motivo = this.requireJustificativa(justificativa);
    if (!transitionIsAllowed(demanda.status, "cancelada")) {
      throw new Error("demandas_transicao_invalida");
    }
    this.bump(demanda, rowVersion);
    this.closeOpenPause(demanda.id);
    const anterior = demanda.status;
    demanda.status = "cancelada";
    this.appendHistorico(demanda, actor, "cancelar", anterior, "cancelada", motivo);
    return demanda;
  }

  reabrir(
    actorId: string,
    demandaId: string,
    rowVersion: number,
    justificativa: string,
  ): DemandasEngineDemanda {
    const actor = this.actor(actorId);
    const demanda = this.demanda(demandaId);
    this.requireAction("reabrir", actor, demanda);
    const motivo = this.requireJustificativa(justificativa);
    const next = statusAposAcao("reabrir", demanda.status);
    this.bump(demanda, rowVersion);
    const anterior = demanda.status;
    demanda.status = next;
    this.appendHistorico(demanda, actor, "reabrir", anterior, next, motivo);
    return demanda;
  }

  autorizarAnexo(actorId: string, demandaId: string, etapa: DemandasAnexoEtapa): { ok: true; demanda_id: string } {
    const actor = this.actor(actorId);
    const demanda = this.demanda(demandaId);
    this.requireAction("incluir_foto", actor, demanda);
    if (demanda.status === "cancelada") {
      throw new Error("demandas_transicao_invalida");
    }
    if (!["antes", "durante", "finalizacao", "correcao"].includes(etapa)) {
      throw new Error("demandas_etapa_invalida");
    }
    return { ok: true, demanda_id: demanda.id };
  }

  incluirFoto(input: {
    actorId: string;
    demandaId: string;
    etapa: DemandasAnexoEtapa;
    storage_path: string;
    mime: string;
    tamanho_bytes: number;
    created_at?: string;
  }): DemandasAnexo {
    this.autorizarAnexo(input.actorId, input.demandaId, input.etapa);
    const actor = this.actor(input.actorId);
    const demanda = this.demanda(input.demandaId);
    if (!input.storage_path.startsWith(`${demanda.id}/`)) {
      throw new Error("demandas_storage_path_invalido");
    }
    if (!this.storageObjects.has(input.storage_path)) {
      throw new Error("demandas_objeto_inexistente");
    }
    const anexo: DemandasAnexo = {
      id: nextId("anexo"),
      demanda_id: demanda.id,
      usuario_id: actor.id,
      storage_path: input.storage_path,
      etapa: input.etapa,
      mime: input.mime,
      tamanho_bytes: input.tamanho_bytes,
      created_at: input.created_at ?? this.clock.nowIso,
    };
    this.anexos.push(anexo);
    this.appendHistorico(demanda, actor, "incluir_foto", null, { path: anexo.storage_path }, null);
    return anexo;
  }

  atualizarGeo(actorId: string, config: DemandasGeoConfig): void {
    const actor = this.actor(actorId);
    this.requireAction("configurar_geo", actor);
    this.geoConfig = config;
    this.historico.push({
      id: nextId("hist"),
      demanda_id: "geo_config",
      usuario_id: actor.id,
      acao: "atualizar_geo_config",
      estado_anterior: null,
      estado_novo: config,
      justificativa: null,
      origem: "rpc",
      criado_em: this.clock.nowIso,
    });
  }

  listar(actorId: string, minhas: boolean): DemandasEngineDemanda[] {
    const actor = this.actor(actorId);
    this.requireAction("consultar", actor);
    const all = [...this.demandas.values()].filter((d) => !d.deleted);
    if (!minhas) {
      return all;
    }
    return all.filter((d) => isDemandasMinhas(d, actor.id));
  }

  demandaSnapshot(id: string): DemandasEngineDemanda {
    return this.demanda(id);
  }

  forbidHistoricoMutation(): void {
    throw new Error("demandas_historico_append_only");
  }

  forbidDelete(demandaId: string): void {
    this.demanda(demandaId);
    throw new Error("demandas_delete_proibido");
  }
}
