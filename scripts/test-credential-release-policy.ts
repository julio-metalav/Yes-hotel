import assert from "node:assert/strict";
import {
  atingiuHorario13hCheckin,
  avaliarLiberacaoCredenciais,
  derivarAlertaOperacional,
  executarLiberacaoCredenciaisMock,
  getCredentialReleaseMockState,
  resetCredentialReleaseMockState,
} from "../src/lib/domain/yes-hotel";

function checkinAt(hour: number, minute = 0): Date {
  return new Date(2026, 7, 3, hour, minute, 0, 0);
}

function dayBefore13h(): { checkin: Date; agora: Date } {
  return { checkin: checkinAt(14, 0), agora: checkinAt(11, 0) };
}

function dayAt13h(): { checkin: Date; agora: Date } {
  return { checkin: checkinAt(14, 0), agora: checkinAt(13, 0) };
}

resetCredentialReleaseMockState();

// 1) pagamento + FNRH concluídos antes das 13h
{
  const { checkin, agora } = dayBefore13h();
  const d = avaliarLiberacaoCredenciais({
    pagamentoStatus: "pago",
    fnrhStatus: "completa",
    senhaEnviada: false,
    dataHoraCheckin: checkin,
    dataHoraAtual: agora,
    origem: "automatico_requisitos",
  });
  assert.equal(d.deveGerar, true);
  assert.equal(d.deveEnviar, true);
  assert.equal(d.motivo, "requisitos_ok");
  assert.deepEqual(d.pendenciasAtuais, []);
  assert.equal(d.alertaOperacional, "Senha ainda não enviada");
  assert.equal(d.acaoPainel, "gerar_e_enviar");
}

// 2) apenas pagamento pendente
{
  const { checkin, agora } = dayBefore13h();
  const d = avaliarLiberacaoCredenciais({
    pagamentoStatus: "pendente",
    fnrhStatus: "completa",
    senhaEnviada: false,
    dataHoraCheckin: checkin,
    dataHoraAtual: agora,
    origem: "automatico_requisitos",
  });
  assert.equal(d.deveGerar, false);
  assert.equal(d.deveEnviar, false);
  assert.deepEqual(d.pendenciasAtuais, ["pagamento"]);
  assert.equal(d.alertaOperacional, "Pagamento pendente");
}

// 3) apenas FNRH pendente
{
  const { checkin, agora } = dayBefore13h();
  const d = avaliarLiberacaoCredenciais({
    pagamentoStatus: "pago",
    fnrhStatus: "pendente",
    senhaEnviada: false,
    dataHoraCheckin: checkin,
    dataHoraAtual: agora,
    origem: "automatico_requisitos",
  });
  assert.equal(d.deveGerar, false);
  assert.equal(d.deveEnviar, false);
  assert.deepEqual(d.pendenciasAtuais, ["fnrh"]);
  assert.equal(d.alertaOperacional, "FNRH pendente");
}

// 4) ambos pendentes
{
  const { checkin, agora } = dayBefore13h();
  const d = avaliarLiberacaoCredenciais({
    pagamentoStatus: "pendente",
    fnrhStatus: "pendente",
    senhaEnviada: false,
    dataHoraCheckin: checkin,
    dataHoraAtual: agora,
    origem: "automatico_requisitos",
  });
  assert.equal(d.deveGerar, false);
  assert.equal(d.deveEnviar, false);
  assert.deepEqual(d.pendenciasAtuais, ["pagamento", "fnrh"]);
  assert.equal(d.alertaOperacional, "Pagamento e FNRH pendentes");
}

// 5) chegada das 13h com pendências
{
  const { checkin, agora } = dayAt13h();
  assert.equal(atingiuHorario13hCheckin(checkin, agora), true);
  const d = avaliarLiberacaoCredenciais({
    pagamentoStatus: "pendente",
    fnrhStatus: "pendente",
    senhaEnviada: false,
    dataHoraCheckin: checkin,
    dataHoraAtual: agora,
    origem: "automatico_13h",
  });
  assert.equal(d.deveGerar, true);
  assert.equal(d.deveEnviar, true);
  assert.equal(d.motivo, "horario_13h");
  assert.equal(d.alertaOperacional, "Pagamento e FNRH pendentes");
}

