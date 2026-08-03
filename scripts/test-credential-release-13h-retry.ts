import assert from "node:assert/strict";
import {
  aplicarLiberacaoCredenciais13h,
  aplicarRetryLiberacaoCredenciais,
  getZonedDateParts,
  isAtOrAfterLocalHour,
  resetCredentialReleaseOrchestratorLocks,
  type CredentialReleasePorts,
  type CredentialReleaseReservationState,
} from "../src/lib/application/yes-hotel";
import { derivarAlertaOperacional } from "../src/lib/domain/yes-hotel";

const TZ = "UTC";

function utcDate(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute = 0,
): Date {
  return new Date(Date.UTC(year, monthIndex, day, hour, minute, 0, 0));
}

function baseState(
  overrides: Partial<CredentialReleaseReservationState> = {},
): CredentialReleaseReservationState {
  return {
    reservaId: "res-1",
    pagamentoStatus: "pendente",
    fnrhStatus: "pendente",
    senhaEnviada: false,
    dataHoraCheckin: utcDate(2026, 7, 3, 14, 0),
    email: "hospede@local.invalid",
    whatsapp: "00000000000",
    acessoLiberado: false,
    cancelada: false,
    encerrada: false,
    temCredencialValida: false,
    ultimaFalhaTipo: null,
    ...overrides,
  };
}

function createMockPorts(
  initialRows: CredentialReleaseReservationState[],
  options?: {
    clock?: Date;
    failSendIds?: Set<string>;
    failGenerateIds?: Set<string>;
  },
) {
  const store = new Map<string, CredentialReleaseReservationState>();
  for (const row of initialRows) store.set(row.reservaId, { ...row });
  const events: Array<{
    reservaId: string;
    tipo: string;
    detalhe?: string | null;
  }> = [];
  let sendCalls = 0;
  let generateCalls = 0;
  const passcodes = new Map<string, string>();

  const ports: CredentialReleasePorts & {
    events: typeof events;
    sendCalls: () => number;
    generateCalls: () => number;
    get: (id: string) => CredentialReleaseReservationState | undefined;
    setFailSend: (id: string, fail: boolean) => void;
    passcodes: Map<string, string>;
  } = {
    events,
    passcodes,
    sendCalls: () => sendCalls,
    generateCalls: () => generateCalls,
    get: (id) => store.get(id),
    setFailSend(id, fail) {
      if (!options) return;
      options.failSendIds = options.failSendIds || new Set();
      if (fail) options.failSendIds.add(id);
      else options.failSendIds.delete(id);
    },
    now: () => options?.clock ?? utcDate(2026, 7, 3, 13, 0),
    async loadReservation(reservaId) {
      const row = store.get(reservaId);
      return row ? { ...row } : null;
    },
    async listCheckinsOnDate(dateYmd) {
      return [...store.values()].filter((r) => {
        const dt =
          r.dataHoraCheckin instanceof Date
            ? r.dataHoraCheckin
            : new Date(r.dataHoraCheckin);
        const z = getZonedDateParts(dt, TZ);
        return z.dateYmd === dateYmd;
      });
    },
    async listFailedReleases() {
      return [...store.values()].filter(
        (r) => !!r.ultimaFalhaTipo && !r.senhaEnviada && !r.cancelada && !r.encerrada,
      );
    },
    async ensureAccessLiberated(reservaId) {
      generateCalls += 1;
      if (options?.failGenerateIds?.has(reservaId)) {
        return { ok: false, error: "Falha de provisionamento mock" };
      }
      const row = store.get(reservaId);
      if (row) {
        row.acessoLiberado = true;
        row.temCredencialValida = true;
        passcodes.set(reservaId, passcodes.get(reservaId) || `PIN-${reservaId}`);
      }
      return { ok: true };
    },
    async sendCredentials(input) {
      sendCalls += 1;
      if (options?.failSendIds?.has(input.reservaId)) {
        return { ok: false, error: "Falha de envio mock" };
      }
      const row = store.get(input.reservaId);
      if (!row) return { ok: false, error: "missing" };
      if (row.senhaEnviada && !input.manual) {
        return { ok: true, skipped: true };
      }
      if (!input.reutilizarCredencial && !row.temCredencialValida) {
        generateCalls += 1;
        row.temCredencialValida = true;
        passcodes.set(
          input.reservaId,
          passcodes.get(input.reservaId) || `PIN-${input.reservaId}`,
        );
      }
      // Só marca enviada após "confirmação" do serviço de comunicação (mock ok).
      row.senhaEnviada = true;
      row.ultimaFalhaTipo = null;
      return { ok: true };
    },
    async registerEvent(input) {
      events.push({
        reservaId: input.reservaId,
        tipo: input.tipo,
        detalhe: input.detalhe,
      });
      const row = store.get(input.reservaId);
      if (!row) return;
      if (input.tipo === "falha_gerar_senha") row.ultimaFalhaTipo = "geracao";
      if (input.tipo === "falha_enviar_credenciais") row.ultimaFalhaTipo = "envio";
      if (
        input.tipo === "retry_credenciais_sucesso" ||
        input.tipo === "credencial_liberacao_aplicada" ||
        input.tipo === "envio_auto_senha"
      ) {
        row.ultimaFalhaTipo = null;
      }
    },
  };

  return ports;
}

