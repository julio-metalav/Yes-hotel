const auth = window.YesHotelAuthApp;
const photoHelper = window.YesHotelDemandasPhoto;
const render = window.YesHotelDemandasRender;

const STATUS_LABEL = {
  agendada: "Agendada",
  nao_iniciada: "Não iniciada",
  em_andamento: "Em andamento",
  pausada: "Pausada",
  aguardando_validacao: "Aguardando validação",
  em_correcao: "Em correção",
  concluida: "Concluída",
  cancelada: "Cancelada",
};

let currentUser = null;
let rows = [];
let selected = null;
let atribuiveis = [];
let formMode = "create";
let minhasKpi = null;

const noticeElement = document.querySelector("#demandas-notice");
const accessStateElement = document.querySelector("#access-state");
const contentPanelElement = document.querySelector("#content-panel");
const createFormElement = document.querySelector("#create-form");
const createPanelElement = document.querySelector("#create-panel");
const createTitleElement = document.querySelector("#create-panel-title");
const createSubmitBtn = document.querySelector("#create-submit-btn");

function showNotice(message, variant) {
  if (!(noticeElement instanceof HTMLElement)) {
    return;
  }
  noticeElement.textContent = message || "";
  noticeElement.className = `demandas-notice${message ? "" : " hidden"}${
    variant === "error" ? " is-error" : ""
  }`;
}

function showAccessState(title, message) {
  if (!(accessStateElement instanceof HTMLElement)) {
    return;
  }
  contentPanelElement?.classList.add("hidden");
  accessStateElement.classList.remove("hidden");
  accessStateElement.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  const action = document.createElement("a");
  action.className = "primary-link";
  action.setAttribute("href", "./usuarios-login-mvp.html");
  action.textContent = "Ir para login";
  accessStateElement.append(heading, paragraph, action);
}

function setSidebarOpen(open) {
  document.body.classList.toggle("op-sidebar-open", !!open);
  document.querySelector("#demandas-menu-toggle")?.setAttribute(
    "aria-expanded",
    open ? "true" : "false",
  );
}

function bindSidebar() {
  document.querySelector("#demandas-menu-toggle")?.addEventListener("click", () => {
    setSidebarOpen(true);
  });
  document.querySelector("#demandas-sidebar-close")?.addEventListener("click", () => {
    setSidebarOpen(false);
  });
  document.querySelector("#demandas-sidebar-backdrop")?.addEventListener("click", () => {
    setSidebarOpen(false);
  });
}

function client() {
  const supabase = auth.getSupabaseClient();
  if (!supabase) {
    throw new Error("Cliente Supabase indisponivel.");
  }
  return supabase;
}

function hotelTodayYmd() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Campo_Grande",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

function isOverdue(row) {
  if (row.vencida === true) {
    return true;
  }
  if (row.status === "concluida" || row.status === "cancelada") {
    return false;
  }
  return String(row.data_prevista_conclusao) < hotelTodayYmd();
}

function isMinhas(row) {
  return (
    row.criador_id === currentUser.id ||
    row.supervisor_id === currentUser.id ||
    row.executor_id === currentUser.id
  );
}

function isPendenteMinhas(row) {
  return (
    row.status === "nao_iniciada" ||
    row.status === "pausada" ||
    row.status === "em_correcao"
  );
}

function isConcluidaHoje(row) {
  if (row.status !== "concluida" || !row.concluida_em) {
    return false;
  }
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Campo_Grande",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date(row.concluida_em)) === hotelTodayYmd();
}

function visualRank(row) {
  if (isOverdue(row)) {
    return 0;
  }
  if (row.status === "aguardando_validacao") {
    return 1;
  }
  if (row.status === "em_andamento") {
    return 2;
  }
  return 3;
}

function canEdit(row) {
  return row.criador_id === currentUser.id || currentUser.role === "admin";
}

function canExecute(row) {
  return row.executor_id === currentUser.id || currentUser.role === "admin";
}

function canValidate(row) {
  if (row.executor_id === currentUser.id) {
    return false;
  }
  return row.supervisor_id === currentUser.id || currentUser.role === "admin";
}

