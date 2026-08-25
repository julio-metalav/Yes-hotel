/**
 * Upload privado de fotos de Demandas.
 * Autentica o usuário interno, valida MIME/tamanho e grava no bucket privado.
 * Metadados entram via RPC demandas_registrar_anexo (auditoria atômica).
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
  throw new Error(
    "SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY sao obrigatorias.",
  );
}

const BUCKET = "demandas-fotos";
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);
const ALLOWED_ETAPAS = new Set(["antes", "durante", "finalizacao", "correcao"]);

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function extFromMime(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

function createRequestClient(request: Request) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      headers: {
        Authorization: request.headers.get("Authorization") ?? "",
      },
    },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Metodo nao suportado." }, 405);
  }

  const requestClient = createRequestClient(request);
  const {
    data: { user },
    error: userError,
  } = await requestClient.auth.getUser();

  if (userError || !user) {
    return jsonResponse({ error: "demandas_unauthenticated" }, 401);
  }

  const { data: profile, error: profileError } = await admin
    .from("usuarios_internos")
    .select("id, ativo, perfil_usuario")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (
    profileError ||
    !profile ||
    !profile.ativo ||
    !["admin", "recepcao", "cafe"].includes(String(profile.perfil_usuario))
  ) {
    return jsonResponse({ error: "demandas_usuario_inativo" }, 403);
  }

  let demandaId = "";
  let etapa = "durante";
  let mime = "";
  let bytes: Uint8Array | null = null;

  const contentType = request.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      demandaId = String(form.get("demanda_id") ?? "").trim();
      etapa = String(form.get("etapa") ?? "durante").trim();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return jsonResponse({ error: "demandas_arquivo_obrigatorio" }, 400);
      }
      mime = file.type || "application/octet-stream";
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      const body = (await request.json()) as Record<string, unknown>;
      demandaId = String(body.demanda_id ?? "").trim();
      etapa = String(body.etapa ?? "durante").trim();
      mime = String(body.mime ?? "").trim();
      const base64 = String(body.base64 ?? "").replace(/^data:[^;]+;base64,/, "");
      const raw = atob(base64);
      bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) {
        bytes[i] = raw.charCodeAt(i);
      }
    }
  } catch {
    return jsonResponse({ error: "demandas_payload_invalido" }, 400);
  }

  if (!/^[0-9a-f-]{36}$/i.test(demandaId)) {
    return jsonResponse({ error: "demandas_id_invalido" }, 400);
  }
  if (!ALLOWED_ETAPAS.has(etapa)) {
    return jsonResponse({ error: "demandas_etapa_invalida" }, 400);
  }
  if (!ALLOWED_MIME.has(mime)) {
    return jsonResponse({ error: "demandas_mime_invalido" }, 400);
  }
  if (!bytes || bytes.byteLength <= 0 || bytes.byteLength > MAX_BYTES) {
    return jsonResponse({ error: "demandas_arquivo_grande" }, 400);
  }

  const anexoId = crypto.randomUUID();
  const storagePath = `${demandaId}/${anexoId}.${extFromMime(mime)}`;

  const { error: uploadError } = await admin.storage.from(BUCKET).upload(storagePath, bytes, {
    contentType: mime === "image/jpg" ? "image/jpeg" : mime,
    upsert: false,
  });

  if (uploadError) {
    return jsonResponse({ error: uploadError.message }, 400);
  }

  const { data: anexo, error: rpcError } = await requestClient.rpc("demandas_registrar_anexo", {
    p_demanda_id: demandaId,
    p_storage_path: storagePath,
    p_etapa: etapa,
    p_mime: mime,
    p_tamanho_bytes: bytes.byteLength,
  });

  if (rpcError) {
    await admin.storage.from(BUCKET).remove([storagePath]);
    return jsonResponse({ error: rpcError.message }, 400);
  }

  return jsonResponse({ ok: true, anexo });
});
