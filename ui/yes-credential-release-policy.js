/**
 * Espelho browser da política em src/lib/domain/yes-hotel/credential-release-policy.ts.
 * Manter sincronizado com o domínio TypeScript (fonte da verdade nos testes).
 */
(function attachYesHotelCredentialReleasePolicy(globalScope) {
  "use strict";

  var CHECKIN_AUTO_HOUR = 13;

  function parseDateTime(value) {
    var date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new Error("Data/hora inválida: " + String(value));
    }
    return date;
  }

  function sameLocalDate(a, b) {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  function listarPendenciasCredenciais(pagamentoStatus, fnrhStatus) {
    var pendencias = [];
    if (pagamentoStatus !== "pago") pendencias.push("pagamento");
    if (fnrhStatus !== "completa") pendencias.push("fnrh");
    return pendencias;
  }

  function atingiuHorario13hCheckin(dataHoraCheckin, dataHoraAtual) {
    var checkin = parseDateTime(dataHoraCheckin);
    var agora = parseDateTime(dataHoraAtual);
    if (!sameLocalDate(checkin, agora)) return false;
    return (
      agora.getHours() > CHECKIN_AUTO_HOUR ||
      (agora.getHours() === CHECKIN_AUTO_HOUR && agora.getMinutes() >= 0)
    );
  }

  function derivarAlertaOperacional(input) {
    var pendencias = listarPendenciasCredenciais(
      input.pagamentoStatus,
      input.fnrhStatus,
    );

    if (input.falhaGeracao) return "Falha ao gerar senha";
    if (input.falhaEnvio) return "Falha ao enviar credenciais";

    if (input.liberacaoManualComPendencias && pendencias.length > 0) {
      if (pendencias.length === 2) {
        return "Acesso liberado manualmente — pagamento e FNRH pendentes";
      }
      if (pendencias[0] === "fnrh") {
        return "Acesso liberado manualmente — FNRH pendente";
      }
      return "Acesso liberado manualmente — pagamento pendente";
    }

    if (input.liberacaoManualComPendencias && pendencias.length === 0) {
      return null;
    }

    if (pendencias.length === 2) return "Pagamento e FNRH pendentes";
    if (pendencias[0] === "pagamento") return "Pagamento pendente";
    if (pendencias[0] === "fnrh") return "FNRH pendente";
    if (!input.senhaEnviada) return "Senha ainda não enviada";
    return null;
  }

  function derivarAcaoPainel(input) {
    return input.senhaEnviada ? "reenviar" : "gerar_e_enviar";
  }

  function requisitosOk(pagamentoStatus, fnrhStatus) {
    return pagamentoStatus === "pago" && fnrhStatus === "completa";
  }

  function avaliarLiberacaoCredenciais(input) {
    var pendenciasAtuais = listarPendenciasCredenciais(
      input.pagamentoStatus,
      input.fnrhStatus,
    );
    var alertaOperacional = derivarAlertaOperacional({
      pagamentoStatus: input.pagamentoStatus,
      fnrhStatus: input.fnrhStatus,
      senhaEnviada: input.senhaEnviada,
      falhaGeracao: input.falhaGeracao,
      falhaEnvio: input.falhaEnvio,
      liberacaoManualComPendencias: input.liberacaoManualComPendencias,
    });
    var acaoPadraoPainel = input.senhaEnviada ? "reenviar" : "gerar_e_enviar";
    var base = {
      pendenciasAtuais: pendenciasAtuais,
      alertaOperacional: alertaOperacional,
      acaoPainel: acaoPadraoPainel,
      exigeConfirmacaoManual: false,
      exigeConfirmacaoGerarNova: false,
    };

    if (input.envioEmAndamento) {
      return Object.assign({}, base, {
        deveGerar: false,
        deveEnviar: false,
        motivo: "envio_em_andamento",
        acaoPainel: "nenhuma",
      });
    }

    var acao = input.acaoSolicitada || "gerar_enviar";

    if (acao === "gerar_nova") {
      if (!input.confirmacaoGerarNova) {
        return Object.assign({}, base, {
          deveGerar: false,
          deveEnviar: false,
          motivo: "gerar_nova_aguardando_confirmacao",
          acaoPainel: "gerar_nova",
          exigeConfirmacaoGerarNova: true,
        });
      }
      return Object.assign({}, base, {
        deveGerar: true,
        deveEnviar: true,
        motivo: "gerar_nova",
        acaoPainel: "gerar_nova",
      });
    }

    if (acao === "reenviar") {
      if (!input.senhaEnviada) {
        return Object.assign({}, base, {
          deveGerar: true,
          deveEnviar: true,
          motivo: input.origem === "manual" ? "manual" : "requisitos_ok",
          acaoPainel: "gerar_e_enviar",
        });
      }
      return Object.assign({}, base, {
        deveGerar: false,
        deveEnviar: true,
        motivo: "reenvio",
        acaoPainel: "reenviar",
      });
    }

    if (input.senhaEnviada) {
      return Object.assign({}, base, {
        deveGerar: false,
        deveEnviar: false,
        motivo: "ja_enviada",
        acaoPainel: "reenviar",
      });
    }

    if (input.origem === "automatico_requisitos") {
      if (requisitosOk(input.pagamentoStatus, input.fnrhStatus)) {
        return Object.assign({}, base, {
          deveGerar: true,
          deveEnviar: true,
          motivo: "requisitos_ok",
        });
      }
      return Object.assign({}, base, {
        deveGerar: false,
        deveEnviar: false,
        motivo: "origem_incompativel",
        acaoPainel: "gerar_e_enviar",
      });
    }

    if (input.origem === "automatico_13h") {
      if (atingiuHorario13hCheckin(input.dataHoraCheckin, input.dataHoraAtual)) {
        return Object.assign({}, base, {
          deveGerar: true,
          deveEnviar: true,
          motivo: "horario_13h",
        });
      }
      return Object.assign({}, base, {
        deveGerar: false,
        deveEnviar: false,
        motivo: "origem_incompativel",
        acaoPainel: "gerar_e_enviar",
      });
    }

    if (pendenciasAtuais.length > 0 && !input.confirmacaoManual) {
      return Object.assign({}, base, {
        deveGerar: false,
        deveEnviar: false,
        motivo: "manual_aguardando_confirmacao",
        acaoPainel: "confirmar_manual",
        exigeConfirmacaoManual: true,
      });
    }

    return Object.assign({}, base, {
      deveGerar: true,
      deveEnviar: true,
      motivo: "manual",
      alertaOperacional:
        pendenciasAtuais.length > 0
          ? derivarAlertaOperacional({
              pagamentoStatus: input.pagamentoStatus,
              fnrhStatus: input.fnrhStatus,
              senhaEnviada: false,
              liberacaoManualComPendencias: true,
            })
          : alertaOperacional,
    });
  }

  globalScope.YesHotelCredentialReleasePolicy = Object.freeze({
    listarPendenciasCredenciais: listarPendenciasCredenciais,
    atingiuHorario13hCheckin: atingiuHorario13hCheckin,
    derivarAlertaOperacional: derivarAlertaOperacional,
    derivarAcaoPainel: derivarAcaoPainel,
    avaliarLiberacaoCredenciais: avaliarLiberacaoCredenciais,
  });
})(window);
