import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
  throw new Error(
    "SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY sao obrigatorias para a edge function.",
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function normalizeEmail(email: unknown): string {
  return String(email ?? "").trim().toLowerCase();
}

function normalizeRole(role: unknown): "admin" | "recepcao" | "cafe" {
  const value = String(role ?? "").trim();

  if (value !== "admin" && value !== "recepcao" && value !== "cafe") {
    throw new Error("Perfil invalido. Use admin, recepcao ou cafe.");
  }

  return value;
}

function ensureRequiredText(value: unknown, fieldLabel: string): string {
  const text = String(value ?? "").trim();

  if (!text) {
    throw new Error(`${fieldLabel} obrigatorio.`);
  }

  return text;
}

function mapProfileRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    authUserId: row.auth_user_id,
    name: row.nome,
    email: row.email_login,
    role: row.perfil_usuario,
    active: row.ativo,
    telefoneWhatsapp: row.telefone_whatsapp ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeTelefoneWhatsapp(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }
  if (digits.length === 10 || digits.length === 11) {
    digits = `55${digits}`;
  }
  if ((digits.length !== 12 && digits.length !== 13) || !digits.startsWith("55")) {
    throw new Error("Telefone/WhatsApp invalido. Use DDD + numero brasileiro.");
  }
  const local = digits.slice(2);
  if (local.length === 11 && local[2] !== "9") {
    throw new Error("Telefone/WhatsApp invalido. Celular deve ter 9 apos o DDD.");
  }
  return `+${digits}`;
}

async function userHasOpenDemandaAssignment(userId: string): Promise<boolean> {
  const { count, error } = await adminClient
    .from("demandas")
    .select("id", { count: "exact", head: true })
    .or(`supervisor_id.eq.${userId},executor_id.eq.${userId}`)
    .not("status", "in", "(concluida,cancelada)");

  if (error) {
    const message = String(error.message || "").toLowerCase();
    if (
      message.includes("does not exist") ||
      message.includes("schema cache") ||
      message.includes("could not find the table")
    ) {
      return false;
    }
    throw error;
  }

  return Boolean(count && count > 0);
}

const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

function createRequestClient(request: Request) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: request.headers.get("Authorization") ?? "",
      },
    },
  });
}

async function getCallerProfile(request: Request) {
  const requestClient = createRequestClient(request);
  const {
    data: { user },
    error: userError,
  } = await requestClient.auth.getUser();

  if (userError || !user) {
    return null;
  }

  const { data: profileRow, error: profileError } = await adminClient
    .from("usuarios_internos")
    .select("*")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (profileError || !profileRow) {
    return null;
  }

  return mapProfileRow(profileRow);
}

async function ensureAdminCaller(request: Request) {
  const callerProfile = await getCallerProfile(request);

  if (!callerProfile || callerProfile.role !== "admin" || !callerProfile.active) {
    throw new Error("Apenas admin ativo pode usar esta operacao.");
  }

  return callerProfile;
}

async function getHasUsers(): Promise<boolean> {
  const { count, error } = await adminClient
    .from("usuarios_internos")
    .select("id", { count: "exact", head: true });

  if (error) {
    throw error;
  }

  return Boolean(count && count > 0);
}

async function bootstrapAdmin(payload: Record<string, unknown>) {
  if (await getHasUsers()) {
    return jsonResponse(
      {
        error: "Ja existem usuarios internos cadastrados; bootstrap inicial nao esta mais disponivel.",
      },
      409,
    );
  }

  const name = ensureRequiredText(payload.name, "Nome");
  const email = normalizeEmail(payload.email);
  const password = ensureRequiredText(payload.password, "Senha");

  const { data: createdAuthUser, error: createAuthError } =
    await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: {
        role: "admin",
      },
      user_metadata: {
        name,
      },
    });

  if (createAuthError || !createdAuthUser.user) {
    return jsonResponse(
      {
        error: createAuthError?.message ?? "Falha ao criar usuario auth inicial.",
      },
      400,
    );
  }

  const { data: profileRow, error: insertProfileError } = await adminClient
    .from("usuarios_internos")
    .insert({
      auth_user_id: createdAuthUser.user.id,
      nome: name,
      email_login: email,
      perfil_usuario: "admin",
      ativo: true,
    })
    .select("*")
    .single();

  if (insertProfileError) {
    await adminClient.auth.admin.deleteUser(createdAuthUser.user.id);

    return jsonResponse(
      {
        error: insertProfileError.message,
      },
      400,
    );
  }

  return jsonResponse({
    ok: true,
    user: mapProfileRow(profileRow),
  });
}

async function listUsers(request: Request) {
  await ensureAdminCaller(request);

  const { data, error } = await adminClient
    .from("usuarios_internos")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return jsonResponse(
      {
        error: error.message,
      },
      400,
    );
  }

  return jsonResponse({
    ok: true,
    users: (data ?? []).map((row) => mapProfileRow(row)),
  });
}

