/**
 * FNRH v2 — upload de documento do hóspede (público via guest_id+token).
 * Multipart FormData preferencial; JSON base64 aceito como fallback.
 * Grava em bucket privado fnrh-documents e operacional_fnrh_documentos.
 * Nunca loga PII, token, blob ou signed URL.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isFnrhOcrEnabled } from "../../../src/lib/domain/yes-hotel/fnrh-checkin-v2-policy.ts";
import { createFnrhOcrProvider } from "../../../src/lib/domain/yes-hotel/fnrh-ocr-port.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const BUCKET = "fnrh-documents";
const MAX_BYTES = 10 * 1024 * 1024;

const ALLOWED_TYPES = new Set([
  "cpf",
  "rg",
  "cnh",
  "passport",
  "birth_certificate",
  "travel_authorization",
  "other",
]);

const ALLOWED_SUBJECTS = new Set([
  "guest",
  "minor",
  "responsible",
  "travel_authorization",
]);

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function ensureString(v: unknown, def = ""): string {
  if (v == null) return def;
  return String(v).trim();
}

function extFromMime(mime: string): string {
  switch (mime) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "application/pdf":
      return "pdf";
    default:
      return "bin";
  }
}

function normalizeMime(mime: string, fileName: string): string {
  const m = mime.toLowerCase().trim();
  if (ALLOWED_MIME.has(m)) return m === "image/jpg" ? "image/jpeg" : m;
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return m;
}

function decodeBase64Payload(raw: string): Uint8Array {
  const trimmed = raw.trim();
  const comma = trimmed.indexOf(",");
  const b64 = trimmed.startsWith("data:") && comma >= 0 ? trimmed.slice(comma + 1) : trimmed;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function resolveFnrhByToken(
  publicKey: string,
  token: string,
): Promise<{ id: string; reserva_id: string; hospede_id: string; status: string } | null> {
  const sel = "id, reserva_id, hospede_id, status";
  const { data: byFnrhId } = await admin
    .from("fnrh_hospedes")
    .select(sel)
    .eq("id", publicKey)
    .eq("link_token", token)
    .maybeSingle();
  if (byFnrhId) return byFnrhId as { id: string; reserva_id: string; hospede_id: string; status: string };
  const { data: byHospedeId } = await admin
    .from("fnrh_hospedes")
    .select(sel)
    .eq("hospede_id", publicKey)
    .eq("link_token", token)
    .maybeSingle();
  return (byHospedeId as { id: string; reserva_id: string; hospede_id: string; status: string } | null) ??
    null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Método não permitido." }, 405);
  }

  let guestId = "";
  let token = "";
  let documentType = "";
  let documentSubject = "guest";
  let side = "";
  let targetGuestId = "";
  let bytes: Uint8Array | null = null;
  let mimeType = "application/octet-stream";
  let fileName = "upload.bin";

  const contentType = req.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      guestId = ensureString(form.get("guest_id") ?? form.get("hospede_id"));
      token = ensureString(form.get("token"));
      documentType = ensureString(form.get("document_type")).toLowerCase();
      documentSubject = ensureString(form.get("document_subject") || "guest").toLowerCase();
      side = ensureString(form.get("side")).toLowerCase();
      targetGuestId = ensureString(form.get("target_guest_id"));
      const file = form.get("file");
      if (file && typeof file === "object" && "arrayBuffer" in file) {
        const f = file as File;
        fileName = f.name || fileName;
        mimeType = normalizeMime(f.type || "", fileName);
        const buf = new Uint8Array(await f.arrayBuffer());
        bytes = buf;
      }
    } else {
      const body = (await req.json()) as Record<string, unknown>;
      guestId = ensureString(body.guest_id ?? body.hospede_id);
      token = ensureString(body.token);
      documentType = ensureString(body.document_type).toLowerCase();
      documentSubject = ensureString(body.document_subject || "guest").toLowerCase();
      side = ensureString(body.side).toLowerCase();
      targetGuestId = ensureString(body.target_guest_id);
      mimeType = normalizeMime(ensureString(body.mime_type || body.content_type), ensureString(body.file_name));
      fileName = ensureString(body.file_name) || `upload.${extFromMime(mimeType)}`;
      const b64 = ensureString(body.file_base64 ?? body.base64);
      if (b64) bytes = decodeBase64Payload(b64);
    }
  } catch {
    return jsonResponse({ ok: false, error: "Payload inválido." }, 400);
  }

  if (!guestId || !token) {
    return jsonResponse({ ok: false, error: "guest_id e token são obrigatórios." }, 400);
  }
  if (!ALLOWED_TYPES.has(documentType)) {
    return jsonResponse({ ok: false, error: "document_type inválido." }, 400);
  }
  if (!ALLOWED_SUBJECTS.has(documentSubject)) {
    return jsonResponse({ ok: false, error: "document_subject inválido." }, 400);
  }
  if (!bytes || bytes.byteLength === 0) {
    return jsonResponse({ ok: false, error: "Arquivo obrigatório." }, 400);
  }
  if (bytes.byteLength > MAX_BYTES) {
    return jsonResponse({ ok: false, error: "Arquivo excede 10MB." }, 400);
  }
  if (!ALLOWED_MIME.has(mimeType)) {
    return jsonResponse({ ok: false, error: "MIME type não permitido." }, 400);
  }

  const row = await resolveFnrhByToken(guestId, token);
  if (!row) {
    return jsonResponse({ ok: false, error: "Link inválido ou expirado." }, 404);
  }

  // Por padrão o documento é do próprio hóspede do token.
  // target_guest_id permite responsável anexar doc de menor da mesma reserva.
  let docGuestId = row.hospede_id;
  if (targetGuestId && targetGuestId !== row.hospede_id) {
    const { data: target } = await admin
      .from("operacional_hospedes")
      .select("id, reserva_id, guest_role, responsible_guest_id, is_minor")
      .eq("id", targetGuestId)
      .maybeSingle();
    const t = target as {
      id: string;
      reserva_id?: string;
      guest_role?: string | null;
      responsible_guest_id?: string | null;
      is_minor?: boolean | null;
    } | null;
    if (!t || t.reserva_id !== row.reserva_id) {
      return jsonResponse({ ok: false, error: "target_guest_id inválido para esta reserva." }, 400);
    }
    const isMinorTarget = t.guest_role === "minor" || t.is_minor === true;
    if (!isMinorTarget || t.responsible_guest_id !== row.hospede_id) {
      return jsonResponse({
        ok: false,
        error: "Somente o responsável pode enviar documento de menor.",
      }, 403);
    }
    docGuestId = t.id;
    if (documentSubject === "guest") documentSubject = "minor";
  }

  const sidePart = side === "front" || side === "back" || side === "single" ? side : "single";
  const ext = extFromMime(mimeType);
  const objectPath = `${row.reserva_id}/${docGuestId}/${crypto.randomUUID()}-${sidePart}.${ext}`;

  const { error: upErr } = await admin.storage.from(BUCKET).upload(objectPath, bytes, {
    contentType: mimeType,
    upsert: false,
  });
  if (upErr) {
    console.warn("[fnrh-document-upload] storage upload failed");
    return jsonResponse({ ok: false, error: "Falha ao enviar arquivo." }, 500);
  }

  const { data: inserted, error: insErr } = await admin
    .from("operacional_fnrh_documentos")
    .insert({
      reservation_id: row.reserva_id,
      guest_id: docGuestId,
      document_subject: documentSubject,
      document_type: documentType,
      validation_status: "pending",
      data_origin: "guest",
      storage_ref: objectPath,
      metadata_sanitized: {
        side: sidePart,
        mime_type: mimeType,
        bytes: bytes.byteLength,
      },
    })
    .select("id, storage_ref")
    .maybeSingle();

  if (insErr || !inserted) {
    console.warn("[fnrh-document-upload] insert documento failed");
    // Best-effort cleanup sem logar path completo sensível além do necessário
    await admin.storage.from(BUCKET).remove([objectPath]).catch(() => {});
    return jsonResponse({ ok: false, error: "Falha ao registrar documento." }, 500);
  }

  const ocrEnabled = isFnrhOcrEnabled(Deno.env.get("FNRH_OCR_ENABLED"));
  let suggested_fields: Record<string, string> = {};
  let confidence: Record<string, number> = {};
  let provenance: "ocr" | null = null;
  let ocr_skipped = true;

  if (ocrEnabled) {
    const provider = createFnrhOcrProvider(true);
    const ocr = await provider.extract({
      storage_ref: objectPath,
      document_type: documentType,
      side: sidePart === "front" || sidePart === "back" || sidePart === "single" ? sidePart : "single",
      mime_type: mimeType,
    });
    suggested_fields = (ocr.suggested_fields ?? {}) as Record<string, string>;
    confidence = ocr.confidence ?? {};
    provenance = ocr.provenance;
    ocr_skipped = ocr.skipped === true;
  }

  return jsonResponse({
    ok: true,
    document_id: (inserted as { id: string }).id,
    storage_ref: objectPath,
    suggested_fields,
    confidence,
    provenance,
    ocr_skipped,
  });
});