async function main(): Promise<void> {
  // Sanity timezone helpers
  assert.equal(isAtOrAfterLocalHour(utcDate(2026, 7, 3, 12, 59), 13, TZ), false);
  assert.equal(isAtOrAfterLocalHour(utcDate(2026, 7, 3, 13, 0), 13, TZ), true);
  assert.equal(isAtOrAfterLocalHour(utcDate(2026, 7, 3, 14, 0), 13, TZ), true);

  // 1) antes das 13h não processa
  {
    resetCredentialReleaseOrchestratorLocks();
    const ports = createMockPorts([baseState()], {
      clock: utcDate(2026, 7, 3, 12, 30),
    });
    const batch = await aplicarLiberacaoCredenciais13h(ports, {
      dataHoraAtual: utcDate(2026, 7, 3, 12, 30),
      dateYmd: "2026-08-03",
      timeZone: TZ,
    });
    assert.equal(batch.antesDas13h, true);
    assert.equal(batch.encontradas, 1);
    assert.equal(batch.enviadas, 0);
    assert.equal(batch.ignoradas, 1);
    assert.equal(ports.sendCalls(), 0);
  }

  // 2) às 13h processa
  {
    resetCredentialReleaseOrchestratorLocks();
    const ports = createMockPorts([baseState()], {
      clock: utcDate(2026, 7, 3, 13, 0),
    });
    const batch = await aplicarLiberacaoCredenciais13h(ports, {
      dataHoraAtual: utcDate(2026, 7, 3, 13, 0),
      dateYmd: "2026-08-03",
      timeZone: TZ,
    });
    assert.equal(batch.antesDas13h, false);
    assert.equal(batch.enviadas, 1);
    assert.equal(batch.resultados[0]?.origemRegistro, "horario_13h");
  }

  // 3) após 13h processa
  {
    resetCredentialReleaseOrchestratorLocks();
    const ports = createMockPorts([baseState()], {
      clock: utcDate(2026, 7, 3, 15, 45),
    });
    const batch = await aplicarLiberacaoCredenciais13h(ports, {
      dataHoraAtual: utcDate(2026, 7, 3, 15, 45),
      dateYmd: "2026-08-03",
      timeZone: TZ,
    });
    assert.equal(batch.enviadas, 1);
  }

  // 4) pagamento e FNRH pendentes não bloqueiam
  {
    resetCredentialReleaseOrchestratorLocks();
    const ports = createMockPorts(
      [
        baseState({
          pagamentoStatus: "pendente",
          fnrhStatus: "pendente",
        }),
      ],
      { clock: utcDate(2026, 7, 3, 13, 0) },
    );
    const batch = await aplicarLiberacaoCredenciais13h(ports, {
      dataHoraAtual: utcDate(2026, 7, 3, 13, 0),
      dateYmd: "2026-08-03",
      timeZone: TZ,
    });
    assert.equal(batch.enviadas, 1);
    assert.equal(ports.get("res-1")?.senhaEnviada, true);
  }

  // 5) reserva já enviada é ignorada
  {
    resetCredentialReleaseOrchestratorLocks();
    const ports = createMockPorts(
      [baseState({ senhaEnviada: true })],
      { clock: utcDate(2026, 7, 3, 13, 0) },
    );
    const batch = await aplicarLiberacaoCredenciais13h(ports, {
      dataHoraAtual: utcDate(2026, 7, 3, 13, 0),
      dateYmd: "2026-08-03",
      timeZone: TZ,
    });
    assert.equal(batch.enviadas, 0);
    assert.equal(batch.ignoradas, 1);
    assert.equal(ports.sendCalls(), 0);
  }

  // 6) reserva cancelada é ignorada
  {
    resetCredentialReleaseOrchestratorLocks();
    const ports = createMockPorts(
      [baseState({ cancelada: true })],
      { clock: utcDate(2026, 7, 3, 13, 0) },
    );
    const batch = await aplicarLiberacaoCredenciais13h(ports, {
      dataHoraAtual: utcDate(2026, 7, 3, 13, 0),
      dateYmd: "2026-08-03",
      timeZone: TZ,
    });
    assert.equal(batch.enviadas, 0);
    assert.equal(batch.ignoradas, 1);
    assert.equal(ports.sendCalls(), 0);
  }

  // 7) uma falha não interrompe as demais
  {
    resetCredentialReleaseOrchestratorLocks();
    const ports = createMockPorts(
      [
        baseState({ reservaId: "res-fail" }),
        baseState({ reservaId: "res-ok", dataHoraCheckin: utcDate(2026, 7, 3, 14, 0) }),
      ],
      {
        clock: utcDate(2026, 7, 3, 13, 0),
        failSendIds: new Set(["res-fail"]),
      },
    );
    const batch = await aplicarLiberacaoCredenciais13h(ports, {
      dataHoraAtual: utcDate(2026, 7, 3, 13, 0),
      dateYmd: "2026-08-03",
      timeZone: TZ,
    });
    assert.equal(batch.encontradas, 2);
    assert.equal(batch.falhas, 1);
    assert.equal(batch.enviadas, 1);
    assert.equal(batch.falhasDetalhe[0]?.reservaId, "res-fail");
    assert.equal(ports.get("res-ok")?.senhaEnviada, true);
    assert.equal(ports.get("res-fail")?.senhaEnviada, false);
  }

  // 8) retry após falha de envio reutiliza a senha existente
  {
    resetCredentialReleaseOrchestratorLocks();
    const ports = createMockPorts([
      baseState({
        reservaId: "res-send-fail",
        temCredencialValida: true,
        acessoLiberado: true,
        ultimaFalhaTipo: "envio",
      }),
    ]);
    ports.passcodes.set("res-send-fail", "PIN-EXISTENTE");
    const beforeGen = ports.generateCalls();
    const retry = await aplicarRetryLiberacaoCredenciais(ports, {
      reservaId: "res-send-fail",
      modo: "retry_manual",
    });
    assert.equal(retry.ok, true);
    assert.equal(retry.enviado, true);
    assert.equal(retry.reutilizouCredencial, true);
    assert.equal(retry.gerado, false);
    assert.equal(ports.generateCalls(), beforeGen);
    assert.equal(ports.passcodes.get("res-send-fail"), "PIN-EXISTENTE");
    assert.ok(
      ports.events.some((e) => e.tipo === "retry_credenciais_iniciado"),
    );
    assert.ok(
      ports.events.some((e) => e.tipo === "retry_credenciais_sucesso"),
    );
  }

  // 9) retry após falha de geração cria a credencial
  {
    resetCredentialReleaseOrchestratorLocks();
    const ports = createMockPorts([
      baseState({
        reservaId: "res-gen-fail",
        temCredencialValida: false,
        acessoLiberado: false,
        ultimaFalhaTipo: "geracao",
      }),
    ]);
    const retry = await aplicarRetryLiberacaoCredenciais(ports, {
      reservaId: "res-gen-fail",
      modo: "retry_automatico",
    });
    assert.equal(retry.ok, true);
    assert.equal(retry.enviado, true);
    assert.equal(retry.reutilizouCredencial, false);
    assert.equal(retry.gerado, true);
    assert.ok(ports.get("res-gen-fail")?.temCredencialValida);
    assert.ok(ports.passcodes.get("res-gen-fail"));
  }

  // 10) concorrência não duplica
  {
    resetCredentialReleaseOrchestratorLocks();
    const ports = createMockPorts(
      [baseState({ pagamentoStatus: "pago", fnrhStatus: "completa" })],
      { clock: utcDate(2026, 7, 3, 13, 0) },
    );
    let concurrent: Awaited<
      ReturnType<typeof aplicarLiberacaoCredenciais13h>
    > | null = null;
    const originalSend = ports.sendCredentials.bind(ports);
    ports.sendCredentials = async (input) => {
      concurrent = await aplicarLiberacaoCredenciais13h(ports, {
        dataHoraAtual: utcDate(2026, 7, 3, 13, 0),
        dateYmd: "2026-08-03",
        timeZone: TZ,
      });
      return originalSend(input);
    };
    const first = await aplicarLiberacaoCredenciais13h(ports, {
      dataHoraAtual: utcDate(2026, 7, 3, 13, 0),
      dateYmd: "2026-08-03",
      timeZone: TZ,
    });
    assert.equal(first.enviadas, 1);
    assert.ok(concurrent);
    assert.equal(concurrent!.enviadas, 0);
    assert.equal(ports.sendCalls(), 1);
  }

  // 11) card de falha desaparece depois da resolução
  {
    const aberto = derivarAlertaOperacional({
      pagamentoStatus: "pago",
      fnrhStatus: "completa",
      senhaEnviada: false,
      falhaEnvio: true,
    });
    assert.equal(aberto, "Falha ao enviar credenciais");

    const resolvido = derivarAlertaOperacional({
      pagamentoStatus: "pago",
      fnrhStatus: "completa",
      senhaEnviada: true,
      falhaEnvio: false,
      falhaGeracao: false,
    });
    assert.equal(resolvido, null);
  }

  console.log(
    "Gatilho 13h + retry de credenciais: testes essenciais concluídos.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