function canPhoto(row) {
  return (
    row.executor_id === currentUser.id ||
    row.criador_id === currentUser.id ||
    currentUser.role === "admin"
  );
}

function unwrapRpc(data) {
  if (data && typeof data === "object" && data.ok === false) {
    throw new Error(data.message || data.code || "Acao recusada.");
  }
  if (data && typeof data === "object" && data.ok === true && data.demanda) {
    return data.demanda;
  }
  return data;
}

async function rpc(name, args) {
  const { data, error } = await client().rpc(name, args);
  if (error) {
    throw new Error(error.message);
  }
  return unwrapRpc(data);
}

function fillAssigneeSelects() {
  const supervisor = document.querySelector('[name="supervisor_id"]');
  const executor = document.querySelector('[name="executor_id"]');
  render.fillAssigneeSelect(supervisor, atribuiveis);
  render.fillAssigneeSelect(executor, atribuiveis);
  if (executor instanceof HTMLSelectElement && atribuiveis[1] && formMode === "create") {
    executor.value = atribuiveis[1].id;
  }
  syncAssigneeSelects();
}

function fillExecutorFilter() {
  const select = document.querySelector("#filter-executor");
  if (!(select instanceof HTMLSelectElement)) {
    return;
  }
  const current = select.value;
  render.fillAssigneeSelect(select, atribuiveis);
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "Todos";
  select.insertBefore(all, select.firstChild);
  const stillValid = Array.from(select.options).some((opt) => opt.value === current);
  select.value = stillValid ? current : "";
}

async function loadAtribuiveis() {
  atribuiveis = (await rpc("demandas_listar_usuarios_atribuiveis")) || [];
  fillAssigneeSelects();
  fillExecutorFilter();
}

function syncAssigneeSelects() {
  const supervisor = document.querySelector('[name="supervisor_id"]');
  const executor = document.querySelector('[name="executor_id"]');
  if (!(supervisor instanceof HTMLSelectElement) || !(executor instanceof HTMLSelectElement)) {
    return;
  }
  if (supervisor.value && supervisor.value === executor.value) {
    const other = atribuiveis.find((user) => user.id !== supervisor.value);
    if (other) {
      executor.value = other.id;
    }
  }
}

async function refreshList() {
  await rpc("demandas_liberar_agendadas");
  const { data, error } = await client()
    .from("demandas_lista")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) {
    throw error;
  }
  rows = data || [];
  renderList();
}