async function createUser(request: Request, payload: Record<string, unknown>) {
  await ensureAdminCaller(request);

  const name = ensureRequiredText(payload.name, "Nome");
  const email = normalizeEmail(payload.email);
  const password = ensureRequiredText(payload.password, "Senha");
  const role = normalizeRole(payload.role);
  const active = Boolean(payload.active);
  const telefoneWhatsapp = normalizeTelefoneWhatsapp(payload.telefoneWhatsapp);

  const { data: createdAuthUser, error: createAuthError } =
    await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: {
        role,
      },
      user_metadata: {
        name,
      },
    });

  if (createAuthError || !createdAuthUser.user) {
    return jsonResponse(
      {
        error: createAuthError?.message ?? "Falha ao criar usuario auth.",
      },
      400,
    );
  }

  const { data: profileRow, error: insertProfileError } = await adminClient
    .from("usuarios_internos")
    .insert({
      auth_user_id: createdAuthUser.user.id,
      nome: name,
      email_login: email,
      perfil_usuario: role,
      ativo: active,
      telefone_whatsapp: telefoneWhatsapp,
    })
    .select("*")
    .single();

  if (insertProfileError) {
    await adminClient.auth.admin.deleteUser(createdAuthUser.user.id);

    return jsonResponse(
      {
        error: insertProfileError.message,
      },
      400,
    );
  }

  return jsonResponse({
    ok: true,
    user: mapProfileRow(profileRow),
  });
}

async function updateUser(request: Request, payload: Record<string, unknown>) {
  await ensureAdminCaller(request);

  const userId = ensureRequiredText(payload.userId, "userId");
  const name = ensureRequiredText(payload.name, "Nome");
  const email = normalizeEmail(payload.email);
  const role = normalizeRole(payload.role);
  const active = Boolean(payload.active);
  const password = String(payload.password ?? "").trim();
  const telefoneWhatsapp = normalizeTelefoneWhatsapp(payload.telefoneWhatsapp);

  const { data: currentProfile, error: currentProfileError } = await adminClient
    .from("usuarios_internos")
    .select("*")
    .eq("id", userId)
    .single();

  if (currentProfileError || !currentProfile) {
    return jsonResponse(
      {
        error: "Usuario interno nao encontrado.",
      },
      404,
    );
  }

  const authUserId = currentProfile.auth_user_id;

  if (!authUserId) {
    return jsonResponse(
      {
        error: "Usuario interno sem vinculo auth_user_id.",
      },
      400,
    );
  }

  const telefoneAtual = currentProfile.telefone_whatsapp ?? null;
  if (
    telefoneAtual &&
    telefoneWhatsapp == null &&
    (await userHasOpenDemandaAssignment(userId))
  ) {
    return jsonResponse(
      {
        error:
          "Nao e possivel remover o WhatsApp enquanto o usuario for supervisor ou executor de demanda aberta.",
      },
      409,
    );
  }

  const authUpdatePayload: Record<string, unknown> = {
    email,
    app_metadata: {
      role,
    },
    user_metadata: {
      name,
    },
  };

  if (password) {
    authUpdatePayload.password = password;
  }

  const { error: updateAuthError } = await adminClient.auth.admin.updateUserById(
    authUserId,
    authUpdatePayload,
  );

  if (updateAuthError) {
    return jsonResponse(
      {
        error: updateAuthError.message,
      },
      400,
    );
  }

  const { data: updatedProfile, error: updateProfileError } = await adminClient
    .from("usuarios_internos")
    .update({
      nome: name,
      email_login: email,
      perfil_usuario: role,
      ativo: active,
      telefone_whatsapp: telefoneWhatsapp,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId)
    .select("*")
    .single();

  if (updateProfileError || !updatedProfile) {
    return jsonResponse(
      {
        error: updateProfileError?.message ?? "Falha ao atualizar perfil interno.",
      },
      400,
    );
  }

  return jsonResponse({
    ok: true,
    user: mapProfileRow(updatedProfile),
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  try {
    const requestBody = (await request.json()) as {
      action?: string;
      payload?: Record<string, unknown>;
    };
    const action = requestBody.action ?? "";
    const payload = requestBody.payload ?? {};

    if (action === "bootstrap_status") {
      return jsonResponse({
        ok: true,
        hasUsers: await getHasUsers(),
      });
    }

    if (action === "bootstrap_admin") {
      return await bootstrapAdmin(payload);
    }

    if (action === "list_users") {
      return await listUsers(request);
    }

    if (action === "create_user") {
      return await createUser(request, payload);
    }

    if (action === "update_user") {
      return await updateUser(request, payload);
    }

    return jsonResponse(
      {
        error: "Acao nao suportada.",
      },
      400,
    );
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "Erro inesperado na edge function.",
      },
      500,
    );
  }
});
