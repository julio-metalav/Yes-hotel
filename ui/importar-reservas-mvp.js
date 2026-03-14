(function () {
  const auth = window.YesHotelAuthApp;
  const messageEl = document.getElementById("message");
  const jsonInput = document.getElementById("json-input");
  const btnImportar = document.getElementById("btn-importar");

  function showMessage(text, type) {
    if (!messageEl) return;
    messageEl.className = "alert " + (type || "");
    messageEl.textContent = text;
  }

  function reservaToDbRow(r) {
    const checkIn = (r.checkInPrevisto || "").toString().trim().slice(0, 10) || null;
    const checkOut = (r.checkOutPrevisto || "").toString().trim().slice(0, 10) || null;
    return {
      apartamento: (r.apartamento || "").toString().trim() || "",
      hospede_principal: (r.hospedePrincipal || "").toString().trim() || "",
      check_in_previsto: checkIn,
      check_out_previsto: checkOut,
      pagamento_status: r.pagamento === "pago" ? "pago" : "pendente",
      acesso_liberado: !!r.acessoLiberado,
      entrou_no_apto: !!r.entrouNoApto,
      veiculo_placa: (r.veiculoPlaca || "").toString().trim() || "",
      veiculo_cor: (r.veiculoCor || "").toString().trim() || "",
      origem_externa: (r.origemExterna || "manual").toString().trim() || "manual",
      external_reservation_id: r.externalReservationId || null,
    };
  }

  function hospedeToDbRow(h, reservaId) {
    const status = ["nao_identificado", "aguardando_contato", "pronto_para_envio", "enviado", "confirmado"].includes(h.statusOperacional)
      ? h.statusOperacional
      : "nao_identificado";
    const origem = ["existente_completo", "existente_incompleto", "novo", "agencia_sem_dados"].includes(h.origemCadastro)
      ? h.origemCadastro
      : "novo";
    const modo = ["confirmacao_simplificada", "preenchimento_completo"].includes(h.modoColetaFnrh)
      ? h.modoColetaFnrh
      : "preenchimento_completo";
    return {
      reserva_id: reservaId,
      nome: (h.nome || "").toString().trim() || "",
      principal: !!h.principal,
      email: (h.email || "").toString().trim() || "",
      whatsapp: (h.whatsapp || "").toString().trim() || "",
      status_operacional: status,
      origem_cadastro: origem,
      modo_coleta_fnrh: modo,
      ultimo_envio_canal: h.ultimoEnvioCanal || null,
      ultimo_envio_em: h.ultimoEnvioEm || null,
      tentativas_envio: Math.max(0, parseInt(h.tentativasEnvio, 10) || 0),
    };
  }

  async function runImport() {
    messageEl.textContent = "";
    messageEl.className = "";

    if (!auth || !auth.isConfigured()) {
      showMessage("Supabase não configurado. Configure yes-supabase-config.js e use login real.", "error");
      return;
    }

    const user = await auth.getCurrentUser();
    if (!user || user.role !== "admin") {
      showMessage("Acesso negado. Apenas perfil admin pode importar reservas.", "error");
      return;
    }

    const supabase = auth.getSupabaseClient();
    if (!supabase) {
      showMessage("Sessão inválida. Faça login novamente.", "error");
      return;
    }

    let data;
    try {
      const raw = (jsonInput.value || "").trim();
      if (!raw) {
        showMessage("Cole o JSON das reservas no campo acima.", "warn");
        return;
      }
      data = JSON.parse(raw);
    } catch (e) {
      showMessage("JSON inválido: " + (e.message || ""), "error");
      return;
    }

    const list = Array.isArray(data) ? data : (data && data.reservas) ? data.reservas : [];
    if (list.length === 0) {
      showMessage("Nenhuma reserva no JSON. Use um array de reservas.", "warn");
      return;
    }

    btnImportar.disabled = true;
    showMessage("Importando " + list.length + " reserva(s)...", "");

    let inserted = 0;
    let errors = [];

    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r || typeof r !== "object") {
        errors.push("Reserva " + (i + 1) + ": item inválido");
        continue;
      }

      const reservaRow = reservaToDbRow(r);
      const { data: insertedReserva, error: errReserva } = await supabase
        .from("operacional_reservas")
        .insert(reservaRow)
        .select("id")
        .single();

      if (errReserva || !insertedReserva) {
        errors.push("Reserva " + (i + 1) + " (" + (r.apartamento || "?") + "): " + (errReserva?.message || "falha ao inserir"));
        continue;
      }

      const reservaId = insertedReserva.id;
      const hospedes = Array.isArray(r.hospedes) ? r.hospedes : [];
      if (hospedes.length === 0) {
        const { error: errH } = await supabase.from("operacional_hospedes").insert({
          reserva_id: reservaId,
          nome: (r.hospedePrincipal || "").toString().trim() || "Hóspede principal",
          principal: true,
          email: "",
          whatsapp: "",
          status_operacional: "nao_identificado",
          origem_cadastro: "novo",
          modo_coleta_fnrh: "preenchimento_completo",
          tentativas_envio: 0,
        });
        if (errH) errors.push("Reserva " + (i + 1) + ": hóspede padrão - " + errH.message);
      } else {
        for (let j = 0; j < hospedes.length; j++) {
          const hRow = hospedeToDbRow(hospedes[j], reservaId);
          const { error: errH } = await supabase.from("operacional_hospedes").insert(hRow);
          if (errH) errors.push("Reserva " + (i + 1) + " hóspede " + (j + 1) + ": " + errH.message);
        }
      }
      inserted++;
    }

    btnImportar.disabled = false;
    if (errors.length > 0) {
      showMessage(inserted + " reserva(s) importada(s). Erros: " + errors.join("; "), "error");
    } else {
      showMessage(inserted + " reserva(s) importada(s) com sucesso. Atualize o painel de check-in.", "success");
    }
  }

  btnImportar.addEventListener("click", runImport);
})();