function normalizeSearch(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function matchesSearch(row, query) {
  if (!query) {
    return true;
  }
  const haystack = [
    row.titulo,
    row.descricao,
    row.executor_nome,
    row.supervisor_nome,
    row.criador_nome,
  ]
    .map((part) => normalizeSearch(part))
    .join(" ");
  return haystack.includes(query);
}

function scopeRows() {
  if (!isMinhasEscopo()) {
    return rows.slice();
  }
  return rows.filter(isMinhas);
}

function filteredRows() {
  const tipo = document.querySelector("#filter-tipo")?.value;
  const prioridade = document.querySelector("#filter-prioridade")?.value;
  const status = document.querySelector("#filter-status")?.value;
  const atraso = document.querySelector("#filter-atraso")?.value;
  const executor = document.querySelector("#filter-executor")?.value;
  const busca = normalizeSearch(document.querySelector("#filter-busca")?.value);
  const minhas = isMinhasEscopo();
  const list = scopeRows().filter((row) => {
    if (tipo && row.tipo !== tipo) {
      return false;
    }
    if (prioridade && row.prioridade !== prioridade) {
      return false;
    }
    if (status && row.status !== status) {
      return false;
    }
    if (executor && row.executor_id !== executor) {
      return false;
    }
    if (atraso === "vencida" && !isOverdue(row)) {
      return false;
    }
    if (atraso === "no_prazo" && isOverdue(row)) {
      return false;
    }
    if (!matchesSearch(row, busca)) {
      return false;
    }
    if (minhas && minhasKpi === "pendentes" && !isPendenteMinhas(row)) {
      return false;
    }
    if (minhas && minhasKpi === "andamento" && row.status !== "em_andamento") {
      return false;
    }
    if (minhas && minhasKpi === "concluidas-hoje" && !isConcluidaHoje(row)) {
      return false;
    }
    return true;
  });
  if (minhas) {
    return list;
  }
  return list.slice().sort((left, right) => {
    const rankDelta = visualRank(left) - visualRank(right);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    return String(right.created_at || "").localeCompare(String(left.created_at || ""));
  });
}

function renderKpis() {
  const scope = scopeRows();
  if (isMinhasEscopo()) {
    const pendentes = document.querySelector("#kpi-pendentes");
    const andamento = document.querySelector("#kpi-minhas-andamento");
    const hoje = document.querySelector("#kpi-concluidas-hoje");
    if (pendentes) {
      pendentes.textContent = String(scope.filter(isPendenteMinhas).length);
    }
    if (andamento) {
      andamento.textContent = String(
        scope.filter((row) => row.status === "em_andamento").length,
      );
    }
    if (hoje) {
      hoje.textContent = String(scope.filter(isConcluidaHoje).length);
    }
    document.querySelectorAll("#kpis-minhas .demandas-kpi").forEach((button) => {
      button.classList.toggle("is-active", button.getAttribute("data-kpi") === minhasKpi);
    });
    return;
  }
  document.querySelector("#kpi-total").textContent = String(scope.length);
  document.querySelector("#kpi-andamento").textContent = String(
    scope.filter((row) => row.status === "em_andamento").length,
  );
  document.querySelector("#kpi-validacao").textContent = String(
    scope.filter((row) => row.status === "aguardando_validacao").length,
  );
  document.querySelector("#kpi-vencidas").textContent = String(
    scope.filter((row) => isOverdue(row)).length,
  );
  syncGestaoKpiHighlight();
}

function hasGestaoFilters() {
  return Boolean(
    document.querySelector("#filter-tipo")?.value ||
      document.querySelector("#filter-prioridade")?.value ||
      document.querySelector("#filter-status")?.value ||
      document.querySelector("#filter-atraso")?.value ||
      document.querySelector("#filter-executor")?.value ||
      String(document.querySelector("#filter-busca")?.value || "").trim(),
  );
}

function renderEmpty(list) {
  const empty = document.querySelector("#demandas-empty");
  const title = document.querySelector("#demandas-empty-title");
  const hint = document.querySelector("#demandas-empty-hint");
  const createBtn = document.querySelector("#demandas-empty-create");
  if (!(empty instanceof HTMLElement)) {
    return;
  }
  if (list.length) {
    empty.classList.add("hidden");
    return;
  }
  empty.classList.remove("hidden");
  if (title) {
    title.textContent = "Nenhuma demanda encontrada";
  }
  if (isMinhasEscopo()) {
    createBtn?.classList.add("hidden");
    if (hint instanceof HTMLElement) {
      if (scopeRows().length === 0) {
        hint.textContent = "Nada pendente para você no momento.";
        hint.classList.remove("hidden");
      } else {
        hint.textContent = "";
        hint.classList.add("hidden");
      }
    }
    return;
  }
  if (hint instanceof HTMLElement) {
    hint.textContent = "";
    hint.classList.add("hidden");
  }
  createBtn?.classList.toggle("hidden", hasGestaoFilters());
}

function addCardAction(host, label, handler, variant) {
  const button = document.createElement("button");
  button.type = "button";
  button.className =
    variant === "secondary" ? "op-btn op-btn--secondary" : "op-btn op-btn--primary";
  button.textContent = label;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    handler().catch((error) => showNotice(error.message, "error"));
  });
  host.append(button);
}

