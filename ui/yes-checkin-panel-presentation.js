/**
 * Apresentação do Check-in Operacional (hóspedes, histórico, telefone).
 * Funções puras — sem I/O, sem mutação de reserva/banco.
 * Testado via scripts/test-checkin-panel-presentation.ts
 */
(function (global) {
  "use strict";

  var TZ = "America/Campo_Grande";
  var GROUP_MAX_GAP_MS = 15 * 60 * 1000;

  function parseJsonSafe(raw) {
    if (raw == null) return null;
    if (typeof raw === "object") return raw;
    var t = String(raw).trim();
    if (!t || (t.charAt(0) !== "{" && t.charAt(0) !== "[")) return null;
    try {
      return JSON.parse(t);
    } catch (_e) {
      return null;
    }
  }

  function formatDateTimeCampoGrande(isoOrDate) {
    if (isoOrDate == null || isoOrDate === "") return "";
    var d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
    if (isNaN(d.getTime())) return "";
    try {
      var parts = new Intl.DateTimeFormat("pt-BR", {
        timeZone: TZ,
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(d);
      var map = {};
      parts.forEach(function (p) {
        if (p.type !== "literal") map[p.type] = p.value;
      });
      if (map.day && map.month && map.hour && map.minute) {
        return map.day + "/" + map.month + " " + map.hour + ":" + map.minute;
      }
    } catch (_e) {
      /* fallback below */
    }
    var day = String(d.getUTCDate()).padStart(2, "0");
    var month = String(d.getUTCMonth() + 1).padStart(2, "0");
    var hour = String(d.getUTCHours()).padStart(2, "0");
    var minute = String(d.getUTCMinutes()).padStart(2, "0");
    return day + "/" + month + " " + hour + ":" + minute;
  }

  /** Exibição BR; não altera o valor armazenado. */
  function formatPhoneBrDisplay(raw) {
    if (raw == null) return "";
    var digits = String(raw).replace(/\D/g, "");
    if (digits.length === 13 && digits.indexOf("55") === 0) digits = digits.slice(2);
    if (digits.length === 12 && digits.indexOf("55") === 0) digits = digits.slice(2);
    if (digits.length === 11) {
      return (
        "(" +
        digits.slice(0, 2) +
        ") " +
        digits.slice(2, 7) +
        "-" +
        digits.slice(7)
      );
    }
    if (digits.length === 10) {
      return (
        "(" +
        digits.slice(0, 2) +
        ") " +
        digits.slice(2, 6) +
        "-" +
        digits.slice(6)
      );
    }
    return String(raw).trim();
  }

  /**
   * Apresentação do card de hóspede (estado atual).
   * FNRH confirmada: Cadastro OK; não exibe ruído de “ainda não enviado”.
   */
  function presentGuestCardState(guest) {
    var status = guest && guest.statusOperacional != null ? String(guest.statusOperacional) : "";
    var confirmed = status === "confirmado";
    var pendingSend = status === "enviado" || status === "pronto_para_envio" || status === "aguardando_contato" || status === "nao_identificado";
    var email = guest && guest.email != null ? String(guest.email).trim() : "";
    var whatsappRaw = guest && guest.whatsapp != null ? String(guest.whatsapp).trim() : "";
    var nome = guest && guest.nome != null ? String(guest.nome).trim() : "";

    if (confirmed) {
      return {
        mode: "confirmed",
        showSendNoise: false,
        cadastroOkLabel: "Cadastro do hóspede: OK",
        statusLabel: "FNRH confirmada",
        pendencyText: "",
        nome: nome,
        email: email,
        whatsappDisplay: formatPhoneBrDisplay(whatsappRaw),
        whatsappRaw: whatsappRaw,
        preferReadOnly: true,
      };
    }

    var pendency = "";
    if (status === "enviado") pendency = "Link enviado — aguardando confirmação do hóspede.";
    else if (status === "pronto_para_envio") pendency = "Pronto para envio do link da FNRH.";
    else if (status === "aguardando_contato") pendency = "Falta e-mail ou WhatsApp para enviar o link.";
    else if (status === "nao_identificado") pendency = "Complete o nome do hóspede antes de enviar o link.";
    else pendency = "Cadastro do hóspede pendente.";

    return {
      mode: pendingSend ? "pending" : "other",
      showSendNoise: true,
      cadastroOkLabel: "",
      statusLabel: status || "Status não informado",
      pendencyText: pendency,
      nome: nome,
      email: email,
      whatsappDisplay: formatPhoneBrDisplay(whatsappRaw),
      whatsappRaw: whatsappRaw,
      preferReadOnly: false,
    };
  }

  /** Resumo de comunicação da reserva: omite “ainda não enviado” quando FNRH já está confirmada. */
  function formatResumoComunicacaoApresentacao(counts, opts) {
    opts = opts || {};
    var parts = [];
    var r = counts || {};
    if (r.porWhatsapp > 0) parts.push(r.porWhatsapp + " com envio por WhatsApp");
    if (r.porEmail > 0) parts.push(r.porEmail + " com envio por e-mail");
    if (r.porAmbos > 0) parts.push(r.porAmbos + " com envio por ambos");
    var hideNaoEnviado = !!opts.hideNaoEnviadoQuandoConfirmado || !!opts.allFnrhConfirmed;
    if (!hideNaoEnviado && r.naoEnviado > 0) {
      parts.push(r.naoEnviado + " ainda não enviado");
    }
    if (opts.allFnrhConfirmed) return "";
    return parts.length ? parts.join("; ") : "";
  }

  function humanizeUnknownTipo(tipo) {
    var t = String(tipo || "").trim();
    if (!t) return "Evento da reserva";
    return t
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\b\w/g, function (c) {
        return c.toUpperCase();
      });
  }

  function channelFromFnrhDetalhe(p) {
    if (!p || typeof p !== "object") return "";
    var w = Number(p.enviados_whatsapp || 0);
    var e = Number(p.enviados_email != null ? p.enviados_email : p.enviados_e_mail || 0);
    if (w > 0 && e > 0) return "ambos";
    if (w > 0) return "whatsapp";
    if (e > 0) return "email";
    if (p.canal) return String(p.canal);
    return "";
  }

  function channelFromSenhaDetalhe(p) {
    if (!p || typeof p !== "object") return "";
    var c = p.canais || {};
    var w = !!(c.whatsapp || p.canal_operacional_whatsapp);
    var e = !!c.email;
    if (w && e) return "ambos";
    if (w) return "whatsapp";
    if (e) return "email";
    return "";
  }

  function errorKeyFromPayload(p) {
    if (!p || typeof p !== "object") return "";
    if (p.erro_resumido) return String(p.erro_resumido).slice(0, 80);
    if (p.erro) return String(p.erro).slice(0, 80);
    if (p.tipo_bloqueio) return String(p.tipo_bloqueio);
    if (p.status_final && (p.status_final === "falhou" || p.status_final === "parcial")) {
      return String(p.status_final);
    }
    return "";
  }

  /**
   * Tradução visual de um evento do histórico.
   * Nunca inventa sucesso: fallback neutro para tipos desconhecidos.
   */
  function presentHistoricoEvent(ev) {
    var tipo = ev && ev.tipo != null ? String(ev.tipo) : "";
    var tituloOrig = ev && ev.titulo != null ? String(ev.titulo) : "";
    var detalheOrig = ev && ev.detalhe != null ? ev.detalhe : null;
    var iso = (ev && (ev.criadoEmIso || ev.criado_em)) || null;
    var payload = parseJsonSafe(detalheOrig);
    var whenLabel = iso
      ? formatDateTimeCampoGrande(iso)
      : ev && ev.em
        ? String(ev.em)
        : "";

    var category = "outro";
    var status = "info";
    var channel = "";
    var errorKey = "";
    var title = "";
    var description = "";
    var tone = "neutral";

    function base() {
      return {
        category: category,
        status: status,
        channel: channel,
        errorKey: errorKey,
        title: title,
        description: description,
        tone: tone,
        whenLabel: whenLabel,
        createdAtMs: iso ? new Date(iso).getTime() : NaN,
        technical: {
          tipo: tipo,
          titulo: tituloOrig,
          detalhe: detalheOrig == null ? null : String(detalheOrig),
          criadoEmIso: iso,
        },
      };
    }

    if (tipo === "envio_auto_fnrh" || tipo === "links_enviados" || tipo === "reenvio") {
      category = "fnrh_envio";
      channel = channelFromFnrhDetalhe(payload);
      var enviados = payload ? Number(payload.enviados || 0) : 0;
      var erros = payload ? Number(payload.erros || 0) : 0;
      if (tipo === "reenvio" && !payload) {
        status = "success";
        tone = "success";
        title = "Link da FNRH enviado";
        description = "Reenvio registrado.";
        return base();
      }
      if (erros > 0 && enviados === 0) {
        status = "fail";
        tone = "danger";
        title = "FNRH não enviada";
        errorKey = errorKeyFromPayload(payload) || "erros";
        description = errorKeyFromPayload(payload) || "Falha no envio do link.";
      } else if (erros > 0 && enviados > 0) {
        status = "fail";
        tone = "warn";
        title = "FNRH enviada com falhas";
        errorKey = errorKeyFromPayload(payload) || "parcial";
        description = enviados + " enviado(s), " + erros + " erro(s).";
      } else {
        status = "success";
        tone = "success";
        title = "Link da FNRH enviado";
        description = enviados > 0 ? enviados + " link(s) enviado(s)." : "";
      }
      return base();
    }

    if (tipo === "fnrh_confirmada" || tipo === "fnrh_validada" || tipo === "fnrh_completa") {
      category = "fnrh_confirmacao";
      status = "success";
      tone = "success";
      title = "Cadastro do hóspede concluído";
      description = tipo === "fnrh_completa" ? "Todas as FNRHs da reserva confirmadas." : "";
      return base();
    }

    if (tipo === "fnrh_sync_hits") {
      category = "fnrh_hits";
      var st = payload && payload.status != null ? String(payload.status) : "";
      channel = "";
      if (st === "ok" || st === "sucesso" || st === "concluido" || st === "enviado") {
        status = "success";
        tone = "success";
        title = "Cadastro enviado ao HITS";
      } else if (st === "pendente" || st === "pending") {
        status = "pending";
        tone = "warn";
        title = "Envio ao HITS pendente";
        errorKey = errorKeyFromPayload(payload) || st;
        description = payload && payload.erro ? String(payload.erro) : "";
      } else if (st === "erro" || st === "failed" || st === "falhou") {
        status = "fail";
        tone = "danger";
        title = "Envio ao HITS falhou";
        errorKey = errorKeyFromPayload(payload) || st;
        description = payload && payload.erro ? String(payload.erro) : "";
      } else {
        status = "info";
        tone = "neutral";
        title = "Sincronização FNRH com HITS";
        description = st ? "Status: " + st : "";
        errorKey = errorKeyFromPayload(payload);
      }
      return base();
    }

    if (
      tipo === "ttlock_provision_iniciado" ||
      tipo === "ttlock_provision_sucesso" ||
      tipo === "ttlock_provision_ja_concluido" ||
      tipo === "ttlock_provision_falhou" ||
      tipo === "ttlock_provision_sem_pendente_com_itens" ||
      tipo === "ttlock_credencial_nao_encontrada" ||
      tipo === "falha_gerar_senha" ||
      tipo === "falha_enviar_credenciais"
    ) {
      category = "ttlock_senha";
      errorKey = errorKeyFromPayload(payload);
      if (tipo === "ttlock_provision_iniciado") {
        status = "pending";
        tone = "warn";
        title = "Criação da senha iniciada";
      } else if (tipo === "ttlock_provision_sucesso" || tipo === "ttlock_provision_ja_concluido") {
        status = "success";
        tone = "success";
        title = "Senha criada com sucesso";
        description = tipo === "ttlock_provision_ja_concluido" ? "Já estava pronta nas fechaduras." : "";
      } else if (tipo === "ttlock_provision_falhou" || tipo === "falha_gerar_senha") {
        status = "fail";
        tone = "danger";
        title = "Falha ao criar a senha";
        description = errorKey || "";
      } else if (tipo === "falha_enviar_credenciais") {
        status = "fail";
        tone = "danger";
        title = "Falha no envio da senha";
        description = errorKey || "";
        channel = channelFromSenhaDetalhe(payload);
      } else if (tipo === "ttlock_credencial_nao_encontrada") {
        status = "fail";
        tone = "danger";
        title = "Senha ainda não disponível";
        description = "Credencial não encontrada para provisionar.";
      } else {
        // sem_pendente_com_itens: não inventar sucesso
        var sf = payload && payload.status_final != null ? String(payload.status_final) : "";
        if (sf === "provisionada") {
          status = "success";
          tone = "success";
          title = "Senha criada com sucesso";
        } else if (sf === "parcial") {
          status = "fail";
          tone = "warn";
          title = "Senha pendente em parte dos acessos";
          errorKey = errorKey || "parcial";
        } else {
          status = "pending";
          tone = "warn";
          title = "Criação da senha em andamento";
        }
      }
      if (payload && payload.status_final === "parcial" && tipo === "ttlock_provision_sucesso") {
        status = "fail";
        tone = "warn";
        title = "Senha pendente em parte dos acessos";
      }
      return base();
    }

    if (
      tipo === "envio_manual_senha" ||
      tipo === "envio_auto_senha" ||
      tipo === "gerar_nova_senha_solicitada"
    ) {
      category = "ttlock_senha_envio";
      channel = channelFromSenhaDetalhe(payload);
      errorKey = errorKeyFromPayload(payload);
      var bloqueio = payload && payload.tipo_bloqueio ? String(payload.tipo_bloqueio) : "";
      var okFlag = payload && (payload.ok === true || payload.sucesso === true || payload.status === "ok");
      var failFlag =
        !!bloqueio ||
        payload && (payload.ok === false || payload.sucesso === false || payload.status === "erro" || payload.status === "failed");
      if (failFlag && !okFlag) {
        status = "fail";
        tone = "danger";
        title = "Falha no envio da senha";
        description = (payload && payload.motivo_bloqueio) || errorKey || "";
      } else if (tipo === "gerar_nova_senha_solicitada") {
        status = "pending";
        tone = "warn";
        title = "Nova senha solicitada";
      } else {
        status = "success";
        tone = "success";
        title = "Senha enviada ao hóspede";
      }
      return base();
    }

    if (
      tipo === "ttlock_checkout_executado" ||
      tipo === "lifecycle_cancel" ||
      /revog/i.test(tipo) ||
      /revog/i.test(tituloOrig)
    ) {
      category = "ttlock_revoga";
      status = "info";
      tone = "warn";
      title = "Senha cancelada";
      return base();
    }

    if (tipo === "ttlock_validity_updated") {
      category = "ttlock_validade";
      status = "info";
      tone = "neutral";
      title = "Validade da senha atualizada";
      return base();
    }

    if (tipo === "acesso_liberado") {
      category = "acesso";
      status = "success";
      tone = "success";
      title = "Acesso liberado";
      return base();
    }

    if (tipo === "entrada_apto" || tipo === "entrada_apartamento") {
      category = "acesso_entrada";
      status = "success";
      tone = "success";
      title = "Hóspede entrou no apartamento";
      return base();
    }

    if (tipo === "pagamento" || tipo === "pagamento_aprovado" || tipo === "hits_pagamento_alterado") {
      category = "pagamento";
      status = "success";
      tone = "success";
      title = "Pagamento confirmado";
      if (tipo === "hits_pagamento_alterado") {
        status = "info";
        tone = "neutral";
        title = "Pagamento atualizado pelo PMS";
      }
      return base();
    }

    if (
      tipo === "hospede_adicionado" ||
      tipo === "hospede_removido" ||
      tipo === "principal_alterado"
    ) {
      category = "hospede_cadastro";
      status = "info";
      tone = "neutral";
      if (tipo === "hospede_adicionado") title = "Hóspede adicionado";
      else if (tipo === "hospede_removido") title = "Hóspede removido";
      else title = "Dados do hóspede atualizados";
      description = detalheOrig && !parseJsonSafe(detalheOrig) ? String(detalheOrig) : "";
      return base();
    }

    if (tipo === "liberacao_manual_com_pendencias") {
      category = "acesso_manual";
      status = "warn";
      tone = "warn";
      title = "Acesso liberado com pendências";
      return base();
    }

    if (tipo.indexOf("hits_") === 0) {
      category = "hits_alteracao";
      status = "info";
      tone = "neutral";
      title = humanizeUnknownTipo(tipo.replace(/^hits_/, ""));
      description = "Alteração sincronizada do PMS.";
      return base();
    }

    if (tipo === "reserva_criada") {
      category = "reserva";
      status = "info";
      tone = "neutral";
      title = "Reserva registrada";
      return base();
    }

    // Fallback seguro: não oculta, não inventa sucesso
    category = "desconhecido";
    status = "info";
    tone = "neutral";
    title = tituloOrig && tituloOrig.trim() ? tituloOrig.trim() : humanizeUnknownTipo(tipo);
    if (/fail|erro|falha/i.test(tituloOrig) || /fail|erro|falha/i.test(tipo)) {
      tone = "danger";
      status = "fail";
    }
    description = "";
    return base();
  }

  function groupKey(p) {
    return [p.category, p.status, p.channel || "", p.errorKey || ""].join("|");
  }

  /**
   * Agrupa tentativas repetidas equivalentes (mesma categoria/status/canal/erro, próximas no tempo).
   * Entrada: eventos na ordem em que serão exibidos (mais recentes primeiro).
   */
  function groupHistoricoEvents(events, opts) {
    opts = opts || {};
    var maxGap = opts.maxGapMs != null ? opts.maxGapMs : GROUP_MAX_GAP_MS;
    var presented = (events || []).map(presentHistoricoEvent);
    var groups = [];
    var i = 0;
    while (i < presented.length) {
      var cur = presented[i];
      var members = [cur];
      var j = i + 1;
      while (j < presented.length) {
        var next = presented[j];
        if (groupKey(cur) !== groupKey(next)) break;
        if (cur.category === "desconhecido") break;
        var t0 = cur.createdAtMs;
        var t1 = next.createdAtMs;
        if (!isNaN(t0) && !isNaN(t1) && Math.abs(t0 - t1) > maxGap) break;
        // Não agrupar se o intervalo com o último membro do grupo for grande
        var last = members[members.length - 1];
        if (!isNaN(last.createdAtMs) && !isNaN(t1) && Math.abs(last.createdAtMs - t1) > maxGap) break;
        members.push(next);
        j++;
      }

      var count = members.length;
      var newest = members[0];
      var oldest = members[members.length - 1];
      var title = newest.title;
      var description = newest.description || "";
      if (count > 1 && newest.status === "fail") {
        title = newest.title + " — " + count + " tentativas";
        description =
          "Entre " +
          (oldest.whenLabel || "—") +
          " e " +
          (newest.whenLabel || "—");
      } else if (count > 1 && newest.status === "success") {
        description = (description ? description + " " : "") + "(" + count + " registros)";
      } else if (count > 1) {
        title = newest.title + " — " + count + " ocorrências";
      }

      groups.push({
        title: title,
        description: description.trim(),
        tone: newest.tone,
        whenLabel: newest.whenLabel,
        count: count,
        category: newest.category,
        status: newest.status,
        channel: newest.channel,
        members: members,
        technicalItems: members.map(function (m) {
          return m.technical;
        }),
      });
      i = j;
    }

    // Anotar sucesso após falhas recentes da mesma categoria operacional
    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g];
      if (grp.status !== "success") continue;
      var failCount = 0;
      for (var k = g + 1; k < groups.length; k++) {
        var prev = groups[k];
        if (prev.category !== grp.category) break;
        if (prev.status === "fail") failCount += prev.count;
        else break;
      }
      if (failCount > 0) {
        var note = "após " + failCount + " tentativa" + (failCount > 1 ? "s" : "");
        grp.description = grp.description ? grp.description + " · " + note : note;
        grp.afterFailures = failCount;
      }
    }

    return groups;
  }

  function escapeHtmlText(s) {
    if (s == null || s === "") return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatTechnicalPayload(detalhe) {
    if (detalhe == null || detalhe === "") return "";
    var parsed = parseJsonSafe(detalhe);
    if (parsed) {
      try {
        return JSON.stringify(parsed, null, 2);
      } catch (_e) {
        return String(detalhe);
      }
    }
    return String(detalhe);
  }

  /** HTML seguro do histórico (usa escape; sem innerHTML de payload cru). */
  function renderHistoricoGroupsHtml(groups) {
    if (!groups || !groups.length) {
      return '<p class="timeline-empty">Nenhum evento registrado ainda.</p>';
    }
    return groups
      .map(function (g, idx) {
        var tone = g.tone || "neutral";
        var desc = g.description
          ? '<p class="hist-item-desc">' + escapeHtmlText(g.description) + "</p>"
          : "";
        var techInner = (g.technicalItems || [])
          .map(function (t, ti) {
            var payload = formatTechnicalPayload(t.detalhe);
            return (
              '<div class="hist-tech-block">' +
              '<p class="hist-tech-meta"><strong>Evento interno:</strong> ' +
              escapeHtmlText(t.tipo || "—") +
              "</p>" +
              '<p class="hist-tech-meta"><strong>Título original:</strong> ' +
              escapeHtmlText(t.titulo || "—") +
              "</p>" +
              (t.criadoEmIso
                ? '<p class="hist-tech-meta"><strong>Timestamp:</strong> ' +
                  escapeHtmlText(t.criadoEmIso) +
                  "</p>"
                : "") +
              (payload
                ? '<pre class="hist-tech-pre">' + escapeHtmlText(payload) + "</pre>"
                : "") +
              (g.technicalItems.length > 1
                ? '<p class="hist-tech-meta">#' + (ti + 1) + " de " + g.technicalItems.length + "</p>"
                : "") +
              "</div>"
            );
          })
          .join("");
        return (
          '<article class="hist-item hist-item--' +
          escapeHtmlText(tone) +
          '">' +
          '<div class="hist-item-head">' +
          '<span class="hist-item-time">' +
          escapeHtmlText(g.whenLabel || "—") +
          "</span>" +
          '<span class="hist-item-title">' +
          escapeHtmlText(g.title) +
          "</span>" +
          "</div>" +
          desc +
          '<details class="hist-tech">' +
          '<summary class="hist-tech-sum">Ver detalhes técnicos</summary>' +
          '<div class="hist-tech-body" data-hist-group="' +
          idx +
          '">' +
          techInner +
          "</div>" +
          "</details>" +
          "</article>"
        );
      })
      .join("");
  }

  /** Mantém mapping TTLock do PR #14 para testes de regressão visual. */
  function presentTtlockPasswordStatus(data) {
    var status = data && data.status != null ? String(data.status) : null;
    var syncStatus = data && data.syncStatus != null ? String(data.syncStatus) : null;
    var resumoRaw = data && data.resumo != null ? String(data.resumo) : "";

    if (status === "provisionada") {
      return { statusClass: "sync-ok", statusLabel: "Senha pronta", resumoText: "" };
    }
    if (status === "falhou" || syncStatus === "failed") {
      return { statusClass: "sync-failed", statusLabel: "Falha no envio", resumoText: resumoRaw };
    }
    if (status === "parcial" || syncStatus === "partial") {
      return { statusClass: "sync-partial", statusLabel: "Envio pendente", resumoText: resumoRaw };
    }
    if (
      status === "pendente" ||
      status === "pronta" ||
      status === "provisionando" ||
      syncStatus === "pending"
    ) {
      return { statusClass: "sync-pending", statusLabel: "Envio pendente", resumoText: "" };
    }
    if (status === "revogada") {
      if (syncStatus === "failed") {
        return { statusClass: "sync-failed", statusLabel: "Falha no envio", resumoText: resumoRaw };
      }
      if (syncStatus === "pending" || syncStatus === "partial") {
        return {
          statusClass: syncStatus === "partial" ? "sync-partial" : "sync-pending",
          statusLabel: "Envio pendente",
          resumoText: resumoRaw,
        };
      }
      return { statusClass: "sync-ok", statusLabel: "Revogada", resumoText: "" };
    }
    if (!status && !syncStatus) {
      return { statusClass: "sync-pending", statusLabel: "Status não informado", resumoText: "" };
    }
    if (syncStatus === "ok") {
      return { statusClass: "sync-ok", statusLabel: "Status não informado", resumoText: resumoRaw };
    }
    return { statusClass: "sync-pending", statusLabel: "Status não informado", resumoText: resumoRaw };
  }

  global.YesHotelCheckinPanelPresentation = {
    TZ: TZ,
    formatDateTimeCampoGrande: formatDateTimeCampoGrande,
    formatPhoneBrDisplay: formatPhoneBrDisplay,
    presentGuestCardState: presentGuestCardState,
    formatResumoComunicacaoApresentacao: formatResumoComunicacaoApresentacao,
    presentHistoricoEvent: presentHistoricoEvent,
    groupHistoricoEvents: groupHistoricoEvents,
    renderHistoricoGroupsHtml: renderHistoricoGroupsHtml,
    formatTechnicalPayload: formatTechnicalPayload,
    escapeHtmlText: escapeHtmlText,
    presentTtlockPasswordStatus: presentTtlockPasswordStatus,
  };
})(typeof window !== "undefined" ? window : globalThis);