// 6) liberação manual com uma pendência
{
  const { checkin, agora } = dayBefore13h();
  const waiting = avaliarLiberacaoCredenciais({
    pagamentoStatus: "pago",
    fnrhStatus: "pendente",
    senhaEnviada: false,
    dataHoraCheckin: checkin,
    dataHoraAtual: agora,
    origem: "manual",
  });
  assert.equal(waiting.exigeConfirmacaoManual, true);
  assert.equal(waiting.deveEnviar, false);
  assert.equal(waiting.acaoPainel, "confirmar_manual");

  const confirmed = avaliarLiberacaoCredenciais({
    pagamentoStatus: "pago",
    fnrhStatus: "pendente",
    senhaEnviada: false,
    dataHoraCheckin: checkin,
    dataHoraAtual: agora,
    origem: "manual",
    confirmacaoManual: true,
  });
  assert.equal(confirmed.deveGerar, true);
  assert.equal(confirmed.deveEnviar, true);
  assert.equal(
    confirmed.alertaOperacional,
    "Acesso liberado manualmente — FNRH pendente",
  );
}

// 7) liberação manual com duas pendências
{
  const { checkin, agora } = dayBefore13h();
  const confirmed = avaliarLiberacaoCredenciais({
    pagamentoStatus: "pendente",
    fnrhStatus: "pendente",
    senhaEnviada: false,
    dataHoraCheckin: checkin,
    dataHoraAtual: agora,
    origem: "manual",
    confirmacaoManual: true,
  });
  assert.equal(confirmed.deveEnviar, true);
  assert.equal(
    confirmed.alertaOperacional,
    "Acesso liberado manualmente — pagamento e FNRH pendentes",
  );
}

// 8) credencial já enviada — automáticos não reenviam
{
  const { checkin, agora } = dayAt13h();
  for (const origem of ["automatico_requisitos", "automatico_13h"] as const) {
    const d = avaliarLiberacaoCredenciais({
      pagamentoStatus: "pago",
      fnrhStatus: "completa",
      senhaEnviada: true,
      dataHoraCheckin: checkin,
      dataHoraAtual: agora,
      origem,
    });
    assert.equal(d.deveGerar, false);
    assert.equal(d.deveEnviar, false);
    assert.equal(d.motivo, "ja_enviada");
    assert.equal(d.acaoPainel, "reenviar");
    assert.equal(d.alertaOperacional, null);
  }

  const reenviar = avaliarLiberacaoCredenciais({
    pagamentoStatus: "pago",
    fnrhStatus: "completa",
    senhaEnviada: true,
    dataHoraCheckin: checkin,
    dataHoraAtual: agora,
    origem: "manual",
    acaoSolicitada: "reenviar",
  });
  assert.equal(reenviar.deveGerar, false);
  assert.equal(reenviar.deveEnviar, true);
  assert.equal(reenviar.motivo, "reenvio");
}

// 9) falha na geração
{
  resetCredentialReleaseMockState();
  const { checkin, agora } = dayBefore13h();
  const result = executarLiberacaoCredenciaisMock({
    reservaId: "r-fail-gen",
    pagamentoStatus: "pago",
    fnrhStatus: "completa",
    senhaEnviada: false,
    dataHoraCheckin: checkin,
    dataHoraAtual: agora,
    origem: "automatico_requisitos",
    forcarFalhaGeracao: true,
  });
  assert.equal(result.enviadoNestaExecucao, false);
  assert.equal(result.state.falhaGeracao, true);
  assert.equal(result.decisao.alertaOperacional, "Falha ao gerar senha");
  assert.equal(
    derivarAlertaOperacional({
      pagamentoStatus: "pago",
      fnrhStatus: "completa",
      senhaEnviada: false,
      falhaGeracao: true,
    }),
    "Falha ao gerar senha",
  );
}

// 10) falha no envio
{
  resetCredentialReleaseMockState();
  const { checkin, agora } = dayBefore13h();
  const result = executarLiberacaoCredenciaisMock({
    reservaId: "r-fail-send",
    pagamentoStatus: "pago",
    fnrhStatus: "completa",
    senhaEnviada: false,
    dataHoraCheckin: checkin,
    dataHoraAtual: agora,
    origem: "automatico_requisitos",
    forcarFalhaEnvio: true,
  });
  assert.equal(result.geradoNestaExecucao, true);
  assert.equal(result.enviadoNestaExecucao, false);
  assert.equal(result.decisao.alertaOperacional, "Falha ao enviar credenciais");
}

