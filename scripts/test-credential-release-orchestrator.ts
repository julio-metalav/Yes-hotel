import assert from "node:assert/strict";
import {
  aplicarLiberacaoCredenciais,
  aplicarLiberacaoCredenciais13h,
  aplicarLiberacaoPorRequisitos,
  resetCredentialReleaseOrchestratorLocks,
  type CredentialReleasePorts,
  type CredentialReleaseReservationState,
} from "../src/lib/application/yes-hotel";

function baseState(
  overrides: Partial<CredentialReleaseReservationState> = {},
): CredentialReleaseReservationState {
  return {
    reservaId: "res-1",
    pagamentoStatus: "pendente",
    fnrhStatus: "pendente",
    senhaEnviada: false,
    dataHoraCheckin: new Date(2026, 7, 3, 14, 0, 0, 0),
    email: "hospede@local.invalid",
    whatsapp: "00000000000",
    acessoLiberado: false,
    ...overrides,
  };
}

function createMockPorts(
  initial: CredentialReleaseReservationState,
  options?: {
    failSend?: boolean;
    failGenerate?: boolean;
    clock?: Date;
  },
) {
  const store = new Map<string, CredentialReleaseReservationState>();
  store.set(initial.reservaId, { ...initial });
  const events: Array<{ tipo: string; detalhe?: string | null }> = [];
  let sendCalls = 0;
  let liberarCalls = 0;

  const ports: CredentialReleasePorts & {
    events: typeof events;
    sendCalls: () => number;
    liberarCalls: () => number;
    get: (id: string) => CredentialReleaseReservationState | undefined;
  } = {
    events,
    sendCalls: () => sendCalls,
    liberarCalls: () => liberarCalls,
    get: (id) => store.get(id),
    now: () => options?.clock ?? new Date(2026, 7, 3, 11, 0, 0, 0),
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
        const y = dt.getFullYear();
        const m = String(dt.getMonth() + 1).padStart(2, "0");
        const d = String(dt.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}` === dateYmd;
      });
    },
    async ensureAccessLiberated(reservaId) {
      liberarCalls += 1;
      if (options?.failGenerate) {
        return { ok: false, error: "Falha de provisionamento mock" };
      }
      const row = store.get(reservaId);
      if (row) row.acessoLiberado = true;
      return { ok: true };
    },
    async sendCredentials(input) {
      sendCalls += 1;
      if (options?.failSend) {
        return { ok: false, error: "Falha de envio mock" };
      }
      const row = store.get(input.reservaId);
      if (!row) return { ok: false, error: "missing" };
      if (row.senhaEnviada && !input.manual) {
        return { ok: true, skipped: true };
      }
      row.senhaEnviada = true;
      return { ok: true };
    },
    async registerEvent(input) {
      events.push({ tipo: input.tipo, detalhe: input.detalhe });
    },
  };

  return ports;
}

async function main(): Promise<void> {
  resetCredentialReleaseOrchestratorLocks();

  // 1) FNRH conclui por último e dispara
  {
    resetCredentialReleaseOrchestratorLocks();
    const ports = createMockPorts(
      baseState({ pagamentoStatus: "pago", fnrhStatus: "completa" }),
    );
    const result = await aplicarLiberacaoPorRequisitos(ports, "res-1");
    assert.equal(result.enviado, true);
    assert.equal(result.origemRegistro, "requisitos");
    assert.equal(ports.sendCalls(), 1);
    assert.equal(ports.get("res-1")?.senhaEnviada, true);
  }

  // 2) pagamento confirma por último e dispara
  {
    resetCredentialReleaseOrchestratorLocks();
    const ports = createMockPorts(
      baseState({ pagamentoStatus: "pago", fnrhStatus: "completa" }),
    );
    const result = await aplicarLiberacaoCredenciais(ports, {
      reservaId: "res-1",
      origem: "automatico_requisitos",
    });
    assert.equal(result.enviado, true);
    assert.equal(result.origemRegistro, "requisitos");
  }

  // 2b) pagamento sozinho NÃO dispara
  {
    resetCredentialReleaseOrchestratorLocks();
    const ports = createMockPorts(
      baseState({ pagamentoStatus: "pago", fnrhStatus: "pendente" }),
    );
    const result = await aplicarLiberacaoPorRequisitos(ports, "res-1");
    assert.equal(result.enviado, false);
    assert.equal(result.skipped, true);
    assert.equal(ports.sendCalls(), 0);
  }

  // 3) 13h com pendências dispara
  {
    resetCredentialReleaseOrchestratorLocks();
    const clock = new Date(2026, 7, 3, 13, 0, 0, 0);
    const ports = createMockPorts(
      baseState({
        pagamentoStatus: "pendente",
        fnrhStatus: "pendente",
        dataHoraCheckin: new Date(2026, 7, 3, 14, 0, 0, 0),
      }),
      { clock },
    );
    const batch = await aplicarLiberacaoCredenciais13h(ports, {
      dataHoraAtual: clock,
      dateYmd: "2026-08-03",
    });
    assert.equal(batch.enviadas, 1);
    assert.equal(batch.resultados[0]?.origemRegistro, "horario_13h");
    assert.equal(ports.get("res-1")?.senhaEnviada, true);
  }

  // 4) manual com pendências registra corretamente
  {
    resetCredentialReleaseOrchestratorLocks();
    const ports = createMockPorts(
      baseState({ pagamentoStatus: "pendente", fnrhStatus: "pendente" }),
    );
    const waiting = await aplicarLiberacaoCredenciais(ports, {
      reservaId: "res-1",
      origem: "manual",
    });
    assert.equal(waiting.decisao.exigeConfirmacaoManual, true);
    assert.equal(waiting.enviado, false);

    const confirmed = await aplicarLiberacaoCredenciais(ports, {
      reservaId: "res-1",
      origem: "manual",
      confirmacaoManual: true,
      usuarioId: "user-1",
      usuarioLabel: "Recepcionista",
    });
    assert.equal(confirmed.enviado, true);
    assert.equal(confirmed.origemRegistro, "manual");
    assert.deepEqual(confirmed.pendenciasRegistradas, ["pagamento", "fnrh"]);
    assert.ok(
      ports.events.some((e) => e.tipo === "liberacao_manual_com_pendencias"),
    );
    const detalhe = ports.events.find(
      (e) => e.tipo === "liberacao_manual_com_pendencias",
    )?.detalhe;
    assert.ok(detalhe && detalhe.includes("pagamento"));
    assert.ok(detalhe && detalhe.includes("fnrh"));
  }

  // 5) dois gatilhos concorrentes não duplicam
  {
    resetCredentialReleaseOrchestratorLocks();
    const ports = createMockPorts(
      baseState({ pagamentoStatus: "pago", fnrhStatus: "completa" }),
    );
    let duringSecond: Awaited<
      ReturnType<typeof aplicarLiberacaoCredenciais>
    > | null = null;

    const originalSend = ports.sendCredentials.bind(ports);
    ports.sendCredentials = async (input) => {
      duringSecond = await aplicarLiberacaoCredenciais(ports, {
        reservaId: "res-1",
        origem: "automatico_13h",
      });
      return originalSend(input);
    };

    const first = await aplicarLiberacaoPorRequisitos(ports, "res-1");
    assert.equal(first.enviado, true);
    assert.ok(duringSecond);
    assert.equal(duringSecond!.enviado, false);
    assert.equal(duringSecond!.skipped, true);
    assert.equal(duringSecond!.decisao.motivo, "envio_em_andamento");
    assert.equal(ports.sendCalls(), 1);
  }

  // 6) falha permite nova tentativa
  {
    resetCredentialReleaseOrchestratorLocks();
    const ports = createMockPorts(
      baseState({ pagamentoStatus: "pago", fnrhStatus: "completa" }),
      { failSend: true },
    );
    const failed = await aplicarLiberacaoPorRequisitos(ports, "res-1");
    assert.equal(failed.enviado, false);
    assert.equal(failed.error, "Falha de envio mock");
    assert.equal(ports.get("res-1")?.senhaEnviada, false);
    assert.ok(
      ports.events.some((e) => e.tipo === "falha_enviar_credenciais"),
    );

    const ports2 = createMockPorts(
      baseState({ pagamentoStatus: "pago", fnrhStatus: "completa" }),
    );
    const retry = await aplicarLiberacaoPorRequisitos(ports2, "res-1");
    assert.equal(retry.enviado, true);
    assert.equal(ports2.get("res-1")?.senhaEnviada, true);
  }

  console.log(
    "Orquestrador de liberação de credenciais: testes essenciais concluídos.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
