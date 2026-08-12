/**
 * FNRH check-in digital v2 — jornada mobile-first (8 etapas).
 * Sem GOV.BR, OTP ou assinatura em canvas.
 * Depende de window.YES_HOTEL_SUPABASE_CONFIG e de guest_id/token na URL.
 */
(function (global) {
  "use strict";

  var DEBOUNCE_MS = 850;
  var STEPS = [
    { id: "documento", label: "Documento" },
    { id: "confira_dados", label: "Confira dados" },
    { id: "endereco", label: "Endereço" },
    { id: "viagem", label: "Viagem" },
    { id: "hospedes_menores", label: "Hóspedes" },
    { id: "revisao", label: "Revisão" },
    { id: "aceite", label: "Aceite" },
    { id: "concluido", label: "Concluído" },
  ];

  var DOC_TYPES = [
    { value: "cpf", label: "Brasileiro — CPF" },
    { value: "passport", label: "Estrangeiro — Passaporte" },
  ];

  var MOTIVO_OPTIONS = [
    { value: "lazer", label: "Lazer / turismo" },
    { value: "negocios", label: "Negócios" },
    { value: "evento", label: "Evento" },
    { value: "saude", label: "Saúde" },
    { value: "estudo", label: "Estudo" },
    { value: "outro", label: "Outro" },
  ];

  var TRANSPORTE_OPTIONS = [
    { value: "carro", label: "Carro" },
    { value: "aviao", label: "Avião" },
    { value: "onibus", label: "Ônibus" },
    { value: "outro", label: "Outro" },
  ];

  var RELATION_OPTIONS = [
    { value: "pai", label: "Pai" },
    { value: "mae", label: "Mãe" },
    { value: "tutor_responsavel_legal", label: "Tutor / responsável legal" },
    { value: "outro", label: "Outro" },
  ];

  var ACCOMPANIMENT_OPTIONS = [
    { value: "acompanhado_por_pai_mae", label: "Acompanho como pai/mãe" },
    { value: "acompanhado_por_responsavel_legal", label: "Acompanho como responsável legal" },
    { value: "acompanhado_por_terceiro_autorizado", label: "Terceiro autorizado" },
  ];

  function escapeHtml(s) {
    var div = document.createElement("div");
    div.textContent = s == null ? "" : String(s);
    return div.innerHTML;
  }

  function formatTime(d) {
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  function digitsOnly(v) {
    return String(v || "").replace(/\D/g, "");
  }

  function hasText(v) {
    return v != null && String(v).trim() !== "";
  }

  function isBrazilResident(state) {
    var pais = String(state.pais || "Brasil").trim().toLowerCase();
    if (!pais || pais === "brasil" || pais === "brazil" || pais === "br") return true;
    var nac = String(state.nacionalidade || "").trim().toLowerCase();
    if (nac.indexOf("brasil") >= 0 || nac === "brasileira" || nac === "brasileiro") {
      return !hasText(state.endereco_estrangeiro);
    }
    return false;
  }

  function needsTwoSides(docType) {
    // Jornada canônica: CPF / passaporte (documento físico CNH/RG é só fonte).
    // Mantido por compatibilidade; não é o caminho normal document-first.
    return docType === "rg" || docType === "cnh";
  }

  function isCanonicalDocType(docType) {
    return docType === "cpf" || docType === "passport";
  }

  function normalizeDocumentoTipo(raw) {
    var t = String(raw || "").trim().toLowerCase();
    if (isCanonicalDocType(t)) return t;
    return "";
  }

  function documentoNumeroLabel(docType) {
    if (docType === "passport") return "Passaporte *";
    if (docType === "cpf") return "CPF *";
    return "Número do documento *";
  }

  function labelOf(options, value) {
    for (var i = 0; i < options.length; i++) {
      if (options[i].value === value) return options[i].label;
    }
    return value || "—";
  }

  function optionHtml(options, selected) {
    return options
      .map(function (o) {
        return (
          '<option value="' +
          escapeHtml(o.value) +
          '"' +
          (o.value === selected ? " selected" : "") +
          ">" +
          escapeHtml(o.label) +
          "</option>"
        );
      })
      .join("");
  }

  /**
   * @param {{
   *   appEl: HTMLElement,
   *   guestId: string,
   *   token: string,
   *   functionsUrl: string,
   *   data: object
   * }} opts
   */
  function start(opts) {
    var app = opts.appEl;
    var guestId = opts.guestId;
    var token = opts.token;
    var functionsUrl = opts.functionsUrl;
    var data = opts.data || {};

    if (data.is_minor) {
      app.innerHTML =
        "<h1>Check-in digital</h1>" +
        '<p class="banner">A ficha de menores é preenchida e confirmada pelo <strong>responsável</strong> pelo link dele. ' +
        "Use o link enviado ao adulto responsável desta reserva.</p>";
      return;
    }

    var pre = data.preenchido || {};
    var minors = Array.isArray(data.minors)
      ? data.minors
      : Array.isArray(data.menores)
        ? data.menores
        : [];
    var documents = Array.isArray(data.documents) ? data.documents : [];
    var termsVersion = data.terms_version || "terms-v1-2026-08";
    var privacyVersion = data.privacy_notice_version || "privacy-v1-2026-08";
    var meta = data.meta || {};
    var flags = data.feature_flags || {};

    var state = {
      stepIndex: 0,
      documento_tipo: normalizeDocumentoTipo(pre.documento_tipo),
      documento_numero: pre.documento_numero || pre.documento || "",
      documento: pre.documento || pre.documento_numero || "",
      data_nascimento: pre.data_nascimento ? String(pre.data_nascimento).slice(0, 10) : "",
      hospede_nome: pre.hospede_nome || "",
      nome_social: pre.nome_social || "",
      nacionalidade: pre.nacionalidade || "",
      telefone: pre.telefone || "",
      email: pre.email || "",
      cep: pre.cep || "",
      logradouro: pre.logradouro || "",
      numero: pre.numero || "",
      complemento: pre.complemento || "",
      bairro: pre.bairro || "",
      cidade: pre.cidade || "",
      uf: pre.uf || "",
      pais: pre.pais || "Brasil",
      endereco_estrangeiro: pre.endereco_estrangeiro || "",
      endereco: pre.endereco || "",
      procedencia: pre.procedencia || "",
      destino: pre.destino || "",
      motivo_viagem: pre.motivo_viagem || "",
      meio_transporte: pre.meio_transporte || "",
      placa_veiculo: pre.placa_veiculo || "",
      cor_veiculo: pre.cor_veiculo || "",
      modelo_veiculo: pre.modelo_veiculo || "",
      // Aceite nunca inicia marcado na UI
      data_confirmed: false,
      privacy_accepted: false,
      has_document_upload: documents.some(function (d) {
        return d && d.storage_ref_present;
      }),
      uploadedSides: {},
      minors: minors.map(function (m) {
        return {
          guest_id: m.guest_id || m.id || "",
          nome: m.nome || "",
          data_nascimento: m.data_nascimento ? String(m.data_nascimento).slice(0, 10) : "",
          minor_relation: m.minor_relation || "",
          minor_relation_other: m.minor_relation_other || "",
          minor_accompaniment: m.minor_accompaniment || "",
          nacionalidade: m.nacionalidade || "",
          documento_tipo: normalizeDocumentoTipo(m.documento_tipo),
          documento_numero: m.documento_numero || "",
          status: m.status || "",
        };
      }),
      analyzing: false,
      analyzingPhase: "",
      cepLoading: false,
      cepError: "",
      stepError: "",
      ocrBanner: "",
      fieldOrigin: Object.assign({}, data.field_provenance || {}),
      dirtyManualFields: {},
      reviewFields: {},
      docPreviewUrl: "",
      docPreviewName: "",
      showConfiraCta: false,
      draftStatus: "",
      draftOk: null,
      confirmBusy: false,
    };

    // Marca lados já enviados (heurística: qualquer doc do tipo)
    if (state.has_document_upload) {
      state.uploadedSides.single = true;
    }

    var draftTimer = null;
    var draftAbort = null;

    function submitUrl() {
      return functionsUrl + "/fnrh-submit";
    }
    function uploadUrl() {
      return functionsUrl + "/fnrh-document-upload";
    }

    function collectDraftBody() {
      var body = {
        hospede_id: guestId,
        guest_id: guestId,
        token: token,
        action: "draft",
        flow_version: "v2",
        hospede_nome: state.hospede_nome,
        nome_social: state.nome_social,
        documento_tipo: state.documento_tipo,
        documento_numero: state.documento_numero,
        documento: state.documento_numero || state.documento,
        data_nascimento: state.data_nascimento || null,
        nacionalidade: state.nacionalidade,
        cep: state.cep,
        logradouro: state.logradouro,
        numero: state.numero,
        complemento: state.complemento,
        bairro: state.bairro,
        cidade: state.cidade,
        uf: state.uf,
        pais: state.pais,
        endereco_estrangeiro: state.endereco_estrangeiro,
        telefone: state.telefone,
        email: state.email,
        procedencia: state.procedencia,
        destino: state.destino,
        motivo_viagem: state.motivo_viagem,
        meio_transporte: state.meio_transporte,
        placa_veiculo: state.placa_veiculo,
        cor_veiculo: state.cor_veiculo,
        modelo_veiculo: state.modelo_veiculo,
        terms_version: termsVersion,
        privacy_notice_version: privacyVersion,
        // Não persistir aceite como true via autosave até o usuário marcar na etapa
        data_confirmed: false,
        privacy_accepted: false,
        dirty_manual_fields: Object.keys(state.dirtyManualFields || {}),
      };
      return body;
    }

    function doDraft() {
      if (draftAbort) draftAbort.abort();
      draftAbort = new AbortController();
      fetch(submitUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collectDraftBody()),
        signal: draftAbort.signal,
      })
        .then(function (r) {
          return r.json();
        })
        .then(function (res) {
          if (res.ok) {
            state.draftStatus = "Rascunho salvo às " + formatTime(new Date()) + ".";
            state.draftOk = true;
          } else {
            state.draftStatus = res.error || "Não foi possível salvar o rascunho.";
            state.draftOk = false;
          }
          updateDraftStatusEl();
        })
        .catch(function (e) {
          if (e && e.name === "AbortError") return;
          state.draftStatus = "Erro de rede ao salvar rascunho.";
          state.draftOk = false;
          updateDraftStatusEl();
        });
    }

    function scheduleDraft() {
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = setTimeout(doDraft, DEBOUNCE_MS);
    }

    function updateDraftStatusEl() {
      var el = document.getElementById("v2-draft-status");
      if (!el) return;
      el.textContent = state.draftStatus || "";
      el.className =
        "draft-status" +
        (state.draftOk === true ? " is-ok" : state.draftOk === false ? " is-err" : " muted");
    }

    function markDirtyManual(key) {
      if (!key) return;
      state.dirtyManualFields = state.dirtyManualFields || {};
      state.dirtyManualFields[key] = true;
      state.fieldOrigin = state.fieldOrigin || {};
      state.fieldOrigin[key] = "manual";
    }

    function syncStateFromDom() {
      var root = document.getElementById("v2-step-body");
      if (!root) return;
      root.querySelectorAll("[data-field]").forEach(function (el) {
        var key = el.getAttribute("data-field");
        if (!key) return;
        var nextVal = el.type === "checkbox" ? !!el.checked : el.value;
        var prevVal = state[key];
        if (el.type === "checkbox") {
          state[key] = nextVal;
        } else {
          if (key === "documento_tipo") {
            nextVal = normalizeDocumentoTipo(nextVal);
          }
          state[key] = nextVal;
        }
        if (String(prevVal == null ? "" : prevVal) !== String(nextVal == null ? "" : nextVal)) {
          markDirtyManual(key);
        }
      });
      root.querySelectorAll("[data-minor-field]").forEach(function (el) {
        var idx = parseInt(el.getAttribute("data-minor-index"), 10);
        var key = el.getAttribute("data-minor-field");
        if (isNaN(idx) || !state.minors[idx] || !key) return;
        state.minors[idx][key] = el.value;
      });
    }

    function hasLinkedMinors() {
      return Array.isArray(state.minors) && state.minors.length > 0;
    }

    /** Etapas exibidas na jornada (pula Hóspedes se não houver menores). */
    function isStepVisible(stepId) {
      if (stepId === "hospedes_menores" && !hasLinkedMinors()) return false;
      return true;
    }

    function visibleSteps() {
      return STEPS.filter(function (s) {
        return isStepVisible(s.id);
      });
    }

    function visibleStepMeta() {
      var vis = visibleSteps();
      var currentId = STEPS[state.stepIndex] ? STEPS[state.stepIndex].id : "";
      var visualIndex = 0;
      for (var i = 0; i < vis.length; i++) {
        if (vis[i].id === currentId) {
          visualIndex = i;
          break;
        }
      }
      return { steps: vis, visualIndex: visualIndex, total: vis.length };
    }

    /** Avança/volta no índice lógico STEPS, pulando etapas invisíveis. */
    function nextVisibleStepIndex(fromIndex, direction) {
      var i = fromIndex + direction;
      while (i >= 0 && i < STEPS.length) {
        if (isStepVisible(STEPS[i].id)) return i;
        i += direction;
      }
      return fromIndex;
    }

    /** Evita stepIndex em etapa pulada (reload / navegação). */
    function ensureVisibleStepIndex() {
      if (!STEPS[state.stepIndex]) {
        state.stepIndex = 0;
        return;
      }
      if (isStepVisible(STEPS[state.stepIndex].id)) return;
      var forward = nextVisibleStepIndex(state.stepIndex, 1);
      if (forward !== state.stepIndex && isStepVisible(STEPS[forward].id)) {
        state.stepIndex = forward;
        return;
      }
      var backward = nextVisibleStepIndex(state.stepIndex, -1);
      if (backward !== state.stepIndex && isStepVisible(STEPS[backward].id)) {
        state.stepIndex = backward;
        return;
      }
      state.stepIndex = 0;
    }

    function documentUploadComplete() {
      if (!state.has_document_upload) return false;
      if (needsTwoSides(state.documento_tipo)) {
        return !!(state.uploadedSides.front && state.uploadedSides.back);
      }
      return !!(state.uploadedSides.single || state.uploadedSides.front || state.has_document_upload);
    }

    function needsVersoAfterOcr() {
      return needsTwoSides(state.documento_tipo) && !!state.uploadedSides.front && !state.uploadedSides.back;
    }

    function validateCurrentStep() {
      var id = STEPS[state.stepIndex].id;
      state.stepError = "";

      if (id === "documento") {
        if (!state.has_document_upload) {
          state.stepError = "Envie uma foto ou arquivo do documento para continuar.";
          return false;
        }
        if (needsVersoAfterOcr()) {
          state.stepError = "Este documento precisa da foto do verso. Envie o verso para continuar.";
          return false;
        }
        return true;
      }

      if (id === "confira_dados") {
        if (!hasText(state.hospede_nome)) {
          state.stepError = "Nome completo é obrigatório.";
          return false;
        }
        if (!hasText(state.documento_tipo)) {
          state.stepError = "Selecione o tipo de documento.";
          return false;
        }
        if (!hasText(state.documento_numero)) {
          state.stepError = "Informe o número do documento.";
          return false;
        }
        if (!hasText(state.data_nascimento)) {
          state.stepError = "Data de nascimento é obrigatória.";
          return false;
        }
        if (!hasText(state.nacionalidade)) {
          state.stepError = "Nacionalidade é obrigatória.";
          return false;
        }
        if (!hasText(state.telefone)) {
          state.stepError = "Telefone é obrigatório.";
          return false;
        }
        if (!hasText(state.email)) {
          state.stepError = "E-mail é obrigatório.";
          return false;
        }
        if (needsTwoSides(state.documento_tipo) && !(state.uploadedSides.front && state.uploadedSides.back)) {
          state.stepError =
            "Este documento exige frente e verso. Volte à etapa Documento e envie o verso.";
          return false;
        }
        return true;
      }

      if (id === "endereco") {
        if (isBrazilResident(state)) {
          if (digitsOnly(state.cep).length !== 8) {
            state.stepError = "Informe um CEP válido com 8 dígitos.";
            return false;
          }
          if (
            !hasText(state.logradouro) ||
            !hasText(state.numero) ||
            !hasText(state.bairro) ||
            !hasText(state.cidade) ||
            String(state.uf || "").trim().length !== 2
          ) {
            state.stepError = "Complete logradouro, número, bairro, cidade e UF.";
            return false;
          }
        } else if (!hasText(state.endereco_estrangeiro)) {
          state.stepError = "Informe o endereço completo no exterior.";
          return false;
        }
        return true;
      }

      if (id === "viagem") {
        if (!hasText(state.motivo_viagem)) {
          state.stepError = "Selecione o motivo da viagem.";
          return false;
        }
        if (!hasText(state.meio_transporte)) {
          state.stepError = "Selecione o meio de transporte.";
          return false;
        }
        if (!hasText(state.procedencia)) {
          state.stepError = "Informe a procedência.";
          return false;
        }
        if (!hasText(state.destino)) {
          state.stepError = "Informe o destino.";
          return false;
        }
        var meio = String(state.meio_transporte).toLowerCase();
        if ((meio === "carro" || meio === "automovel" || meio === "veiculo") && !hasText(state.placa_veiculo)) {
          state.stepError = "Informe a placa do veículo.";
          return false;
        }
        return true;
      }

      if (id === "hospedes_menores") {
        for (var i = 0; i < state.minors.length; i++) {
          var m = state.minors[i];
          if (!hasText(m.minor_relation)) {
            state.stepError = "Informe o parentesco de cada menor.";
            return false;
          }
          if (m.minor_relation === "outro" && !hasText(m.minor_relation_other)) {
            state.stepError = "Descreva o parentesco (outro) do menor.";
            return false;
          }
          if (!hasText(m.minor_accompaniment)) {
            state.stepError = "Informe como o menor está acompanhado.";
            return false;
          }
        }
        return true;
      }

      if (id === "aceite") {
        if (!state.data_confirmed || !state.privacy_accepted) {
          state.stepError = "Marque as duas declarações para concluir.";
          return false;
        }
        return true;
      }

      return true;
    }

    function goNext() {
      syncStateFromDom();
      if (!validateCurrentStep()) {
        render();
        return;
      }
      var stepId = STEPS[state.stepIndex].id;
      if (stepId === "aceite") {
        confirmAndFinish();
        return;
      }
      if (stepId === "concluido") return;
      scheduleDraft();
      state.stepIndex = nextVisibleStepIndex(state.stepIndex, 1);
      state.stepError = "";
      render();
    }

    function goBack() {
      syncStateFromDom();
      if (state.stepIndex > 0 && STEPS[state.stepIndex].id !== "concluido") {
        state.stepIndex = nextVisibleStepIndex(state.stepIndex, -1);
        state.stepError = "";
        render();
      }
    }

    function applyOcrSuggestions(fields, meta) {
      if (!fields || typeof fields !== "object") return;
      meta = meta || {};
      var review = Array.isArray(meta.needs_review_fields) ? meta.needs_review_fields : [];
      var map = {
        hospede_nome: "hospede_nome",
        nome: "hospede_nome",
        data_nascimento: "data_nascimento",
        documento_numero: "documento_numero",
        documento: "documento_numero",
        documento_tipo: "documento_tipo",
        nacionalidade: "nacionalidade",
        sexo: "sexo",
        cpf: "documento_numero",
      };
      var applied = 0;
      Object.keys(map).forEach(function (k) {
        var target = map[k];
        if (!hasText(fields[k])) return;
        state.fieldOrigin = state.fieldOrigin || {};
        // manual > ocr: só bloqueia se o hóspede já preencheu valor canônico
        if (state.fieldOrigin[target] === "manual" && hasText(state[target])) {
          if (!(target === "documento_tipo" && !isCanonicalDocType(state[target]))) {
            return;
          }
        }
        var val = String(fields[k]).trim();
        if (target === "documento_tipo") {
          val = normalizeDocumentoTipo(val);
          if (!val) return;
        }
        if (k === "cpf") {
          // CPF canônico: tipo + número
          if (state.fieldOrigin.documento_tipo !== "manual") {
            state.documento_tipo = "cpf";
            state.fieldOrigin.documento_tipo = "ocr";
          }
          val = val.replace(/\D/g, "");
        }
        if (target === "data_nascimento") val = val.slice(0, 10);
        state[target] = val;
        if (target === "documento_numero") state.documento = val;
        state.fieldOrigin[target] = "ocr";
        if (review.indexOf(k) >= 0 || review.indexOf(target) >= 0) {
          state.reviewFields = state.reviewFields || {};
          state.reviewFields[target] = true;
        }
        applied += 1;
      });
      if (applied > 0) {
        state.ocrBanner =
          "Encontramos estes dados no seu documento. Confira e corrija se necessário.";
      } else {
        state.ocrBanner =
          "Alguns dados não foram identificados. Confira e complete os campos abaixo.";
      }
    }

    function setDocPreview(file) {
      if (state.docPreviewUrl) {
        try {
          URL.revokeObjectURL(state.docPreviewUrl);
        } catch (_e) {
          /* ignore */
        }
      }
      state.docPreviewUrl = "";
      state.docPreviewName = file && file.name ? String(file.name) : "";
      if (file && file.type && String(file.type).indexOf("image/") === 0) {
        try {
          state.docPreviewUrl = URL.createObjectURL(file);
        } catch (_e2) {
          state.docPreviewUrl = "";
        }
      }
    }

    function uploadDocument(file, side) {
      if (!file) return;
      var uploadSide = side || "front";
      setDocPreview(file);
      state.analyzing = true;
      state.analyzingPhase = "upload";
      state.stepError = "";
      state.ocrBanner = "";
      state.showConfiraCta = false;
      render();

      var fd = new FormData();
      fd.append("guest_id", guestId);
      fd.append("token", token);
      fd.append("document_type", state.documento_tipo || "other");
      fd.append("document_subject", "guest");
      fd.append("side", uploadSide);
      fd.append("file", file, file.name || "documento");

      // Transição visual: após iniciar o POST, mostrar fase OCR (re-render para botão + preview)
      window.setTimeout(function () {
        if (state.analyzing && state.analyzingPhase === "upload") {
          state.analyzingPhase = "ocr";
          render();
        }
      }, 450);

      fetch(uploadUrl(), { method: "POST", body: fd })
        .then(function (r) {
          return r.json().then(function (j) {
            return { okHttp: r.ok, body: j };
          });
        })
        .then(function (res) {
          state.analyzing = false;
          state.analyzingPhase = "";
          if (!res.body || !res.body.ok) {
            state.stepError = (res.body && res.body.error) || "Falha no envio do documento.";
            render();
            return;
          }
          state.has_document_upload = true;
          state.uploadedSides[uploadSide] = true;
          if (uploadSide === "single") state.uploadedSides.front = true;
          applyOcrSuggestions(res.body.suggested_fields, {
            needs_review_fields: res.body.needs_review_fields,
            ocr_skipped: res.body.ocr_skipped,
            ocr_reason: res.body.ocr_reason,
            ok: res.body.ok,
          });
          if (!needsVersoAfterOcr()) {
            state.showConfiraCta = true;
          }
          scheduleDraft();
          render();
        })
        .catch(function () {
          state.analyzing = false;
          state.analyzingPhase = "";
          state.stepError = "Erro de conexão ao enviar o documento.";
          render();
        });
    }

    function lookupCep() {
      var cep = digitsOnly(state.cep);
      if (cep.length !== 8) {
        state.cepError = "CEP deve ter 8 dígitos.";
        render();
        return;
      }
      state.cepLoading = true;
      state.cepError = "";
      render();
      fetch("https://viacep.com.br/ws/" + cep + "/json/")
        .then(function (r) {
          return r.json();
        })
        .then(function (j) {
          state.cepLoading = false;
          if (j.erro) {
            state.cepError = "CEP não encontrado.";
            render();
            return;
          }
          state.logradouro = j.logradouro || state.logradouro;
          state.bairro = j.bairro || state.bairro;
          state.cidade = j.localidade || state.cidade;
          state.uf = j.uf || state.uf;
          state.pais = "Brasil";
          state.endereco_estrangeiro = "";
          markDirtyManual("cep");
          markDirtyManual("logradouro");
          markDirtyManual("bairro");
          markDirtyManual("cidade");
          markDirtyManual("uf");
          markDirtyManual("pais");
          scheduleDraft();
          render();
        })
        .catch(function () {
          state.cepLoading = false;
          state.cepError = "Não foi possível consultar o CEP.";
          render();
        });
    }

    function confirmAndFinish() {
      syncStateFromDom();
      if (!validateCurrentStep()) {
        render();
        return;
      }
      state.confirmBusy = true;
      state.stepError = "";
      render();

      var body = {
        hospede_id: guestId,
        guest_id: guestId,
        token: token,
        action: "confirm",
        flow_version: "v2",
        confirm_own: true,
        hospede_nome: state.hospede_nome,
        nome_social: state.nome_social,
        documento_tipo: state.documento_tipo,
        documento_numero: state.documento_numero,
        documento: state.documento_numero || state.documento,
        data_nascimento: state.data_nascimento || null,
        nacionalidade: state.nacionalidade,
        cep: state.cep,
        logradouro: state.logradouro,
        numero: state.numero,
        complemento: state.complemento,
        bairro: state.bairro,
        cidade: state.cidade,
        uf: state.uf,
        pais: state.pais,
        endereco_estrangeiro: state.endereco_estrangeiro,
        telefone: state.telefone,
        email: state.email,
        procedencia: state.procedencia,
        destino: state.destino,
        motivo_viagem: state.motivo_viagem,
        meio_transporte: state.meio_transporte,
        placa_veiculo: state.placa_veiculo,
        cor_veiculo: state.cor_veiculo,
        modelo_veiculo: state.modelo_veiculo,
        data_confirmed: true,
        privacy_accepted: true,
        terms_version: termsVersion,
        privacy_notice_version: privacyVersion,
        confirm_minors: state.minors.map(function (m) {
          return {
            guest_id: m.guest_id,
            hospede_nome: m.nome,
            data_nascimento: m.data_nascimento || null,
            nacionalidade: m.nacionalidade || state.nacionalidade,
            documento_tipo: m.documento_tipo || "",
            documento_numero: m.documento_numero || "",
            minor_relation: m.minor_relation,
            minor_relation_other: m.minor_relation_other,
            minor_accompaniment: m.minor_accompaniment,
            data_confirmed: true,
            privacy_accepted: true,
            terms_version: termsVersion,
            privacy_notice_version: privacyVersion,
          };
        }),
      };

      fetch(submitUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(function (r) {
          return r.json();
        })
        .then(function (res) {
          state.confirmBusy = false;
          if (res.ok) {
            state.stepIndex = STEPS.length - 1;
            state.stepError = "";
            render();
          } else {
            var detail = "";
            if (res.details && Array.isArray(res.details.missing) && res.details.missing.length) {
              detail = " Faltando: " + res.details.missing.join(", ") + ".";
            }
            state.stepError = (res.error || "Falha ao confirmar.") + detail;
            render();
          }
        })
        .catch(function () {
          state.confirmBusy = false;
          state.stepError = "Erro de conexão. Tente novamente.";
          render();
        });
    }

    function progressPct() {
      // concluído = 100%; demais etapas proporcionais às etapas VISÍVEIS
      ensureVisibleStepIndex();
      var meta = visibleStepMeta();
      if (STEPS[state.stepIndex].id === "concluido") return 100;
      var denom = Math.max(1, meta.total - 1);
      return Math.round(((meta.visualIndex + 1) / denom) * 100);
    }

    function renderShell(bodyHtml, navOpts) {
      navOpts = navOpts || {};
      ensureVisibleStepIndex();
      var stepMeta = visibleStepMeta();
      var apt =
        meta.apartamento
          ? '<p class="muted meta-line">Apartamento ' + escapeHtml(meta.apartamento) + "</p>"
          : "";
      var step = STEPS[state.stepIndex];
      // Feedback de processamento fica no card do documento (próximo ao preview no mobile).
      // Na Etapa 2 o banner OCR fica só dentro de renderConfiraDados (evita duplicata).
      var ocrBanner =
        state.ocrBanner && !state.analyzing && step.id !== "confira_dados"
          ? '<div class="banner" role="status">' + escapeHtml(state.ocrBanner) + "</div>"
          : "";
      var err = state.stepError
        ? '<p class="error" id="v2-step-error">' + escapeHtml(state.stepError) + "</p>"
        : "";

      var backBtn =
        navOpts.hideBack || state.stepIndex === 0 || step.id === "concluido"
          ? ""
          : '<button type="button" class="btn secondary" id="v2-back">Voltar</button>';
      var nextLabel = "Continuar";
      if (step.id === "aceite") {
        nextLabel = state.confirmBusy ? "Confirmando…" : "Confirmar check-in";
      } else if (state.analyzing) {
        nextLabel =
          state.analyzingPhase === "ocr" ? "Lendo documento…" : "Enviando documento…";
      }
      var nextBtn =
        step.id === "concluido"
          ? ""
          : '<button type="button" class="btn primary" id="v2-next"' +
            (state.confirmBusy || state.analyzing ? " disabled" : "") +
            ">" +
            escapeHtml(nextLabel) +
            "</button>";

      var visualNum =
        step.id === "concluido" ? stepMeta.total : stepMeta.visualIndex + 1;

      app.innerHTML = [
        '<div class="v2-wrap">',
        "  <h1>Check-in digital</h1>",
        '  <p class="muted">Yes Hotel · FNRH 2.0</p>',
        apt,
        '  <div class="progress" aria-label="Progresso">',
        '    <div class="progress-bar" style="width:' + progressPct() + '%"></div>',
        "  </div>",
        '  <p class="step-label">Etapa ' +
          visualNum +
          " de " +
          stepMeta.total +
          " · " +
          escapeHtml(step.label) +
          "</p>",
        ocrBanner,
        '  <div id="v2-step-body">' + bodyHtml + "</div>",
        err,
        '  <div class="draft-status muted" id="v2-draft-status" aria-live="polite"></div>',
        '  <div class="nav-row">' + backBtn + nextBtn + "</div>",
        "</div>",
      ].join("");

      updateDraftStatusEl();

      var back = document.getElementById("v2-back");
      if (back) back.addEventListener("click", goBack);
      var next = document.getElementById("v2-next");
      if (next) next.addEventListener("click", goNext);

      var body = document.getElementById("v2-step-body");
      if (body) {
        body.querySelectorAll("[data-field], [data-minor-field]").forEach(function (el) {
          el.addEventListener("input", function () {
            syncStateFromDom();
            if (el.getAttribute("data-field") === "meio_transporte") {
              render();
              return;
            }
            if (el.getAttribute("data-field") === "documento_tipo") {
              render();
              return;
            }
            if (el.getAttribute("data-minor-field") === "minor_relation") {
              render();
              return;
            }
            if (el.getAttribute("data-field") === "pais") {
              render();
              return;
            }
            scheduleDraft();
          });
          el.addEventListener("change", function () {
            syncStateFromDom();
            scheduleDraft();
          });
        });
      }

      bindStepHandlers();
    }

    function bindStepHandlers() {
      var step = STEPS[state.stepIndex].id;

      if (step === "documento") {
        function wireHidden(inputId, side) {
          var input = document.getElementById(inputId);
          if (!input) return;
          input.addEventListener("change", function () {
            if (input.files && input.files[0]) uploadDocument(input.files[0], side);
            input.value = "";
          });
        }
        wireHidden("doc-camera-front", "front");
        wireHidden("doc-file-front", "front");
        wireHidden("doc-camera-back", "back");
        wireHidden("doc-file-back", "back");

        function wireTrigger(btnId, inputId) {
          var btn = document.getElementById(btnId);
          var input = document.getElementById(inputId);
          if (!btn || !input) return;
          btn.addEventListener("click", function () {
            input.click();
          });
        }
        wireTrigger("btn-doc-camera", "doc-camera-front");
        wireTrigger("btn-doc-file", "doc-file-front");
        wireTrigger("btn-doc-camera-back", "doc-camera-back");
        wireTrigger("btn-doc-file-back", "doc-file-back");
        wireTrigger("btn-doc-retake-camera", "doc-camera-front");
        wireTrigger("btn-doc-retake-file", "doc-file-front");

        var confira = document.getElementById("btn-goto-confira");
        if (confira) {
          confira.addEventListener("click", function () {
            goNext();
          });
        }
      }

      if (step === "endereco") {
        var btnCep = document.getElementById("btn-cep");
        if (btnCep) {
          btnCep.addEventListener("click", function () {
            syncStateFromDom();
            lookupCep();
          });
        }
        var cepInput = document.querySelector('[data-field="cep"]');
        if (cepInput) {
          cepInput.addEventListener("blur", function () {
            syncStateFromDom();
            if (digitsOnly(state.cep).length === 8) lookupCep();
          });
        }
      }
    }

    function renderDocumento() {
      var needVerso = needsVersoAfterOcr();
      var hasAny =
        !!(state.has_document_upload || state.uploadedSides.front || state.uploadedSides.single);
      var analyzing = !!state.analyzing;
      var phase = state.analyzingPhase || "";

      var previewChip = "";
      var processStatus = "";
      if (analyzing && phase === "upload") {
        previewChip = '<span class="doc-chip doc-chip--busy">Enviando…</span>';
        processStatus = [
          '<div class="doc-process-status" role="status" aria-live="polite">',
          '  <div class="doc-process-status__row">',
          '    <span class="doc-spinner" aria-hidden="true"></span>',
          '    <span class="doc-process-status__title">Enviando documento…</span>',
          "  </div>",
          '  <p class="doc-process-status__hint">Aguarde um instante.</p>',
          "</div>",
        ].join("");
      } else if (analyzing) {
        previewChip = '<span class="doc-chip doc-chip--busy">Documento recebido · lendo dados…</span>';
        processStatus = [
          '<div class="doc-process-status" role="status" aria-live="polite">',
          '  <div class="doc-process-status__row">',
          '    <span class="doc-spinner" aria-hidden="true"></span>',
          '    <span class="doc-process-status__title">Lendo documento…</span>',
          "  </div>",
          '  <p class="doc-process-status__hint">Estamos identificando seus dados automaticamente. Isso pode levar alguns segundos.</p>',
          "</div>",
        ].join("");
      } else if (hasAny || state.docPreviewUrl || state.docPreviewName) {
        previewChip = '<span class="ok-chip">Documento enviado ✓</span>';
        if (state.showConfiraCta && !needVerso) {
          processStatus = [
            '<div class="doc-process-status doc-process-status--done" role="status" aria-live="polite">',
            '  <p class="doc-process-status__title">Leitura concluída ✓</p>',
            '  <p class="doc-process-status__hint">Confira os dados identificados antes de continuar.</p>',
            "</div>",
          ].join("");
        }
      }

      var previewBlock = "";
      if (state.docPreviewUrl || state.docPreviewName || hasAny || analyzing) {
        previewBlock = [
          '<div class="doc-preview-card">',
          state.docPreviewUrl
            ? '  <img class="doc-preview-img" src="' +
              escapeHtml(state.docPreviewUrl) +
              '" alt="Pré-visualização do documento" />'
            : "",
          '  <div class="doc-preview-meta">',
          previewChip,
          state.docPreviewName
            ? '    <p class="muted doc-preview-name">' + escapeHtml(state.docPreviewName) + "</p>"
            : "",
          "  </div>",
          processStatus,
          analyzing
            ? ""
            : [
                '  <div class="doc-retake-row">',
                '    <button type="button" class="btn secondary compact" id="btn-doc-retake-camera">Tirar outra foto</button>',
                '    <button type="button" class="btn secondary compact" id="btn-doc-retake-file">Trocar arquivo</button>',
                "  </div>",
              ].join(""),
          "</div>",
        ].join("");
      }

      var primaryCapture =
        analyzing
          ? ""
          : needVerso
            ? [
                '<button type="button" class="doc-cta doc-cta--primary" id="btn-doc-camera-back">',
                '  <span class="doc-cta__icon" aria-hidden="true">📷</span>',
                "  <span class=\"doc-cta__title\">Tirar foto do verso</span>",
                '  <span class="doc-cta__hint">Use a câmera do celular</span>',
                "</button>",
                '<button type="button" class="doc-cta doc-cta--secondary" id="btn-doc-file-back">',
                "  <span class=\"doc-cta__title\">Enviar verso do documento</span>",
                '  <span class="doc-cta__hint">Escolha uma imagem ou PDF já salvo</span>',
                "</button>",
              ].join("")
            : [
                '<button type="button" class="doc-cta doc-cta--primary" id="btn-doc-camera">',
                '  <span class="doc-cta__icon" aria-hidden="true">📷</span>',
                "  <span class=\"doc-cta__title\">Tirar foto do documento</span>",
                '  <span class="doc-cta__hint">Use a câmera do celular</span>',
                "</button>",
                '<button type="button" class="doc-cta doc-cta--secondary" id="btn-doc-file">',
                "  <span class=\"doc-cta__title\">Enviar foto ou arquivo</span>",
                '  <span class="doc-cta__hint">Escolha uma imagem ou PDF já salvo no aparelho</span>',
                "</button>",
              ].join("");

      var confiraCta =
        state.showConfiraCta && !needVerso && !analyzing
          ? '<button type="button" class="btn primary doc-confira-cta" id="btn-goto-confira">Conferir meus dados</button>'
          : "";

      return [
        '<p class="banner">Tire uma foto legível do seu documento. Vamos ler os dados automaticamente para agilizar seu check-in.</p>',
        // Inputs ocultos: câmera (capture) e arquivo (sem capture)
        '<input type="file" id="doc-camera-front" class="sr-only-file" accept="image/*" capture="environment" tabindex="-1" aria-hidden="true" />',
        '<input type="file" id="doc-file-front" class="sr-only-file" accept="image/*,application/pdf" tabindex="-1" aria-hidden="true" />',
        '<input type="file" id="doc-camera-back" class="sr-only-file" accept="image/*" capture="environment" tabindex="-1" aria-hidden="true" />',
        '<input type="file" id="doc-file-back" class="sr-only-file" accept="image/*,application/pdf" tabindex="-1" aria-hidden="true" />',
        previewBlock,
        needVerso && !analyzing
          ? '<p class="banner">Identificamos um documento que precisa do <strong>verso</strong>. Envie a segunda foto.</p>'
          : "",
        primaryCapture ? '<div class="doc-cta-stack">' + primaryCapture + "</div>" : "",
        confiraCta,
      ].join("");
    }

    function renderConfiraDados() {
      var bannerText =
        state.ocrBanner ||
        "Alguns dados não foram identificados. Confira e complete os campos abaixo.";
      var numLabel = documentoNumeroLabel(state.documento_tipo);
      return [
        // Banner único: só aqui na Etapa 2 (shell não duplica ocrBanner nesta etapa)
        '<p class="banner" role="status">' + escapeHtml(bannerText) + "</p>",
        "<label>Nome completo *</label>",
        '<input data-field="hospede_nome" autocomplete="name" value="' +
          escapeHtml(state.hospede_nome) +
          '" />',
        "<label>Nome social (opcional)</label>",
        '<input data-field="nome_social" value="' + escapeHtml(state.nome_social) + '" />',
        "<label>Identificação *</label>",
        '<select data-field="documento_tipo">',
        '<option value="">Selecione…</option>',
        optionHtml(DOC_TYPES, state.documento_tipo),
        "</select>",
        "<label>" + escapeHtml(numLabel) + "</label>",
        '<input data-field="documento_numero" inputmode="' +
          (state.documento_tipo === "cpf" ? "numeric" : "text") +
          '" autocomplete="off" value="' +
          escapeHtml(state.documento_numero) +
          '" />',
        "<label>Data de nascimento *</label>",
        '<input data-field="data_nascimento" type="date" value="' +
          escapeHtml(state.data_nascimento) +
          '" />',
        "<label>Nacionalidade *</label>",
        '<input data-field="nacionalidade" placeholder="ex.: Brasileira" value="' +
          escapeHtml(state.nacionalidade) +
          '" />',
        "<label>Telefone *</label>",
        '<input data-field="telefone" type="tel" autocomplete="tel" placeholder="(00) 00000-0000" value="' +
          escapeHtml(state.telefone) +
          '" />',
        "<label>E-mail *</label>",
        '<input data-field="email" type="email" autocomplete="email" value="' +
          escapeHtml(state.email) +
          '" />',
      ].join("");
    }

    function renderEndereco() {
      var br = isBrazilResident(state);
      var foreignToggle =
        '<label class="check-inline">' +
        '<input type="checkbox" id="toggle-foreign"' +
        (!br ? " checked" : "") +
        " /> Resido fora do Brasil / sem CEP brasileiro" +
        "</label>";

      var brBlock = [
        "<label>CEP *</label>",
        '<div class="cep-row">',
        '  <input data-field="cep" inputmode="numeric" maxlength="9" placeholder="00000-000" value="' +
          escapeHtml(state.cep) +
          '" />',
        '  <button type="button" class="btn secondary compact" id="btn-cep"' +
          (state.cepLoading ? " disabled" : "") +
          ">" +
          (state.cepLoading ? "…" : "Buscar") +
          "</button>",
        "</div>",
        state.cepError ? '<p class="error">' + escapeHtml(state.cepError) + "</p>" : "",
        "<label>Logradouro *</label>",
        '<input data-field="logradouro" value="' + escapeHtml(state.logradouro) + '" />',
        "<label>Número *</label>",
        '<input data-field="numero" value="' + escapeHtml(state.numero) + '" />',
        "<label>Complemento</label>",
        '<input data-field="complemento" value="' + escapeHtml(state.complemento) + '" />',
        "<label>Bairro *</label>",
        '<input data-field="bairro" value="' + escapeHtml(state.bairro) + '" />',
        "<label>Cidade *</label>",
        '<input data-field="cidade" value="' + escapeHtml(state.cidade) + '" />',
        "<label>UF *</label>",
        '<input data-field="uf" maxlength="2" placeholder="MS" value="' +
          escapeHtml(state.uf) +
          '" />',
        '<input type="hidden" data-field="pais" value="Brasil" />',
      ].join("");

      var foreignBlock = [
        '<input type="hidden" data-field="pais" value="' +
          escapeHtml(state.pais && state.pais !== "Brasil" ? state.pais : "Exterior") +
          '" />',
        "<label>Endereço completo no exterior *</label>",
        '<textarea data-field="endereco_estrangeiro" rows="4" placeholder="Rua, número, cidade, país">' +
          escapeHtml(state.endereco_estrangeiro) +
          "</textarea>",
      ].join("");

      var html = [
        '<p class="banner">Endereço residencial. No Brasil, comece pelo CEP.</p>',
        foreignToggle,
        br ? brBlock : foreignBlock,
      ].join("");

      // bind toggle after renderShell — use setTimeout microtask via bindStepHandlers extension
      setTimeout(function () {
        var t = document.getElementById("toggle-foreign");
        if (!t) return;
        t.addEventListener("change", function () {
          if (t.checked) {
            state.pais = "Exterior";
            state.cep = "";
          } else {
            state.pais = "Brasil";
            state.endereco_estrangeiro = "";
          }
          render();
        });
      }, 0);

      return html;
    }

    function renderViagem() {
      var isCar = String(state.meio_transporte || "").toLowerCase() === "carro";
      var vehicle = "";
      if (isCar) {
        vehicle = [
          "<label>Placa do veículo *</label>",
          '<input data-field="placa_veiculo" placeholder="ABC1D23" value="' +
            escapeHtml(state.placa_veiculo) +
            '" />',
          "<label>Cor do veículo</label>",
          '<input data-field="cor_veiculo" value="' + escapeHtml(state.cor_veiculo) + '" />',
          "<label>Modelo do veículo</label>",
          '<input data-field="modelo_veiculo" value="' + escapeHtml(state.modelo_veiculo) + '" />',
        ].join("");
      }
      return [
        "<label>Motivo da viagem *</label>",
        '<select data-field="motivo_viagem">',
        '<option value="">Selecione…</option>',
        optionHtml(MOTIVO_OPTIONS, state.motivo_viagem),
        "</select>",
        "<label>Meio de transporte *</label>",
        '<select data-field="meio_transporte">',
        '<option value="">Selecione…</option>',
        optionHtml(TRANSPORTE_OPTIONS, state.meio_transporte),
        "</select>",
        vehicle,
        "<label>Procedência (de onde vem) *</label>",
        '<input data-field="procedencia" value="' + escapeHtml(state.procedencia) + '" />',
        "<label>Destino (para onde segue) *</label>",
        '<input data-field="destino" value="' + escapeHtml(state.destino) + '" />',
      ].join("");
    }

    function renderMenores() {
      if (!state.minors.length) {
        return (
          '<p class="banner">Não há menores vinculados a você nesta reserva. Toque em Continuar.</p>' +
          '<p class="muted">Se houver crianças no grupo, elas devem estar cadastradas com você como responsável.</p>'
        );
      }
      return (
        '<p class="banner">Confirme o parentesco e o acompanhamento de cada menor sob sua responsabilidade.</p>' +
        state.minors
          .map(function (m, idx) {
            var other =
              m.minor_relation === "outro"
                ? "<label>Descreva o parentesco *</label>" +
                  '<input data-minor-field="minor_relation_other" data-minor-index="' +
                  idx +
                  '" value="' +
                  escapeHtml(m.minor_relation_other) +
                  '" />'
                : "";
            return [
              '<div class="minor-card">',
              "  <h2>" + escapeHtml(m.nome || "Menor") + "</h2>",
              m.data_nascimento
                ? '  <p class="muted">Nascimento: ' + escapeHtml(m.data_nascimento) + "</p>"
                : "",
              "  <label>Parentesco *</label>",
              '  <select data-minor-field="minor_relation" data-minor-index="' + idx + '">',
              '  <option value="">Selecione…</option>',
              optionHtml(RELATION_OPTIONS, m.minor_relation),
              "  </select>",
              other,
              "  <label>Acompanhamento *</label>",
              '  <select data-minor-field="minor_accompaniment" data-minor-index="' + idx + '">',
              '  <option value="">Selecione…</option>',
              optionHtml(ACCOMPANIMENT_OPTIONS, m.minor_accompaniment),
              "  </select>",
              "</div>",
            ].join("");
          })
          .join("")
      );
    }

    function renderRevisao() {
      var addr = isBrazilResident(state)
        ? [
            state.logradouro,
            state.numero ? "nº " + state.numero : "",
            state.complemento,
            state.bairro,
            state.cidade,
            state.uf,
            state.cep ? "CEP " + state.cep : "",
          ]
            .filter(Boolean)
            .join(", ")
        : state.endereco_estrangeiro || state.endereco || "—";

      var minorsHtml = state.minors.length
        ? "<dt>Menores</dt><dd>" +
          state.minors
            .map(function (m) {
              return (
                escapeHtml(m.nome || "Menor") +
                " (" +
                escapeHtml(labelOf(RELATION_OPTIONS, m.minor_relation)) +
                ")"
              );
            })
            .join("; ") +
          "</dd>"
        : "";

      return [
        '<p class="banner">Revise tudo antes do aceite final.</p>',
        '<dl class="review">',
        "<dt>Nome</dt><dd>" + escapeHtml(state.hospede_nome) + "</dd>",
        "<dt>Documento</dt><dd>" +
          escapeHtml(labelOf(DOC_TYPES, state.documento_tipo)) +
          " · " +
          escapeHtml(state.documento_numero) +
          "</dd>",
        "<dt>Nascimento</dt><dd>" + escapeHtml(state.data_nascimento || "—") + "</dd>",
        "<dt>Nacionalidade</dt><dd>" + escapeHtml(state.nacionalidade || "—") + "</dd>",
        "<dt>Contato</dt><dd>" +
          escapeHtml(state.telefone) +
          " · " +
          escapeHtml(state.email) +
          "</dd>",
        "<dt>Endereço</dt><dd>" + escapeHtml(addr) + "</dd>",
        "<dt>Viagem</dt><dd>" +
          escapeHtml(labelOf(MOTIVO_OPTIONS, state.motivo_viagem)) +
          " · " +
          escapeHtml(labelOf(TRANSPORTE_OPTIONS, state.meio_transporte)) +
          "</dd>",
        "<dt>Procedência / destino</dt><dd>" +
          escapeHtml(state.procedencia) +
          " → " +
          escapeHtml(state.destino) +
          "</dd>",
        minorsHtml,
        "</dl>",
        '<button type="button" class="btn secondary" id="v2-edit-start">Corrigir desde o início</button>',
      ].join("");
    }

    function renderAceite() {
      return [
        '<p class="banner">Leia e marque as duas declarações. Nenhuma vem pré-marcada.</p>',
        '<label class="check-block">',
        '  <input type="checkbox" data-field="data_confirmed"' +
          (state.data_confirmed ? " checked" : "") +
          " />",
        "  <span>Declaro que os dados informados nesta ficha estão corretos e completos.</span>",
        "</label>",
        '<label class="check-block">',
        '  <input type="checkbox" data-field="privacy_accepted"' +
          (state.privacy_accepted ? " checked" : "") +
          " />",
        "  <span>Li e aceito o aviso de privacidade e o tratamento dos meus dados para fins de hospedagem.</span>",
        "</label>",
        '<p class="muted versions">Versão dos termos: <code>' +
          escapeHtml(termsVersion) +
          "</code><br/>Versão do aviso de privacidade: <code>" +
          escapeHtml(privacyVersion) +
          "</code></p>",
      ].join("");
    }

    function renderConcluido() {
      return [
        '<div class="success-panel">',
        "  <h2>Check-in concluído</h2>",
        "  <p>Sua ficha de registro (FNRH) foi confirmada com sucesso.</p>",
        "  <p>As credenciais de acesso e demais orientações serão enviadas em breve.</p>",
        "  <p>Seja bem-vindo(a) ao Yes Hotel.</p>",
        "</div>",
      ].join("");
    }

    function render() {
      ensureVisibleStepIndex();
      var id = STEPS[state.stepIndex].id;
      var body = "";
      if (id === "documento") body = renderDocumento();
      else if (id === "confira_dados") body = renderConfiraDados();
      else if (id === "endereco") body = renderEndereco();
      else if (id === "viagem") body = renderViagem();
      else if (id === "hospedes_menores") body = renderMenores();
      else if (id === "revisao") body = renderRevisao();
      else if (id === "aceite") body = renderAceite();
      else body = renderConcluido();

      renderShell(body);

      if (id === "revisao") {
        var edit = document.getElementById("v2-edit-start");
        if (edit) {
          edit.addEventListener("click", function () {
            state.stepIndex = 0;
            state.stepError = "";
            render();
          });
        }
      }
    }

    render();
    setTimeout(doDraft, 400);
  }

  global.YesHotelFnrhCheckinV2 = { start: start, STEPS: STEPS };
})(typeof window !== "undefined" ? window : this);