function appendOperatorActions(card, row) {
  if (!isMinhasEscopo()) {
    return;
  }
  const host = document.createElement("div");
  host.className = "demandas-card-actions";
  host.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  if (
    canExecute(row) &&
    (row.status === "nao_iniciada" || row.status === "em_correcao" || row.status === "agendada")
  ) {
    addCardAction(host, "Iniciar", async () => {
      selected = row;
      await act("demandas_iniciar", true);
    });
  }
  if (canExecute(row) && row.status === "em_andamento") {
    addCardAction(
      host,
      "Pausar",
      async () => {
        selected = row;
        const motivo = window.prompt("Motivo da pausa (opcional)") || "";
        await rpc("demandas_pausar", {
          p_demanda_id: selected.id,
          p_row_version: selected.row_version,
          p_motivo: motivo,
        });
        await afterMutation();
      },
      "secondary",
    );
    addCardAction(host, "Enviar para validação", async () => {
      selected = row;
      await act("demandas_enviar_validacao", true);
    });
  }
  if (canExecute(row) && row.status === "pausada") {
    addCardAction(host, "Retomar", async () => {
      selected = row;
      await rpc("demandas_retomar", {
        p_demanda_id: selected.id,
        p_row_version: selected.row_version,
      }).then(afterMutation);
    });
  }
  addCardAction(
    host,
    "Ver detalhes",
    async () => {
      await openDetail(row.id);
    },
    "secondary",
  );
  card.append(host);
}

function renderList() {
  const list = filteredRows();
  renderKpis();
  renderEmpty(list);
  const host = document.querySelector("#demandas-list");
  if (!(host instanceof HTMLElement)) {
    return;
  }
  host.replaceChildren();
  list.forEach((row) => {
    const card = render.buildCard(row, {
      overdue: isOverdue(row),
      statusLabel: STATUS_LABEL[row.status] || row.status,
      showExecutor: !isMinhasEscopo(),
    });
    card.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest(".demandas-card-actions")) {
        return;
      }
      openDetail(row.id).catch((error) => {
        showNotice(error.message, "error");
      });
    });
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      if (event.target instanceof Element && event.target.closest(".demandas-card-actions")) {
        return;
      }
      event.preventDefault();
      openDetail(row.id).catch((error) => {
        showNotice(error.message, "error");
      });
    });
    appendOperatorActions(card, row);
    host.append(card);
  });
}

async function captureGeo() {
  if (!navigator.geolocation) {
    throw new Error("Geolocalizacao indisponivel neste dispositivo.");
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          precisao: pos.coords.accuracy ?? null,
        });
      },
      () => {
        reject(new Error("Nao foi possivel obter a geolocalizacao."));
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  });
}

function resetCreateForm() {
  formMode = "create";
  if (createFormElement instanceof HTMLFormElement) {
    createFormElement.reset();
    delete createFormElement.dataset.demandaId;
    delete createFormElement.dataset.rowVersion;
  }
  if (createTitleElement) {
    createTitleElement.textContent = "Criar demanda";
  }
  if (createSubmitBtn) {
    createSubmitBtn.textContent = "Criar";
  }
  fillAssigneeSelects();
}

