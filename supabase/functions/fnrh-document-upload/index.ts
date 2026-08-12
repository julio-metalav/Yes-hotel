/**
 * FNRH v2 — upload de documento do hóspede (público via guest_id+token).
 * Multipart FormData preferencial; JSON base64 aceito como fallback.
 * Grava em bucket privado fnrh-documents e operacional_fnrh_documentos.
 * OCR Azure opcional (flag + telemetria/idempotência sem PII).
 * Nunca loga PII, token, blob, key, bytes, signed URL ou Operation-Location.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isFnrhOcrEnabled } from "../../../src/lib/domain/yes-hotel/fnrh-checkin-v2-policy.ts";
import {
  FNRH_OCR_AZURE_API_VERSION,
  FNRH_OCR_AZURE_MODEL,
  FNRH_OCR_MAX_ATTEMPTS_PER_GUEST_JOURNEY,
} from "../../../src/lib/domain/yes-hotel/fnrh-ocr-confidence.ts";
import {
  canRunNewOcrAttempt,
  sha256HexOfBytes,
} from "../../../src/lib/domain/yes-hotel/fnrh-ocr-idempotency.ts";
import {
  createFnrhOcrProvider,
  resolveFnrhOcrProviderName,
  type FnrhOcrResult,
} from "../../../src/lib/domain/yes-hotel/fnrh-ocr-port.ts";

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

function skippedOcrResult(reason: string, provider: string, model: string): FnrhOcrResult {
  return {
    ok: true,
    provider,
    model,
    api_version: FNRH_OCR_AZURE_API_VERSION,
    suggested_fields: {},
    confidence: {},
    field_bands: {},
    needs_review_fields: [],
    provenance: "ocr",
    skipped: true,
    reason,
    pages_processed: 0,
    analyzed_at: new Date().toISOString(),
  };
}

async function countGuestOcrAttempts(guestId: string): Promise<number> {
  const { count, error } = await admin
    .from("operacional_fnrh_ocr_runs")
    .select("id", { count: "exact", head: true })
    .eq("guest_id", guestId)
    .eq("skipped", false);
  if (error) {
    console.warn("[fnrh-document-upload] ocr attempts count failed");
    return 0;
  }
  return count ?? 0;
}

async function hasIdempotentOcrSuccess(input: {
  documentId: string;
  guestId: string;
  contentHash: string;
  provider: string;
  model: string;
}): Promise<boolean> {
  const { data: byDoc, error: docErr } = await admin
    .from("operacional_fnrh_ocr_runs")
    .select("id")
    .eq("document_id", input.documentId)
    .eq("provider", input.provider)
    .eq("model", input.model)
    .eq("content_hash", input.contentHash)
    .eq("success", true)
    .limit(1)
    .maybeSingle();
  if (docErr) {
    console.warn("[fnrh-document-upload] ocr idempotent doc lookup failed");
  } else if (byDoc) {
    return true;
  }

  const { data: byGuest, error: guestErr } = await admin
    .from("operacional_fnrh_ocr_runs")
    .select("id")
    .eq("guest_id", input.guestId)
    .eq("provider", input.provider)
    .eq("model", input.model)
    .eq("content_hash", input.contentHash)
    .eq("success", true)
    .limit(1)
    .maybeSingle();
  if (guestErr) {
    console.warn("[fnrh-document-upload] ocr idempotent guest lookup failed");
    return false;
  }
  return !!byGuest;
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
    .select("id, storage_ref, metadata_sanitized")
    .maybeSingle();

  if (insErr || !inserted) {
    console.warn("[fnrh-document-upload] insert documento failed");
    await admin.storage.from(BUCKET).remove([objectPath]).catch(() => {});
    return jsonResponse({ ok: false, error: "Falha ao registrar documento." }, 500);
  }

  const documentId = (inserted as { id: string }).id;
  const contentHash = await sha256HexOfBytes(bytes);
  const ocrEnabled = isFnrhOcrEnabled(Deno.env.get("FNRH_OCR_ENABLED"));

  if (!ocrEnabled) {
    return jsonResponse({
      ok: true,
      document_id: documentId,
      storage_ref: objectPath,
      suggested_fields: {},
      confidence: {},
      provenance: null,
      ocr_skipped: true,
    });
  }

  const configuredProvider = resolveFnrhOcrProviderName(Deno.env.get("FNRH_OCR_PROVIDER"));
  const model = FNRH_OCR_AZURE_MODEL;
  const priorAttempts = await countGuestOcrAttempts(docGuestId);
  const hasSuccessfulIdempotentHit = await hasIdempotentOcrSuccess({
    documentId,
    guestId: docGuestId,
    contentHash,
    provider: configuredProvider === "azure" ? "azure" : "noop",
    model,
  });
  const gate = canRunNewOcrAttempt({
    priorAttempts,
    maxAttempts: FNRH_OCR_MAX_ATTEMPTS_PER_GUEST_JOURNEY,
    hasSuccessfulIdempotentHit,
  });

  let ocr: FnrhOcrResult;
  if (!gate.allowed) {
    ocr = skippedOcrResult(
      gate.reason ?? "ocr_skipped",
      configuredProvider === "azure" ? "azure" : "noop",
      model,
    );
  } else {
    const provider = createFnrhOcrProvider({
      enabled: true,
      provider: Deno.env.get("FNRH_OCR_PROVIDER"),
      azureEndpoint: Deno.env.get("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT"),
      azureKey: Deno.env.get("AZURE_DOCUMENT_INTELLIGENCE_KEY"),
    });
    ocr = await provider.extract({
      bytes,
      storage_ref: objectPath,
      document_type: documentType,
      side: sidePart === "front" || sidePart === "back" || sidePart === "single" ? sidePart : "single",
      mime_type: mimeType,
      document_id: documentId,
      reservation_id: row.reserva_id,
      guest_id: docGuestId,
      content_hash: contentHash,
    });
  }

  const ocrSuccess = ocr.ok === true && ocr.skipped !== true;
  const ocrProvider = ocr.provider || (configuredProvider === "azure" ? "azure" : "noop");
  const ocrModel = ocr.model || model;
  const ocrApiVersion = ocr.api_version || FNRH_OCR_AZURE_API_VERSION;
  const pagesProcessed = Number.isFinite(ocr.pages_processed) ? Number(ocr.pages_processed) : 0;
  const analyzedAt = ocr.analyzed_at || new Date().toISOString();
  const needsReview = Array.isArray(ocr.needs_review_fields) ? ocr.needs_review_fields : [];

  const { error: runErr } = await admin.from("operacional_fnrh_ocr_runs").insert({
    reservation_id: row.reserva_id,
    guest_id: docGuestId,
    document_id: documentId,
    content_hash: contentHash,
    provider: ocrProvider,
    model: ocrModel,
    api_version: ocrApiVersion,
    pages_processed: pagesProcessed,
    success: ocrSuccess,
    skipped: ocr.skipped === true,
    duration_ms: ocr.duration_ms ?? null,
    document_type: documentType,
    error_code: ocr.reason ?? null,
  });
  if (runErr) {
    console.warn("[fnrh-document-upload] ocr run insert failed");
  }

  const prevMeta =
    (inserted as { metadata_sanitized?: Record<string, unknown> | null }).metadata_sanitized &&
      typeof (inserted as { metadata_sanitized?: unknown }).metadata_sanitized === "object"
      ? { ...(inserted as { metadata_sanitized: Record<string, unknown> }).metadata_sanitized }
      : {
        side: sidePart,
        mime_type: mimeType,
        bytes: bytes.byteLength,
      };

  const { error: metaErr } = await admin
    .from("operacional_fnrh_documentos")
    .update({
      metadata_sanitized: {
        ...prevMeta,
        ocr: {
          provider: ocrProvider,
          model: ocrModel,
          skipped: ocr.skipped === true,
          success: ocrSuccess,
          pages_processed: pagesProcessed,
          analyzed_at: analyzedAt,
          needs_review_fields: needsReview,
        },
      },
    })
    .eq("id", documentId);
  if (metaErr) {
    console.warn("[fnrh-document-upload] metadata_sanitized ocr merge failed");
  }

  return jsonResponse({
    ok: true,
    document_id: documentId,
    storage_ref: objectPath,
    suggested_fields: ocr.suggested_fields ?? {},
    confidence: ocr.confidence ?? {},
    field_bands: ocr.field_bands ?? {},
    needs_review_fields: needsReview,
    provenance: ocr.provenance ?? "ocr",
    ocr_skipped: ocr.skipped === true,
    ocr_reason: ocr.reason ?? null,
    provider: ocrProvider,
    model: ocrModel,
  });
});
