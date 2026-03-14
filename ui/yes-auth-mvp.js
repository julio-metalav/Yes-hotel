(function attachYesHotelAuthMvp(globalScope) {
  const USERS_STORAGE_KEY = "yesHotelUsersMvp";
  const SESSIONS_STORAGE_KEY = "yesHotelSessionsMvp";
  const CURRENT_SESSION_TOKEN_KEY = "yesHotelCurrentSessionTokenMvp";
  const SESSION_DURATION_MS = 4 * 60 * 60 * 1000;
  const PASSWORD_ITERATIONS = 120000;
  const encoder = new TextEncoder();

  function nowIso() {
    return new Date().toISOString();
  }

  function readJson(key, fallbackValue) {
    const rawValue = globalScope.localStorage.getItem(key);

    if (!rawValue) {
      return fallbackValue;
    }

    try {
      return JSON.parse(rawValue);
    } catch {
      return fallbackValue;
    }
  }

  function writeJson(key, value) {
    globalScope.localStorage.setItem(key, JSON.stringify(value));
  }

  function normalizeEmail(email) {
    return String(email || "").trim().toLowerCase();
  }

  function generateRandomHex(length) {
    const randomBytes = new Uint8Array(length);
    globalScope.crypto.getRandomValues(randomBytes);

    return Array.from(randomBytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }

  function bufferToHex(buffer) {
    return Array.from(new Uint8Array(buffer), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }

  function ensureCryptoAvailable() {
    if (!globalScope.crypto?.subtle || !globalScope.crypto?.getRandomValues) {
      throw new Error(
        "Web Crypto API indisponivel neste navegador. Este MVP precisa dela para hash de senha.",
      );
    }
  }

  async function hashPassword(password, salt) {
    ensureCryptoAvailable();

    const baseKey = await globalScope.crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const derivedBits = await globalScope.crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: encoder.encode(salt),
        iterations: PASSWORD_ITERATIONS,
        hash: "SHA-256",
      },
      baseKey,
      256,
    );

    return bufferToHex(derivedBits);
  }

  function listUsers() {
    return readJson(USERS_STORAGE_KEY, []);
  }

  function saveUsers(users) {
    writeJson(USERS_STORAGE_KEY, users);
  }

  function listSessions() {
    return readJson(SESSIONS_STORAGE_KEY, []);
  }

  function saveSessions(sessions) {
    writeJson(SESSIONS_STORAGE_KEY, sessions);
  }

  function hasUsers() {
    return listUsers().length > 0;
  }

  function findUserById(userId) {
    return listUsers().find((user) => user.id === userId) || null;
  }

  function findUserByEmail(email) {
    const normalizedEmail = normalizeEmail(email);
    return (
      listUsers().find((user) => normalizeEmail(user.email) === normalizedEmail) ||
      null
    );
  }

  function isSessionExpired(session) {
    return new Date(session.expiresAt).getTime() <= Date.now();
  }

  function purgeExpiredSessions() {
    const sessions = listSessions();
    const activeSessions = sessions.filter(
      (session) => !session.invalidatedAt && !isSessionExpired(session),
    );

    if (activeSessions.length !== sessions.length) {
      saveSessions(activeSessions);
    }
  }

  function createSessionForUser(userId) {
    purgeExpiredSessions();

    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
    const session = {
      id: `session_${generateRandomHex(8)}`,
      userId,
      token: generateRandomHex(24),
      expiresAt,
      createdAt,
      invalidatedAt: null,
    };
    const sessions = listSessions();
    sessions.push(session);
    saveSessions(sessions);
    globalScope.localStorage.setItem(CURRENT_SESSION_TOKEN_KEY, session.token);

    return session;
  }

  function getCurrentSession() {
    purgeExpiredSessions();

    const currentToken = globalScope.localStorage.getItem(CURRENT_SESSION_TOKEN_KEY);

    if (!currentToken) {
      return null;
    }

    const session =
      listSessions().find((item) => item.token === currentToken) || null;

    if (!session || session.invalidatedAt || isSessionExpired(session)) {
      globalScope.localStorage.removeItem(CURRENT_SESSION_TOKEN_KEY);
      return null;
    }

    return session;
  }

  function getCurrentUser() {
    const session = getCurrentSession();

    if (!session) {
      return null;
    }

    const user = findUserById(session.userId);

    if (!user || !user.active) {
      logout();
      return null;
    }

    return user;
  }

  function logout() {
    const currentSession = getCurrentSession();

    if (!currentSession) {
      globalScope.localStorage.removeItem(CURRENT_SESSION_TOKEN_KEY);
      return;
    }

    const sessions = listSessions().map((session) =>
      session.id === currentSession.id
        ? {
            ...session,
            invalidatedAt: nowIso(),
          }
        : session,
    );

    saveSessions(sessions);
    globalScope.localStorage.removeItem(CURRENT_SESSION_TOKEN_KEY);
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

    if (findUserByEmail(email)) {
      throw new Error("Ja existe usuario com este email.");
    }

    const createdAt = nowIso();
    const passwordSalt = generateRandomHex(16);
    const passwordHash = await hashPassword(password, passwordSalt);
    const isBootstrapAdmin = !hasUsers();
    const user = {
      id: `user_${generateRandomHex(8)}`,
      name,
      email,
      passwordHash,
      passwordSalt,
      role: isBootstrapAdmin ? "admin" : role,
      active: isBootstrapAdmin ? true : active,
      createdAt,
      updatedAt: createdAt,
    };
    const users = listUsers();
    users.push(user);
    saveUsers(users);

    return user;
  }

  async function updateUser(userId, input) {
    const users = listUsers();
    const userIndex = users.findIndex((user) => user.id === userId);

    if (userIndex === -1) {
      throw new Error("Usuario nao encontrado.");
    }

    const currentUser = users[userIndex];
    const nextName = String(input.name || "").trim();
    const nextEmail = normalizeEmail(input.email);
    const nextRole = String(input.role || "").trim();
    const nextActive = Boolean(input.active);
    const nextPassword = String(input.password || "");

    if (!nextName || !nextEmail || !nextRole) {
      throw new Error("Nome, email e perfil sao obrigatorios.");
    }

    const conflictingUser = users.find(
      (user) =>
        user.id !== userId && normalizeEmail(user.email) === nextEmail,
    );

    if (conflictingUser) {
      throw new Error("Ja existe outro usuario com este email.");
    }

    let passwordHash = currentUser.passwordHash;
    let passwordSalt = currentUser.passwordSalt;

    if (nextPassword.trim()) {
      passwordSalt = generateRandomHex(16);
      passwordHash = await hashPassword(nextPassword, passwordSalt);
    }

    users[userIndex] = {
      ...currentUser,
      name: nextName,
      email: nextEmail,
      passwordHash,
      passwordSalt,
      role: nextRole,
      active: nextActive,
      updatedAt: nowIso(),
    };

    saveUsers(users);

    return users[userIndex];
  }

  async function verifyPassword(user, password) {
    const attemptedHash = await hashPassword(password, user.passwordSalt);
    return attemptedHash === user.passwordHash;
  }

  async function login(email, password) {
    const user = findUserByEmail(email);

    if (!user) {
      throw new Error("Email ou senha invalidos.");
    }

    if (!user.active) {
      throw new Error("Usuario inativo nao pode entrar.");
    }

    const passwordMatches = await verifyPassword(user, password);

    if (!passwordMatches) {
      throw new Error("Email ou senha invalidos.");
    }

    const session = createSessionForUser(user.id);

    return {
      user,
      session,
    };
  }

  function getSessionDurationHours() {
    return SESSION_DURATION_MS / (60 * 60 * 1000);
  }

  function canAccessUserManagement(user) {
    return user?.role === "admin";
  }

  function canAccessBreakfast(user) {
    return ["admin", "recepcao", "cafe"].includes(user?.role);
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

  globalScope.YesHotelAuthMvp = {
    createUser,
    updateUser,
    login,
    logout,
    listUsers,
    findUserById,
    getCurrentSession,
    getCurrentUser,
    hasUsers,
    canAccessUserManagement,
    canAccessBreakfast,
    getRoleLabel,
    getSessionDurationHours,
  };
})(window);