// 11) desaparecimento do alerta após resolução das pendências
{
  const before = derivarAlertaOperacional({
    pagamentoStatus: "pendente",
    fnrhStatus: "pendente",
    senhaEnviada: true,
    liberacaoManualComPendencias: true,
  });
  assert.equal(
    before,
    "Acesso liberado manualmente — pagamento e FNRH pendentes",
  );

  const afterPayment = derivarAlertaOperacional({
    pagamentoStatus: "pago",
    fnrhStatus: "pendente",
    senhaEnviada: true,
    liberacaoManualComPendencias: true,
  });
  assert.equal(afterPayment, "Acesso liberado manualmente — FNRH pendente");

  const cleared = derivarAlertaOperacional({
    pagamentoStatus: "pago",
    fnrhStatus: "completa",
    senhaEnviada: true,
    liberacaoManualComPendencias: true,
  });
  assert.equal(cleared, null);
}

// 12) concorrência de dois gatilhos sem envio duplicado
{
  resetCredentialReleaseMockState();
  const { checkin, agora } = dayBefore13h();
  let concurrentBlocked = false;

  const first = executarLiberacaoCredenciaisMock({
    reservaId: "r-race",
    pagamentoStatus: "pago",
    fnrhStatus: "completa",
    senhaEnviada: false,
    dataHoraCheckin: checkin,
    dataHoraAtual: agora,
    origem: "automatico_requisitos",
    duringLock: () => {
      const second = executarLiberacaoCredenciaisMock({
        reservaId: "r-race",
        pagamentoStatus: "pago",
        fnrhStatus: "completa",
        senhaEnviada: false,
        dataHoraCheckin: checkin,
        dataHoraAtual: agora,
        origem: "automatico_13h",
      });
      assert.equal(second.enviadoNestaExecucao, false);
      assert.equal(second.decisao.motivo, "envio_em_andamento");
      concurrentBlocked = true;
    },
  });

  assert.equal(first.enviadoNestaExecucao, true);
  assert.equal(first.state.envios, 1);
  assert.equal(concurrentBlocked, true);

  const after = executarLiberacaoCredenciaisMock({
    reservaId: "r-race",
    pagamentoStatus: "pago",
    fnrhStatus: "completa",
    senhaEnviada: true,
    dataHoraCheckin: checkin,
    dataHoraAtual: agora,
    origem: "automatico_13h",
  });
  assert.equal(after.enviadoNestaExecucao, false);
  assert.equal(after.decisao.motivo, "ja_enviada");
  assert.equal(getCredentialReleaseMockState("r-race").envios, 1);
}

// 13) gerar nova senha exige confirmação; reenvio não regenera
{
  resetCredentialReleaseMockState();
  const { checkin, agora } = dayBefore13h();
  executarLiberacaoCredenciaisMock({
    reservaId: "r-new",
    pagamentoStatus: "pago",
    fnrhStatus: "completa",
    senhaEnviada: false,
    dataHoraCheckin: checkin,
    dataHoraAtual: agora,
    origem: "automatico_requisitos",
  });

  const waitingNew = avaliarLiberacaoCredenciais({
    pagamentoStatus: "pago",
    fnrhStatus: "completa",
    senhaEnviada: true,
    dataHoraCheckin: checkin,
    dataHoraAtual: agora,
    origem: "manual",
    acaoSolicitada: "gerar_nova",
  });
  assert.equal(waitingNew.exigeConfirmacaoGerarNova, true);
  assert.equal(waitingNew.deveGerar, false);

  const resend = executarLiberacaoCredenciaisMock({
    reservaId: "r-new",
    pagamentoStatus: "pago",
    fnrhStatus: "completa",
    senhaEnviada: true,
    dataHoraCheckin: checkin,
    dataHoraAtual: agora,
    origem: "manual",
    acaoSolicitada: "reenviar",
  });
  assert.equal(resend.geradoNestaExecucao, false);
  assert.equal(resend.enviadoNestaExecucao, true);
  assert.equal(resend.state.geracoes, 1);
  assert.equal(resend.state.envios, 2);

  const regenerated = executarLiberacaoCredenciaisMock({
    reservaId: "r-new",
    pagamentoStatus: "pago",
    fnrhStatus: "completa",
    senhaEnviada: true,
    dataHoraCheckin: checkin,
    dataHoraAtual: agora,
    origem: "manual",
    acaoSolicitada: "gerar_nova",
    confirmacaoGerarNova: true,
  });
  assert.equal(regenerated.geradoNestaExecucao, true);
  assert.equal(regenerated.state.geracoes, 2);
}

console.log("Política de liberação de credenciais: testes concluídos com sucesso.");