function openCreatePanel() {
  resetCreateForm();
  createPanelElement?.classList.remove("hidden");
  createPanelElement?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function openEditPanel(row) {
  if (!(createFormElement instanceof HTMLFormElement)) {
    return;
  }
  formMode = "edit";
  createFormElement.dataset.demandaId = row.id;
  createFormElement.dataset.rowVersion = String(row.row_version);
  if (createTitleElement) {
    createTitleElement.textContent = "Editar demanda";
  }
  if (createSubmitBtn) {
    createSubmitBtn.textContent = "Salvar alterações";
  }
  createFormElement.elements.titulo.value = row.titulo || "";
  createFormElement.elements.descricao.value = row.descricao || "";
  createFormElement.elements.tipo.value = row.tipo || "corretiva";
  createFormElement.elements.prioridade.value = row.prioridade || "media";
  createFormElement.elements.data_programada_inicio.value = row.data_programada_inicio || "";
  createFormElement.elements.data_prevista_conclusao.value = row.data_prevista_conclusao || "";
  createFormElement.elements.supervisor_id.value = row.supervisor_id || "";
  createFormElement.elements.executor_id.value = row.executor_id || "";
  createFormElement.elements.exigir_foto.checked = Boolean(row.exigir_foto);
  createFormElement.elements.sem_local_especifico.checked = Boolean(row.sem_local_especifico);
  syncAssigneeSelects();
  createPanelElement?.classList.remove("hidden");
  createPanelElement?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function openDetail(id) {
  const { data, error } = await client()
    .from("demandas_lista")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) {
    throw new Error(error?.message || "Demanda nao encontrada.");
  }
  selected = data;
  document.querySelector("#detail-panel")?.classList.remove("hidden");
  document.querySelector("#detail-title").textContent = data.titulo;
  const body = document.querySelector("#detail-body");
  body.replaceChildren(
    render.buildDetail(data, {
      overdue: isOverdue(data),
      statusLabel: STATUS_LABEL[data.status] || data.status,
    }),
  );
  renderActions(data);
  await Promise.all([loadHistorico(data.id), loadFotos(data.id)]);
  document.querySelector("#detail-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function addAction(host, label, handler, variant) {
  const button = document.createElement("button");
  button.type = "button";
  if (variant === "danger") {
    button.className = "op-btn op-btn--secondary demandas-action-danger";
  } else if (variant === "secondary") {
    button.className = "op-btn op-btn--secondary";
  } else {
    button.className = "op-btn op-btn--primary";
  }
  button.textContent = label;
  button.addEventListener("click", () => {
    handler().catch((error) => showNotice(error.message, "error"));
  });
  host.append(button);
}

function renderActions(row) {
  const host = document.querySelector("#detail-actions");
  host.replaceChildren();
  if (canEdit(row) && row.status !== "concluida" && row.status !== "cancelada") {
    addAction(host, "Editar", async () => {
      openEditPanel(row);
    }, "secondary");
  }
  if (canExecute(row) && (row.status === "nao_iniciada" || row.status === "em_correcao" || row.status === "agendada")) {
    addAction(host, "Iniciar", () => act("demandas_iniciar", true));
  }
  if (canExecute(row) && row.status === "em_andamento") {
    addAction(host, "Pausar", async () => {
      const motivo = window.prompt("Motivo da pausa (opcional)") || "";
      await rpc("demandas_pausar", {
        p_demanda_id: selected.id,
        p_row_version: selected.row_version,
        p_motivo: motivo,
      });
      await afterMutation();
    }, "secondary");
    addAction(host, "Enviar para validação", () => act("demandas_enviar_validacao", true));
  }
  if (canExecute(row) && row.status === "pausada") {
    addAction(host, "Retomar", () =>
      rpc("demandas_retomar", {
        p_demanda_id: selected.id,
        p_row_version: selected.row_version,
      }).then(afterMutation),
    );
  }
  if (canValidate(row) && row.status === "aguardando_validacao") {
    addAction(host, "Aprovar", () =>
      rpc("demandas_aprovar", {
        p_demanda_id: selected.id,
        p_row_version: selected.row_version,
      }).then(afterMutation),
    );
    addAction(host, "Rejeitar", async () => {
      const justificativa = window.prompt("Motivo da rejeição");
      if (!justificativa || !justificativa.trim()) {
        throw new Error("Rejeição exige justificativa.");
      }
      await rpc("demandas_rejeitar", {
        p_demanda_id: selected.id,
        p_row_version: selected.row_version,
        p_justificativa: justificativa.trim(),
      });
      await afterMutation();
    }, "danger");
  }
  if (canEdit(row) && row.status !== "concluida" && row.status !== "cancelada") {
    addAction(host, "Cancelar", async () => {
      const justificativa = window.prompt("Justificativa do cancelamento");
      if (!justificativa || !justificativa.trim()) {
        throw new Error("Cancelamento exige justificativa.");
      }
      await rpc("demandas_cancelar", {
        p_demanda_id: selected.id,
        p_row_version: selected.row_version,
        p_justificativa: justificativa.trim(),
      });
      await afterMutation();
    }, "danger");
  }
  if (canEdit(row) && row.status === "concluida") {
    addAction(host, "Reabrir", async () => {
      const justificativa = window.prompt("Justificativa da reabertura");
      if (!justificativa || !justificativa.trim()) {
        throw new Error("Reabertura exige justificativa.");
      }
      await rpc("demandas_reabrir", {
        p_demanda_id: selected.id,
        p_row_version: selected.row_version,
        p_justificativa: justificativa.trim(),
      });
      await afterMutation();
    });
  }
}

async function act(fn, withGeo) {
  const payload = {
    p_demanda_id: selected.id,
    p_row_version: selected.row_version,
  };
  if (withGeo && !selected.sem_local_especifico) {
    const geo = await captureGeo();
    payload.p_latitude = geo.latitude;
    payload.p_longitude = geo.longitude;
    payload.p_precisao_metros = geo.precisao;
  }
  await rpc(fn, payload);
  await afterMutation();
}

async function afterMutation() {
  showNotice("Ação registrada.");
  await refreshList();
  if (selected?.id) {
    await openDetail(selected.id);
  }
}

async function loadHistorico(id) {
  const { data, error } = await client()
    .from("demandas_historico")
    .select("*")
    .eq("demanda_id", id)
    .order("criado_em", { ascending: false });
  if (error) {
    throw error;
  }
  const host = document.querySelector("#historico-list");
  host.replaceChildren();
  (data || []).forEach((item) => {
    const when = new Date(item.criado_em).toLocaleString("pt-BR", {
      timeZone: "America/Campo_Grande",
    });
    host.append(
      render.buildHistoricoItem({
        whenLabel: when,
        acao: item.acao,
        justificativa: item.justificativa,
      }),
    );
  });
}

async function loadFotos(id) {
  const { data, error } = await client()
    .from("demandas_anexos")
    .select("*")
    .eq("demanda_id", id)
    .order("created_at", { ascending: false });
  if (error) {
    throw error;
  }
  const host = document.querySelector("#photo-list");
  host.replaceChildren();
  for (const anexo of data || []) {
    const wrap = document.createElement("figure");
    const img = document.createElement("img");
    img.alt = String(anexo.etapa || "foto");
    const { data: signed } = await client()
      .storage.from("demandas-fotos")
      .createSignedUrl(anexo.storage_path, 60);
    if (signed?.signedUrl) {
      img.setAttribute("src", signed.signedUrl);
    }
    const cap = document.createElement("figcaption");
    cap.textContent = String(anexo.etapa || "");
    wrap.append(img, cap);
    host.append(wrap);
  }
}

async function uploadPhoto(file) {
  if (!selected) {
    throw new Error("Abra uma demanda antes de incluir foto.");
  }
  if (!canPhoto(selected)) {
    throw new Error("Sem permissao para incluir foto nesta demanda.");
  }
  const compressed = await photoHelper.compressImageFile(file);
  const headers = await auth.getEdgeFunctionFetchHeaders();
  const form = new FormData();
  form.append("demanda_id", selected.id);
  form.append("etapa", document.querySelector("#photo-etapa")?.value || "durante");
  form.append("file", compressed, "demanda.jpg");
  const config = window.YES_HOTEL_SUPABASE_CONFIG || {};
  const response = await fetch(`${config.url}/functions/v1/demandas-foto-upload`, {
    method: "POST",
    headers: {
      Authorization: headers.Authorization,
      apikey: config.anonKey,
    },
    body: form,
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || "Falha no upload da foto.");
  }
  await afterMutation();
}

function bindPhotoInput(input) {
  input?.addEventListener("change", async (event) => {
    const target = event.target;
    const file = target.files && target.files[0];
    target.value = "";
    if (!file) {
      return;
    }
    try {
      await uploadPhoto(file);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Falha no upload.", "error");
    }
  });
}

function isMinhasEscopo() {
  return new URLSearchParams(window.location.search).get("escopo") === "minhas";
}

function applyPageChrome() {
  const minhas = isMinhasEscopo();
  document.body.classList.toggle("demandas-escopo-minhas", minhas);
  document.body.classList.toggle("demandas-escopo-gestao", !minhas);
  document.title = minhas ? "Yes Hotel — Minhas demandas" : "Yes Hotel — Demandas";
  const title = document.querySelector("#demandas-page-title");
  const listHeading = document.querySelector("#demandas-list-heading");
  if (title) {
    title.textContent = minhas ? "Minhas demandas" : "Demandas";
  }
  if (listHeading) {
    listHeading.textContent = minhas ? "Minhas demandas" : "Todas as demandas";
  }
  const navMinhas = document.querySelector("#nav-minhas");
  const navTodas = document.querySelector("#nav-todas");
  navMinhas?.classList.toggle("active", minhas);
  navTodas?.classList.toggle("active", !minhas);
  if (minhas) {
    navMinhas?.setAttribute("aria-current", "page");
    navTodas?.removeAttribute("aria-current");
  } else {
    navTodas?.setAttribute("aria-current", "page");
    navMinhas?.removeAttribute("aria-current");
  }
  document.querySelector("#kpis-gestao")?.classList.toggle("hidden", minhas);
  document.querySelector("#kpis-minhas")?.classList.toggle("hidden", !minhas);
  document.querySelector("#btn-nova")?.classList.toggle("hidden", minhas);
  document.querySelectorAll("[data-filter]").forEach((node) => {
    const key = node.getAttribute("data-filter");
    const keep = minhas ? key === "status" || key === "prioridade" : true;
    node.classList.toggle("hidden", !keep);
  });
}

function syncGestaoKpiHighlight() {
  const status = document.querySelector("#filter-status")?.value;
  const atraso = document.querySelector("#filter-atraso")?.value;
  let active = "total";
  if (atraso === "vencida") {
    active = "vencidas";
  } else if (status === "em_andamento" && !atraso) {
    active = "andamento";
  } else if (status === "aguardando_validacao" && !atraso) {
    active = "validacao";
  }
  document.querySelectorAll("#kpis-gestao .demandas-kpi").forEach((button) => {
    button.classList.toggle("is-active", button.getAttribute("data-kpi") === active);
  });
}

function applyGestaoKpi(key) {
  const statusEl = document.querySelector("#filter-status");
  const atrasoEl = document.querySelector("#filter-atraso");
  if (key === "total") {
    if (statusEl instanceof HTMLSelectElement) {
      statusEl.value = "";
    }
    if (atrasoEl instanceof HTMLSelectElement) {
      atrasoEl.value = "";
    }
  } else if (key === "andamento") {
    if (statusEl instanceof HTMLSelectElement) {
      statusEl.value = "em_andamento";
    }
    if (atrasoEl instanceof HTMLSelectElement) {
      atrasoEl.value = "";
    }
  } else if (key === "validacao") {
    if (statusEl instanceof HTMLSelectElement) {
      statusEl.value = "aguardando_validacao";
    }
    if (atrasoEl instanceof HTMLSelectElement) {
      atrasoEl.value = "";
    }
  } else if (key === "vencidas") {
    if (atrasoEl instanceof HTMLSelectElement) {
      atrasoEl.value = "vencida";
    }
  }
  renderList();
}

function applyMinhasKpi(key) {
  minhasKpi = minhasKpi === key ? null : key;
  const statusEl = document.querySelector("#filter-status");
  if (minhasKpi && statusEl instanceof HTMLSelectElement) {
    statusEl.value = "";
  }
  renderList();
}

async function init() {
  bindSidebar();
  if (!auth || !auth.isConfigured()) {
    showAccessState("Autenticação indisponível", auth?.getConfigError?.() || "");
    return;
  }
  currentUser = await auth.getCurrentUser();
  if (!currentUser) {
    showAccessState("Login necessário", "Entre com um usuário interno.");
    return;
  }
  if (typeof auth.canAccessDemandas === "function" && !auth.canAccessDemandas(currentUser)) {
    showAccessState("Acesso negado", "Seu perfil não acessa Demandas.");
    return;
  }

  applyPageChrome();
  document.querySelectorAll('[data-nav="operacao"]').forEach((node) => {
    node.classList.toggle("hidden", currentUser.role === "cafe");
  });
  document.querySelectorAll('[data-nav="gestao"]').forEach((node) => {
    node.classList.toggle("hidden", currentUser.role === "cafe");
  });
  document.querySelectorAll('[data-nav="financeiro"]').forEach((node) => {
    node.classList.toggle("hidden", currentUser.role !== "admin");
  });

  accessStateElement?.classList.add("hidden");
  contentPanelElement?.classList.remove("hidden");
  document.querySelector("#demandas-session-user-name").textContent = currentUser.name;
  document.querySelector("#demandas-session-user-role").textContent = auth.getRoleLabel(
    currentUser.role,
  );

  await Promise.all([loadAtribuiveis(), refreshList()]);
}

document.querySelector("#logout-button")?.addEventListener("click", async () => {
  await auth.logout();
  window.location.href = "./usuarios-login-mvp.html";
});

["filter-tipo", "filter-prioridade", "filter-status", "filter-atraso", "filter-executor"].forEach(
  (id) => {
    document.querySelector(`#${id}`)?.addEventListener("change", () => {
      if (id === "filter-status" && isMinhasEscopo()) {
        minhasKpi = null;
      }
      renderList();
    });
  },
);

document.querySelector("#filter-busca")?.addEventListener("input", renderList);

document.querySelector("#kpis-gestao")?.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-kpi]") : null;
  if (!button) {
    return;
  }
  applyGestaoKpi(button.getAttribute("data-kpi"));
});

