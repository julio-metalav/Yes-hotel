(function attachYesHotelSupabaseAuth(globalScope) {
  const rawConfig = globalScope.YES_HOTEL_SUPABASE_CONFIG ?? {};
  const config = {
    ...rawConfig,
    url:
      typeof rawConfig.url === "string" ? rawConfig.url.trim() : rawConfig.url,
    anonKey:
      typeof rawConfig.anonKey === "string"
        ? rawConfig.anonKey.trim()
        : rawConfig.anonKey,
  };
  const APP_SESSION_STARTED_AT_KEY = "yesHotelAppSessionStartedAt";
  const ACCESS_TOKEN_STORAGE_KEY = "yesHotelSupabaseAccessToken";
  const APP_SESSION_DURATION_MS = Number(config.appSessionHours || 4) * 60 * 60 * 1000;
  const PROFILE_COLUMNS =
    "id, auth_user_id, nome, email_login, perfil_usuario, ativo, created_at, updated_at";
  const ADMIN_FUNCTION_NAME = "internal-users-admin";
  const ADMIN_FUNCTION_URL = config.url
    ? `${config.url}/functions/v1/${ADMIN_FUNCTION_NAME}`
    : "";
  const LIFECYCLE_FUNCTION_NAME = "yes-hotel-lifecycle";
  const LIFECYCLE_FUNCTION_URL = config.url
    ? `${config.url}/functions/v1/${LIFECYCLE_FUNCTION_NAME}`
    : "";
  const COMUNICACAO_DISPATCH_FUNCTION_NAME = "operacional-comunicacao-dispatch";
  const COMUNICACAO_DISPATCH_FUNCTION_URL = config.url
    ? `${config.url}/functions/v1/${COMUNICACAO_DISPATCH_FUNCTION_NAME}`
    : "";
  const ACCESS_TOLERANCE_FUNCTION_NAME = "access-tolerance-processor";
  const ACCESS_TOLERANCE_FUNCTION_URL = config.url
    ? `${config.url}/functions/v1/${ACCESS_TOLERANCE_FUNCTION_NAME}`
    : "";

  function getConfigError() {
    if (!globalScope.supabase?.createClient) {
      return "Biblioteca do Supabase nao foi carregada.";
    }

    if (!config.url || !config.anonKey) {
      return "Preencha url e anonKey em ui/yes-supabase-config.js antes de usar login real.";
    }

    return null;
  }

  function isConfigured() {
    return getConfigError() === null;
  }

  function getSessionDurationHours() {
    return APP_SESSION_DURATION_MS / (60 * 60 * 1000);
  }

  function normalizeEmail(email) {
    return String(email || "").trim().toLowerCase();
  }

  function getRoleLabel(role) {
    if (role === "admin") {
      return "Admin";
    }

    if (role === "recepcao") {
      return "Recepcao";
    }

    if (role === "cafe") {
      return "Cafe";
    }

    return role;
  }

  function canAccessUserManagement(user) {
    return user?.role === "admin";
  }

  function canAccessBreakfast(user) {
    return ["admin", "recepcao", "cafe"].includes(user?.role);
  }

  function mapProfile(profileRow) {
    if (!profileRow) {
      return null;
    }

    return {
      id: profileRow.id,
      authUserId: profileRow.auth_user_id,
      name: profileRow.nome,
      email: profileRow.email_login,
      role: profileRow.perfil_usuario,
      active: profileRow.ativo,
      createdAt: profileRow.created_at,
      updatedAt: profileRow.updated_at,
    };
  }

  const client = isConfigured()
    ? globalScope.supabase.createClient(config.url, config.anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
      })
    : null;

  async function getFunctionBearerToken(requireUserSession) {
    if (!client) {
      throw new Error(getConfigError());
    }

    if (!requireUserSession) {
      return config.anonKey;
    }

    const inWindow = await enforceAppSessionWindow();
    if (!inWindow) {
      throw new Error("Sessao real do Supabase indisponivel para esta operacao.");
    }
    const { data: { session }, error } = await client.auth.refreshSession();
    if (error || !session?.access_token) {
      throw new Error("Sessao real do Supabase indisponivel para esta operacao.");
    }
    const normalizedAccessToken = session.access_token.trim();
    setCachedAccessToken(normalizedAccessToken);
    return normalizedAccessToken;
  }

  /**
   * Headers para fetch direto a /functions/v1/* (igual invokeLifecycleAction):
   * exige apikey (anon) + Bearer com JWT atualizado via refreshSession.
   * Sem apikey, o gateway Supabase costuma responder 401 Invalid JWT.
   */
  async function getEdgeFunctionFetchHeaders() {
    if (!client) {
      throw new Error(getConfigError());
    }
    const bearerToken = await getFunctionBearerToken(true);
    return {
      "Content-Type": "application/json",
      apikey: config.anonKey,
      Authorization: `Bearer ${bearerToken}`,
    };
  }

  async function invokeAdminAction(action, payload = {}, options = {}) {
    if (!client || !ADMIN_FUNCTION_URL) {
      throw new Error(getConfigError());
    }

    const requireUserSession = options.requireUserSession !== false;
    const bearerToken = await getFunctionBearerToken(requireUserSession);
    const response = await fetch(ADMIN_FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.anonKey,
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({
        action,
        payload,
      }),
    });
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const errorMessage =
        data?.error || data?.message || `Edge Function retornou status ${response.status}.`;
      throw new Error(errorMessage);
    }

    if (data?.error) {
      throw new Error(data.error);
    }

    return data;
  }

  async function invokeLifecycleAction(action, payload = {}) {
    if (!client || !LIFECYCLE_FUNCTION_URL) {
      throw new Error(getConfigError());
    }

    const bearerToken = await getFunctionBearerToken(true);
    if (typeof globalScope.console !== "undefined" && globalScope.console.log) {
      globalScope.console.log("[TTLock] invokeLifecycleAction action=" + action + " url=" + LIFECYCLE_FUNCTION_URL + " tokenLen=" + (bearerToken ? String(bearerToken.length) : "0"));
    }
    const response = await fetch(LIFECYCLE_FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.anonKey,
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({
        action,
        payload,
      }),
    });
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const errorMessage =
        data?.error || data?.message || `Lifecycle retornou status ${response.status}.`;
      throw new Error(errorMessage);
    }

    if (data?.error) {
      throw new Error(data.error);
    }

    return data;
  }

  /**
   * Ações manuais de tolerância/suspensão desabilitadas neste PR
   * (sem trilha de auditoria append-only dedicada).
   */
  async function invokeAccessToleranceManual() {
    throw new Error(
      "Ações manuais de tolerância desabilitadas até existir auditoria persistente.",
    );
  }

  /**   * Envio WhatsApp operacional (DigiSac stub/real) — central de comunicação.
   * Body: { conversa_id, text, proposito?: "chat_operador" | "generico" }
   */
  async function invokeOperacionalComunicacaoDispatch(payload) {
    if (!client || !COMUNICACAO_DISPATCH_FUNCTION_URL) {
      throw new Error(getConfigError());
    }
    const bearerToken = await getFunctionBearerToken(true);
    const response = await fetch(COMUNICACAO_DISPATCH_FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.anonKey,
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify(payload || {}),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const errorMessage =
        data?.error || data?.message || `Comunicação retornou status ${response.status}.`;
      throw new Error(errorMessage);
    }
    if (data && data.ok === false) {
      throw new Error(data.error || "Falha no envio da mensagem.");
    }
    return data;
  }

  function setAppSessionStart() {
    globalScope.localStorage.setItem(APP_SESSION_STARTED_AT_KEY, String(Date.now()));
  }

  function clearAppSessionStart() {
    globalScope.localStorage.removeItem(APP_SESSION_STARTED_AT_KEY);
  }

  function setCachedAccessToken(token) {
    const normalizedToken = typeof token === "string" ? token.trim() : "";

    if (!normalizedToken) {
      globalScope.localStorage.removeItem(ACCESS_TOKEN_STORAGE_KEY);
      return;
    }

    globalScope.localStorage.setItem(ACCESS_TOKEN_STORAGE_KEY, normalizedToken);
  }

  function getCachedAccessToken() {
    const token = globalScope.localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY);
    return token ? token.trim() : null;
  }

  async function enforceAppSessionWindow() {
    if (!client) {
      throw new Error(getConfigError());
    }

    const {
      data: { session },
    } = await client.auth.getSession();

    if (!session) {
      clearAppSessionStart();
      setCachedAccessToken(null);
      return null;
    }

    const sessionStartedAt = Number(
      globalScope.localStorage.getItem(APP_SESSION_STARTED_AT_KEY) || 0,
    );

    if (!sessionStartedAt || Date.now() - sessionStartedAt > APP_SESSION_DURATION_MS) {
      await client.auth.signOut();
      clearAppSessionStart();
      setCachedAccessToken(null);
      return null;
    }

    return session;
  }

  async function getOwnProfile() {
    if (!client) {
      throw new Error(getConfigError());
    }

    const session = await enforceAppSessionWindow();

    if (!session) {
      return null;
    }

    const {
      data: { user },
      error: userError,
    } = await client.auth.getUser();

    if (userError || !user) {
      return null;
    }

    const { data: profileRow, error: profileError } = await client
      .from("usuarios_internos")
      .select(PROFILE_COLUMNS)
      .eq("auth_user_id", user.id)
      .maybeSingle();

    if (profileError) {
      throw profileError;
    }

    return mapProfile(profileRow);
  }

  async function getCurrentUser() {
    const profile = await getOwnProfile();

    if (!profile) {
      return null;
    }

    if (!profile.active) {
      await logout();
      return null;
    }

    return profile;
  }

  async function hasUsers() {
    if (!client || !ADMIN_FUNCTION_URL) {
      throw new Error(getConfigError());
    }
    const response = await fetch(ADMIN_FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
      },
      body: JSON.stringify({
        action: "bootstrap_status",
        payload: {},
      }),
    });
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(
        data?.error || "Falha ao consultar bootstrap publico de usuarios.",
      );
    }

    return Boolean(data?.hasUsers);
  }

  async function bootstrapFirstAdmin(input) {
    const name = String(input.name || "").trim();
    const email = normalizeEmail(input.email);
    const password = String(input.password || "");

    if (!name || !email || !password) {
      throw new Error("Nome, email e senha sao obrigatorios para o primeiro admin.");
    }

    return invokeAdminAction(
      "bootstrap_admin",
      {
        name,
        email,
        password,
      },
      { requireUserSession: false },
    );
  }

  async function login(email, password) {
    if (!client) {
      throw new Error(getConfigError());
    }

    const { data, error } = await client.auth.signInWithPassword({
      email: normalizeEmail(email),
      password: String(password || ""),
    });

    if (error) {
      throw error;
    }

    if (!data.session?.access_token) {
      throw new Error("Login realizado sem access_token valido do Supabase Auth.");
    }

    setCachedAccessToken(data.session.access_token);
    await client.auth.getSession();
    setAppSessionStart();

    const user = await getCurrentUser();

    if (!user) {
      throw new Error("Usuario sem perfil interno valido ou com sessao expirada.");
    }

    return { user };
  }

  async function logout() {
    if (!client) {
      clearAppSessionStart();
      setCachedAccessToken(null);
      return;
    }

    await client.auth.signOut();
    clearAppSessionStart();
    setCachedAccessToken(null);
  }

  async function listUsers() {
    const data = await invokeAdminAction("list_users");
    return data.users ?? [];
  }

  async function createUser(input) {
    const name = String(input.name || "").trim();
    const email = normalizeEmail(input.email);
    const password = String(input.password || "");
    const role = String(input.role || "").trim();
    const active = Boolean(input.active);

    if (!name || !email || !password || !role) {
      throw new Error("Nome, email, senha e perfil sao obrigatorios.");
    }

    const data = await invokeAdminAction("create_user", {
      name,
      email,
      password,
      role,
      active,
    });

    return data.user;
  }

  async function updateUser(userId, input) {
    const name = String(input.name || "").trim();
    const email = normalizeEmail(input.email);
    const password = String(input.password || "");
    const role = String(input.role || "").trim();
    const active = Boolean(input.active);

    if (!userId || !name || !email || !role) {
      throw new Error("userId, nome, email e perfil sao obrigatorios.");
    }

    const data = await invokeAdminAction("update_user", {
      userId,
      name,
      email,
      password,
      role,
      active,
    });

    return data.user;
  }

  function getSupabaseClient() {
    return client || null;
  }

  globalScope.YesHotelAuthApp = {
    isConfigured,
    getConfigError,
    getSessionDurationHours,
    getRoleLabel,
    canAccessUserManagement,
    canAccessBreakfast,
    hasUsers,
    bootstrapFirstAdmin,
    login,
    logout,
    getCurrentUser,
    listUsers,
    createUser,
    updateUser,
    getSupabaseClient,
    getEdgeFunctionFetchHeaders,
    invokeLifecycleAction,
    invokeAccessToleranceManual,
    invokeOperacionalComunicacaoDispatch,
  };
})(window);
