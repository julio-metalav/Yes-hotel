/**
 * Upload privado de fotos de Demandas.
 * Autentica, autoriza a demanda, valida magic bytes e só então grava no bucket.
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
const ALLOWED_ETAPAS = new Set(["antes", "durante", "finalizacao", "correcao"]);
const JPEG_SOI = [0xff, 0xd8, 0xff];
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) {
    return false;
  }
  return sig.every((value, index) => bytes[index] === value);
}

function isWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 12) {
    return false;
  }
  return (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function looksLikeMarkup(bytes: Uint8Array): boolean {
  let offset = 0;
  while (
    offset < bytes.length &&
    (bytes[offset] === 0x20 ||
      bytes[offset] === 0x09 ||
      bytes[offset] === 0x0a ||
      bytes[offset] === 0x0d)
  ) {
    offset += 1;
  }
  if (offset >= bytes.length || bytes[offset] !== 0x3c) {
    return false;
  }
  const head = String.fromCharCode(
    ...bytes.slice(offset, Math.min(bytes.length, offset + 64)),
  ).toLowerCase();
  return (
    head.startsWith("<svg") ||
    head.startsWith("<?xml") ||
    head.startsWith("<!doctype") ||
    head.startsWith("<html") ||
    head.startsWith("<script") ||
    head.startsWith("<img")
  );
}

function detectImage(bytes: Uint8Array): { mime: string; ext: string } | null {
  if (looksLikeMarkup(bytes)) {
    return null;
  }
  if (startsWith(bytes, JPEG_SOI)) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (startsWith(bytes, PNG_SIG)) {
    return { mime: "image/png", ext: "png" };
  }
  if (isWebp(bytes)) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

function estimateBase64DecodedBytes(base64: string): number {
  const padded = base64.replace(/\s/g, "");
  const padding = padded.endsWith("==") ? 2 : padded.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((padded.length * 3) / 4) - padding);
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
      if (file.size <= 0 || file.size > MAX_BYTES) {
        return jsonResponse({ error: "demandas_arquivo_grande" }, 400);
      }
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      const body = (await request.json()) as Record<string, unknown>;
      demandaId = String(body.demanda_id ?? "").trim();
      etapa = String(body.etapa ?? "durante").trim();
      const base64 = String(body.base64 ?? "").replace(/^data:[^;]+;base64,/, "");
      if (estimateBase64DecodedBytes(base64) > MAX_BYTES) {
        return jsonResponse({ error: "demandas_arquivo_grande" }, 400);
      }
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
  if (!bytes || bytes.byteLength <= 0 || bytes.byteLength > MAX_BYTES) {
    return jsonResponse({ error: "demandas_arquivo_grande" }, 400);
  }

  const detected = detectImage(bytes);
  if (!detected) {
    return jsonResponse({ error: "demandas_mime_invalido" }, 400);
  }

  const { data: authz, error: authzError } = await requestClient.rpc("demandas_autorizar_anexo", {
    p_demanda_id: demandaId,
    p_etapa: etapa,
  });

  if (authzError || !authz || authz.ok !== true) {
    return jsonResponse(
      { error: authzError?.message || "demandas_forbidden" },
      403,
    );
  }

  const anexoId = crypto.randomUUID();
  const storagePath = `${demandaId}/${anexoId}.${detected.ext}`;

  const { error: uploadError } = await admin.storage.from(BUCKET).upload(storagePath, bytes, {
    contentType: detected.mime,
    upsert: false,
  });

  if (uploadError) {
    return jsonResponse({ error: uploadError.message }, 400);
  }

  const { data: anexo, error: rpcError } = await requestClient.rpc("demandas_registrar_anexo", {
    p_demanda_id: demandaId,
    p_storage_path: storagePath,
    p_etapa: etapa,
    p_mime: detected.mime,
    p_tamanho_bytes: bytes.byteLength,
  });

  if (rpcError) {
    const { error: removeError } = await admin.storage.from(BUCKET).remove([storagePath]);
    if (removeError) {
      return jsonResponse(
        {
          error: rpcError.message,
          cleanup: "demandas_cleanup_falhou",
          cleanup_detail: removeError.message,
          orphan_path: storagePath,
        },
        400,
      );
    }
    return jsonResponse({ error: rpcError.message }, 400);
  }

  return jsonResponse({ ok: true, anexo });
});