document.querySelector("#kpis-minhas")?.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-kpi]") : null;
  if (!button) {
    return;
  }
  applyMinhasKpi(button.getAttribute("data-kpi"));
});

document.querySelector('[name="supervisor_id"]')?.addEventListener("change", syncAssigneeSelects);
document.querySelector('[name="executor_id"]')?.addEventListener("change", syncAssigneeSelects);

document.querySelector("#btn-nova")?.addEventListener("click", () => {
  openCreatePanel();
});
document.querySelector("#demandas-empty-create")?.addEventListener("click", () => {
  openCreatePanel();
});
document.querySelector("#btn-cancelar-criar")?.addEventListener("click", () => {
  resetCreateForm();
  createPanelElement?.classList.add("hidden");
});

document.querySelector("#create-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  try {
    if (data.get("supervisor_id") === data.get("executor_id")) {
      throw new Error("Supervisor e executor precisam ser pessoas diferentes.");
    }
    const payload = {
      p_titulo: data.get("titulo"),
      p_descricao: data.get("descricao"),
      p_tipo: data.get("tipo"),
      p_prioridade: data.get("prioridade"),
      p_data_programada_inicio: data.get("data_programada_inicio"),
      p_data_prevista_conclusao: data.get("data_prevista_conclusao"),
      p_supervisor_id: data.get("supervisor_id"),
      p_executor_id: data.get("executor_id"),
      p_exigir_foto: data.get("exigir_foto") === "on",
      p_sem_local_especifico: data.get("sem_local_especifico") === "on",
    };
    const editingSelectedId = formMode === "edit" ? selected?.id : null;
    if (formMode === "edit" && form.dataset.demandaId) {
      payload.p_demanda_id = form.dataset.demandaId;
      payload.p_row_version = Number(form.dataset.rowVersion);
      await rpc("demandas_editar", payload);
      showNotice("Demanda atualizada.");
    } else {
      await rpc("demandas_criar", payload);
      showNotice("Demanda criada.");
    }
    resetCreateForm();
    createPanelElement?.classList.add("hidden");
    await refreshList();
    if (editingSelectedId) {
      await openDetail(editingSelectedId);
    }
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Falha ao salvar.", "error");
  }
});

bindPhotoInput(document.querySelector("#photo-input-camera"));
bindPhotoInput(document.querySelector("#photo-input-gallery"));

init().catch((error) => {
  showAccessState(
    "Falha ao abrir Demandas",
    error instanceof Error ? error.message : "Erro inesperado.",
  );
});
