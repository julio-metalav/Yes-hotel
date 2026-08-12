/**
 * FNRH digital — público (token).
 * POST action "draft" | "confirm" (omitido = confirm, compatível com fluxo antigo).
 * Branch por flow_version (body.flow_version || row.flow_version):
 * - v2 draft: autosave campos v2, status=rascunho, sem assinatura
 * - v2 confirm: validação policy, documento em storage, snapshot SHA-256, sem canvas
 * - legacy confirm: assinatura_base64 obrigatória (comportamento existente)
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  composeDocumentoLegado,
  composeEnderecoLegado,
  FNRH_PRIVACY_NOTICE_VERSION,
  FNRH_TERMS_VERSION,
  FNRH_V2_SCHEMA_VERSION,
  validateFnrhCheckinV2Confirm,
  type FnrhCheckinV2Draft,
} from "../../../src/lib/domain/yes-hotel/fnrh-checkin-v2-policy.ts";
import { buildConfirmationProof } from "../../../src/lib/domain/yes-hotel/fnrh-confirmation-snapshot.ts";
import {
  buildConfirmFieldProvenance,
  mergeFieldProvenance,
  type FnrhFieldProvenanceMap,
} from "../../../src/lib/domain/yes-hotel/fnrh-field-provenance.ts";
import {
  assertAuditPayloadSafe,
  sanitizeFnrhAuditState,
} from "../../../src/lib/domain/yes-hotel/fnrh-audit-sanitize.ts";
import {
  type FnrhLifecycleStatus,
  type GuestRoleDb,
} from "../../../src/lib/domain/yes-hotel/fnrh-completion-policy.ts";
import { evaluateReservationFnrhState } from "../../../src/lib/domain/yes-hotel/reservation-fnrh-state.ts";
import {
  isFinanceiroLiberadoParaAcesso,
} from "../../../src/lib/domain/yes-hotel/guest-access-messages.ts";

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

const STATUS_FINAL_HOSPEDE = new Set([
  "preenchido",
  "confirmado_hospede",
  "enviado_oficial",
  "erro_sincronizacao",
]);

const STATUS_CONTA_FNrh_COMPLETO = [
  "confirmado_hospede",
  "enviado_oficial",
  "erro_sincronizacao",
  "preenchido",
];

const LIFECYCLE_COMPLETE = new Set([
  "completed",
  "manually_completed",
  "waived",
]);

const LEGACY_DRAFT_KEYS = [
  "hospede_nome",
  "documento",
  "data_nascimento",
  "nacionalidade",
  "endereco",
  "telefone",
  "email",
  "procedencia",
  "destino",
  "placa_veiculo",
  "cor_veiculo",
  "modelo_veiculo",
  "assinatura_base64",
] as const;

const V2_DRAFT_KEYS = [
  "hospede_nome",
  "nome_social",
  "sexo",
  "documento",
  "documento_tipo",
  "documento_numero",
  "orgao_emissor",
  "pais_emissor",
  "documento_validade",
  "data_nascimento",
  "nacionalidade",
  "endereco",
  "cep",
  "logradouro",
  "numero",
  "complemento",
  "bairro",
  "cidade",
  "uf",
  "pais",
  "endereco_estrangeiro",
  "telefone",
  "email",
  "procedencia",
  "destino",
  "motivo_viagem",
  "meio_transporte",
  "placa_veiculo",
  "cor_veiculo",
  "modelo_veiculo",
  "data_confirmed",
  "privacy_accepted",
  "terms_version",
  "privacy_notice_version",
  "minor_relation",
  "minor_relation_other",
  "minor_accompaniment",
] as const;

const BOOL_KEYS = new Set(["data_confirmed", "privacy_accepted"]);
const DATE_KEYS = new Set(["data_nascimento", "documento_validade"]);

type FnrhRow = {
  id: string;
  reserva_id: string;
  hospede_id: string;
  status: string;
  flow_version?: string | null;
  fnrh_lifecycle_status?: string | null;
  field_provenance?: FnrhFieldProvenanceMap | null;
};

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

function ensureDate(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : s.slice(0, 10);
}

function ensureBool(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

function clientIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first.slice(0, 128);
  }
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  return cf ? cf.slice(0, 128) : null;
}

function resolveRequestedFlow(
  body: Record<string, unknown>,
  row: FnrhRow,
): "legacy" | "v2" {
  const fromBody = ensureString(body.flow_version).toLowerCase();
  if (fromBody === "v2" || fromBody === "legacy") return fromBody;
  const fromRow = ensureString(row.flow_version).toLowerCase();
  if (fromRow === "v2") return "v2";
  // Espelha fnrh-get: pendente (default DB legacy) → v2; rascunho legado permanece legacy.
  const st = ensureString(row.status);
  if (st === "pendente" || st === "pendente_confirmacao" || st === "") return "v2";
  return "legacy";
}

async function resolveFnrhRow(
  publicKey: string,
  token: string,
): Promise<{ row: FnrhRow | null; error?: string }> {
  const sel =
    "id, reserva_id, hospede_id, status, flow_version, fnrh_lifecycle_status, field_provenance";
  let row: FnrhRow | null = null;
  const { data: byFnrhId, error: errId } = await admin
    .from("fnrh_hospedes")
    .select(sel)
    .eq("id", publicKey)
    .eq("link_token", token)
    .maybeSingle();
  if (errId) return { row: null, error: "Falha ao validar link." };
  if (byFnrhId) row = byFnrhId as FnrhRow;
  if (!row) {
    const { data: byHospedeId, error: errH } = await admin
      .from("fnrh_hospedes")
      .select(sel)
      .eq("hospede_id", publicKey)
      .eq("link_token", token)
      .maybeSingle();
    if (errH) return { row: null, error: "Falha ao validar link." };
    if (byHospedeId) row = byHospedeId as FnrhRow;
  }
  return { row };
}

function applyDraftFields(
  body: Record<string, unknown>,
  keys: readonly string[],
): { update: Record<string, unknown>; provenanceUpdates: FnrhFieldProvenanceMap } {
  const update: Record<string, unknown> = {};
  const provenanceUpdates: FnrhFieldProvenanceMap = {};
  for (const k of keys) {
    if (!(k in body)) continue;
    const v = body[k];
    if (DATE_KEYS.has(k)) {
      update[k] = ensureDate(v);
    } else if (BOOL_KEYS.has(k)) {
      update[k] = ensureBool(v);
    } else if (k === "assinatura_base64") {
      update[k] = v != null && String(v).trim() !== "" ? String(v) : null;
    } else {
      update[k] = v != null ? String(v) : "";
    }
    provenanceUpdates[k] = "manual";
  }
  return { update, provenanceUpdates };
}

function draftFromRowAndBody(
  rowData: Record<string, unknown>,
  body: Record<string, unknown>,
  opts: { is_minor: boolean; responsible_guest_id: string | null; has_document_upload: boolean },
): FnrhCheckinV2Draft {
  const pick = (key: string): string | null => {
    if (key in body && body[key] != null && String(body[key]).trim() !== "") {
      return String(body[key]).trim();
    }
    const v = rowData[key];
    if (v == null) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
  };
  const pickBool = (key: string): boolean => {
    if (key in body) return ensureBool(body[key]);
    return rowData[key] === true;
  };
  return {
    documento_tipo: pick("documento_tipo"),
    documento_numero: pick("documento_numero"),
    documento: pick("documento"),
    data_nascimento: pick("data_nascimento") ?? ensureDate(body.data_nascimento ?? rowData.data_nascimento),
    hospede_nome: pick("hospede_nome"),
    nome_social: pick("nome_social"),
    sexo: pick("sexo"),
    nacionalidade: pick("nacionalidade"),
    orgao_emissor: pick("orgao_emissor"),
    pais_emissor: pick("pais_emissor"),
    cep: pick("cep"),
    logradouro: pick("logradouro"),
    numero: pick("numero"),
    complemento: pick("complemento"),
    bairro: pick("bairro"),
    cidade: pick("cidade"),
    uf: pick("uf"),
    pais: pick("pais"),
    endereco_estrangeiro: pick("endereco_estrangeiro"),
    endereco: pick("endereco"),
    telefone: pick("telefone"),
    email: pick("email"),
    procedencia: pick("procedencia"),
    destino: pick("destino"),
    motivo_viagem: pick("motivo_viagem"),
    meio_transporte: pick("meio_transporte"),
    placa_veiculo: pick("placa_veiculo"),
    cor_veiculo: pick("cor_veiculo"),
    modelo_veiculo: pick("modelo_veiculo"),
    data_confirmed: pickBool("data_confirmed"),
    privacy_accepted: pickBool("privacy_accepted"),
    terms_version: pick("terms_version") ?? FNRH_TERMS_VERSION,
    privacy_notice_version: pick("privacy_notice_version") ?? FNRH_PRIVACY_NOTICE_VERSION,
    has_document_upload: opts.has_document_upload,
    is_minor: opts.is_minor,
    minor_relation: pick("minor_relation"),
    minor_relation_other: pick("minor_relation_other"),
    minor_accompaniment: pick("minor_accompaniment"),
    responsible_guest_id: opts.responsible_guest_id,
  };
}

function v2UpdateFromDraft(draft: FnrhCheckinV2Draft, now: string): Record<string, unknown> {
  const enderecoLegado = composeEnderecoLegado(draft);
  const documentoLegado = composeDocumentoLegado(draft);
  return {
    hospede_nome: draft.hospede_nome ?? "",
    nome_social: draft.nome_social ?? null,
    sexo: draft.sexo ?? null,
    documento_tipo: draft.documento_tipo ?? null,
    documento_numero: draft.documento_numero ?? null,
    documento: documentoLegado,
    orgao_emissor: draft.orgao_emissor ?? null,
    pais_emissor: draft.pais_emissor ?? null,
    data_nascimento: ensureDate(draft.data_nascimento),
    nacionalidade: draft.nacionalidade ?? "",
    cep: draft.cep ?? null,
    logradouro: draft.logradouro ?? null,
    numero: draft.numero ?? null,
    complemento: draft.complemento ?? null,
    bairro: draft.bairro ?? null,
    cidade: draft.cidade ?? null,
    uf: draft.uf ?? null,
    pais: draft.pais ?? null,
    endereco_estrangeiro: draft.endereco_estrangeiro ?? null,
    endereco: enderecoLegado,
    telefone: draft.telefone ?? "",
    email: draft.email ?? "",
    procedencia: draft.procedencia ?? "",
    destino: draft.destino ?? "",
    motivo_viagem: draft.motivo_viagem ?? null,
    meio_transporte: draft.meio_transporte ?? null,
    placa_veiculo: draft.placa_veiculo ?? "",
    cor_veiculo: draft.cor_veiculo ?? "",
    modelo_veiculo: draft.modelo_veiculo ?? "",
    data_confirmed: draft.data_confirmed === true,
    privacy_accepted: draft.privacy_accepted === true,
    terms_version: draft.terms_version ?? FNRH_TERMS_VERSION,
    privacy_notice_version: draft.privacy_notice_version ?? FNRH_PRIVACY_NOTICE_VERSION,
    terms_accepted_at: now,
    minor_relation: draft.minor_relation ?? null,
    minor_relation_other: draft.minor_relation_other ?? null,
    minor_accompaniment: draft.minor_accompaniment ?? null,
    flow_version: "v2",
    updated_at: now,
  };
}

async function guestHasDocumentUpload(guestId: string, reservationId: string): Promise<boolean> {
  const { data } = await admin
    .from("operacional_fnrh_documentos")
    .select("id, storage_ref")
    .eq("guest_id", guestId)
    .eq("reservation_id", reservationId)
    .not("storage_ref", "is", null)
    .limit(20);
  return (data ?? []).some((d: { storage_ref?: string | null }) =>
    Boolean(d.storage_ref && String(d.storage_ref).trim())
  );
}

async function loadGuestDocsForSnapshot(
  guestId: string,
  reservationId: string,
): Promise<Array<{ id: string; document_type: string; document_subject: string; storage_ref: string }>> {
  const { data } = await admin
    .from("operacional_fnrh_documentos")
    .select("id, document_type, document_subject, storage_ref")
    .eq("guest_id", guestId)
    .eq("reservation_id", reservationId)
    .not("storage_ref", "is", null);
  return (data ?? [])
    .filter((d: Record<string, unknown>) => Boolean(ensureString(d.storage_ref)))
    .map((d: Record<string, unknown>) => ({
      id: String(d.id),
      document_type: String(d.document_type),
      document_subject: String(d.document_subject),
      storage_ref: String(d.storage_ref),
    }));
}

async function writeFnrhConfirmedAudit(input: {
  reservation_id: string;
  guest_id: string;
  actor_guest_id: string;
  actor_type: "guest" | "responsible";
  previous_state: Record<string, unknown>;
  new_state: Record<string, unknown>;
}): Promise<void> {
  const previous_state = sanitizeFnrhAuditState(input.previous_state);
  const new_state = sanitizeFnrhAuditState(input.new_state);
  assertAuditPayloadSafe(previous_state);
  assertAuditPayloadSafe(new_state);
  const { error } = await admin.from("operacional_fnrh_auditoria").insert({
    reservation_id: input.reservation_id,
    guest_id: input.guest_id,
    event_type: "fnrh_confirmed",
    previous_state,
    new_state,
    actor_type: input.actor_type,
    actor_guest_id: input.actor_guest_id,
    source: "fnrh-submit",
  });
  if (error) {
    console.warn("[fnrh-submit] auditoria fnrh_confirmed falhou:", error.message);
  }
}

async function syncLegadoAgregado(reservaId: string, now: string): Promise<string> {
  const { count: total } = await admin
    .from("fnrh_hospedes")
    .select("id", { count: "exact", head: true })
    .eq("reserva_id", reservaId);
  const { count: completos } = await admin
    .from("fnrh_hospedes")
    .select("id", { count: "exact", head: true })
    .eq("reserva_id", reservaId)
    .in("status", STATUS_CONTA_FNrh_COMPLETO);

  let agregado =
    (completos ?? 0) === 0
      ? "fnrh_pendente"
      : (completos ?? 0) < (total ?? 0)
      ? "fnrh_parcial"
      : "fnrh_completo";

  // Quando há guest_role classificado, também avalia policy formal.
  const { data: hospedes } = await admin
    .from("operacional_hospedes")
    .select(
      "id, guest_role, responsible_guest_id, fnrh_required, removed_from_reservation, requires_classification, email, whatsapp",
    )
    .eq("reserva_id", reservaId);

  const classified = (hospedes ?? []).filter(
    (h: { guest_role?: string | null }) =>
      h.guest_role && h.guest_role !== "legacy_unclassified",
  );

  if (classified.length > 0) {
    const guestIds = (hospedes ?? []).map((h: { id: string }) => h.id);
    const { data: fnrhRows } = await admin
      .from("fnrh_hospedes")
      .select(
        "hospede_id, fnrh_lifecycle_status, status, confirmation_source, completed_by_guest_id, completed_by_user_id, manual_completion_reason, waived_reason, has_required_core_fields, has_required_documents",
      )
      .eq("reserva_id", reservaId)
      .in("hospede_id", guestIds);

    const fnrhByGuest = new Map<string, Record<string, unknown>>();
    for (const f of fnrhRows ?? []) {
      fnrhByGuest.set(String((f as { hospede_id: string }).hospede_id), f as Record<string, unknown>);
    }

    const snapshots = (hospedes ?? []).map((h: Record<string, unknown>) => {
      const f = fnrhByGuest.get(String(h.id)) ?? {};
      const email = ensureString(h.email);
      const whatsapp = ensureString(h.whatsapp);
      let lifecycle = (f.fnrh_lifecycle_status as FnrhLifecycleStatus | null) ?? null;
      if (!lifecycle && STATUS_CONTA_FNrh_COMPLETO.includes(String(f.status ?? ""))) {
        lifecycle = "completed";
      }
      return {
        guest_id: String(h.id),
        guest_role: (h.guest_role as GuestRoleDb) ?? null,
        fnrh_required: h.fnrh_required !== false,
        fnrh_status: lifecycle,
        responsible_guest_id: (h.responsible_guest_id as string | null) ?? null,
        completed_by_guest_id: (f.completed_by_guest_id as string | null) ?? null,
        completed_by_user_id: (f.completed_by_user_id as string | null) ?? null,
        confirmation_source: (f.confirmation_source as
          | "guest"
          | "responsible"
          | "reception"
          | "migration"
          | null) ?? null,
        manual_completion_reason: (f.manual_completion_reason as string | null) ?? null,
        waived_reason: (f.waived_reason as string | null) ?? null,
        has_required_core_fields: f.has_required_core_fields === true,
        has_required_documents: f.has_required_documents === true,
        has_contact_channel: Boolean(email || whatsapp),
        requires_classification:
          h.requires_classification === true ||
          h.guest_role == null ||
          h.guest_role === "legacy_unclassified",
        is_removed_from_reservation: h.removed_from_reservation === true,
      };
    });

    const state = evaluateReservationFnrhState(snapshots);
    if (state.all_required_complete) {
      agregado = "fnrh_completo";
    } else if (state.completed_fnrhs > 0) {
      agregado = "fnrh_parcial";
    } else if (state.required_fnrhs > 0) {
      agregado = "fnrh_pendente";
    }
  }

  await admin
    .from("operacional_reservas")
    .update({ fnrh_status_agregado: agregado, updated_at: now })
    .eq("id", reservaId);

  return agregado;
}

async function confirmV2Guest(input: {
  fnrhId: string;
  reservaId: string;
  guestId: string;
  actorGuestId: string;
  confirmationSource: "guest" | "responsible";
  draft: FnrhCheckinV2Draft;
  docs: Array<{ id: string; document_type: string; document_subject: string; storage_ref: string }>;
  minorsForSnapshot?: Array<{
    guest_id: string;
    hospede_nome?: string;
    minor_relation?: string | null;
    minor_accompaniment?: string | null;
  }>;
  previousState: Record<string, unknown>;
  /** Provenance final já mergeado (existente + alterações manuais do confirm). */
  fieldProvenance: FnrhFieldProvenanceMap;
  confirmedIp: string | null;
  confirmedUa: string | null;
  now: string;
}): Promise<{ ok: true } | { ok: false; error: string; status: number; details?: unknown }> {
  const validation = validateFnrhCheckinV2Confirm(input.draft);
  if (!validation.ok) {
    return {
      ok: false,
      error: "Validação FNRH v2 falhou.",
      status: 400,
      details: { missing: validation.missing, errors: validation.errors },
    };
  }

  const proof = await buildConfirmationProof({
    fnrh_id: input.fnrhId,
    reservation_id: input.reservaId,
    guest_id: input.guestId,
    flow_version: "v2",
    schema_version: FNRH_V2_SCHEMA_VERSION,
    terms_version: input.draft.terms_version ?? FNRH_TERMS_VERSION,
    privacy_notice_version: input.draft.privacy_notice_version ?? FNRH_PRIVACY_NOTICE_VERSION,
    data_confirmed: true,
    privacy_accepted: true,
    confirmation_source: input.confirmationSource,
    completed_by_guest_id: input.actorGuestId,
    confirmed_at: input.now,
    fields: {
      hospede_nome: input.draft.hospede_nome,
      nome_social: input.draft.nome_social,
      sexo: input.draft.sexo,
      documento_tipo: input.draft.documento_tipo,
      documento_numero: input.draft.documento_numero,
      data_nascimento: input.draft.data_nascimento,
      nacionalidade: input.draft.nacionalidade,
      cep: input.draft.cep,
      logradouro: input.draft.logradouro,
      numero: input.draft.numero,
      bairro: input.draft.bairro,
      cidade: input.draft.cidade,
      uf: input.draft.uf,
      pais: input.draft.pais,
      procedencia: input.draft.procedencia,
      destino: input.draft.destino,
      motivo_viagem: input.draft.motivo_viagem,
      meio_transporte: input.draft.meio_transporte,
      minor_relation: input.draft.minor_relation,
      minor_accompaniment: input.draft.minor_accompaniment,
    },
    documents: input.docs.map((d) => ({
      id: d.id,
      document_type: d.document_type,
      document_subject: d.document_subject,
      storage_ref: d.storage_ref,
    })),
    minors: input.minorsForSnapshot,
  });

  const update = {
    ...v2UpdateFromDraft(input.draft, input.now),
    status: "confirmado_hospede",
    preenchido_em: input.now,
    fnrh_lifecycle_status: "completed",
    confirmation_source: input.confirmationSource,
    completed_by_guest_id: input.actorGuestId,
    completed_at: input.now,
    has_required_core_fields: true,
    has_required_documents: input.draft.is_minor ? true : input.docs.length > 0,
    confirmation_snapshot: proof.confirmation_snapshot,
    snapshot_hash: proof.snapshot_hash,
    hash_algorithm: proof.hash_algorithm,
    schema_version: proof.schema_version,
    confirmed_ip: input.confirmedIp,
    confirmed_user_agent: input.confirmedUa,
    // Persistência obrigatória do mapa final (não pode sumir no confirm).
    field_provenance: input.fieldProvenance,
  };

  const { error: updateErr } = await admin.from("fnrh_hospedes").update(update).eq("id", input.fnrhId);
  if (updateErr) {
    return { ok: false, error: "Falha ao salvar FNRH.", status: 500 };
  }

  const hospedeUpdate: Record<string, unknown> = {
    status_operacional: "confirmado",
    updated_at: input.now,
  };
  if (!input.draft.is_minor) {
    if (input.draft.email) hospedeUpdate.email = input.draft.email;
    if (input.draft.telefone) hospedeUpdate.whatsapp = input.draft.telefone;
  }
  await admin.from("operacional_hospedes").update(hospedeUpdate).eq("id", input.guestId);

  await writeFnrhConfirmedAudit({
    reservation_id: input.reservaId,
    guest_id: input.guestId,
    actor_guest_id: input.actorGuestId,
    actor_type: input.confirmationSource === "responsible" ? "responsible" : "guest",
    previous_state: input.previousState,
    new_state: {
      status: "confirmado_hospede",
      fnrh_lifecycle_status: "completed",
      confirmation_source: input.confirmationSource,
      snapshot_hash: proof.snapshot_hash,
      flow_version: "v2",
      field_provenance_keys: Object.keys(input.fieldProvenance),
    },
  });

  await syncFnrhToHits(admin, input.fnrhId, input.reservaId, input.now);
  return { ok: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Método não permitido." }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ ok: false, error: "Body JSON inválido." }, 400);
  }

  const publicKey = ensureString(body.hospede_id);
  const token = ensureString(body.token);
  if (!publicKey || !token) {
    return jsonResponse({ ok: false, error: "hospede_id e token são obrigatórios." }, 400);
  }

  const actionRaw = ensureString(body.action).toLowerCase();
  const isDraft = actionRaw === "draft";

  const { row, error: resolveErr } = await resolveFnrhRow(publicKey, token);
  if (resolveErr) return jsonResponse({ ok: false, error: resolveErr }, 500);
  if (!row) {
    return jsonResponse({ ok: false, error: "Link inválido ou expirado." }, 404);
  }

  const flow = resolveRequestedFlow(body, row);
  const now = new Date().toISOString();
  const confirmedIp = clientIp(req);
  const confirmedUa = req.headers.get("user-agent")?.slice(0, 512) ?? null;

  const { data: actorHospede } = await admin
    .from("operacional_hospedes")
    .select("id, guest_role, is_minor, responsible_guest_id, principal, email, whatsapp, nome")
    .eq("id", row.hospede_id)
    .maybeSingle();
  const actor = actorHospede as {
    id: string;
    guest_role?: string | null;
    is_minor?: boolean | null;
    responsible_guest_id?: string | null;
    principal?: boolean;
    email?: string;
    whatsapp?: string;
    nome?: string;
  } | null;

  const actorIsMinor = actor?.is_minor === true || actor?.guest_role === "minor";

  // ---------- V2 DRAFT ----------
  if (isDraft && flow === "v2") {
    if (
      STATUS_FINAL_HOSPEDE.has(row.status) ||
      LIFECYCLE_COMPLETE.has(String(row.fnrh_lifecycle_status ?? ""))
    ) {
      return jsonResponse({ ok: true, message: "FNRH já foi finalizada para este hóspede.", idempotente: true });
    }

    const { update, provenanceUpdates } = applyDraftFields(body, V2_DRAFT_KEYS);
    const mergedProv = mergeFieldProvenance(row.field_provenance ?? {}, provenanceUpdates);
    const patch: Record<string, unknown> = {
      ...update,
      updated_at: now,
      status: "rascunho",
      flow_version: "v2",
      fnrh_lifecycle_status: "draft",
      field_provenance: mergedProv,
    };
    // Compose legado parcial se campos estruturados vieram
    if ("logradouro" in update || "cep" in update || "endereco_estrangeiro" in update) {
      const draftPartial = draftFromRowAndBody({ ...row, ...update }, body, {
        is_minor: actorIsMinor,
        responsible_guest_id: actor?.responsible_guest_id ?? null,
        has_document_upload: false,
      });
      patch.endereco = composeEnderecoLegado(draftPartial);
    }
    if ("documento_numero" in update || "documento_tipo" in update) {
      const draftPartial = draftFromRowAndBody({ ...row, ...update }, body, {
        is_minor: actorIsMinor,
        responsible_guest_id: actor?.responsible_guest_id ?? null,
        has_document_upload: false,
      });
      patch.documento = composeDocumentoLegado(draftPartial);
    }

    const { error: upErr } = await admin.from("fnrh_hospedes").update(patch).eq("id", row.id);
    if (upErr) {
      return jsonResponse({ ok: false, error: "Falha ao salvar rascunho." }, 500);
    }
    if (!actorIsMinor) {
      const email = ensureString(body.email);
      const telefone = ensureString(body.telefone);
      const hu: Record<string, unknown> = { updated_at: now };
      if (email) hu.email = email;
      if (telefone) hu.whatsapp = telefone;
      if (email || telefone) {
        await admin.from("operacional_hospedes").update(hu).eq("id", row.hospede_id);
      }
    }
    return jsonResponse({ ok: true, message: "Rascunho salvo.", status: "rascunho", flow_version: "v2" });
  }

  // ---------- LEGACY DRAFT ----------
  if (isDraft) {
    if (STATUS_FINAL_HOSPEDE.has(row.status)) {
      return jsonResponse({ ok: true, message: "FNRH já foi finalizada para este hóspede.", idempotente: true });
    }
    const { update } = applyDraftFields(body, LEGACY_DRAFT_KEYS);
    const patch: Record<string, unknown> = {
      ...update,
      updated_at: now,
      status: "rascunho",
      flow_version: "legacy",
    };
    const { error: upErr } = await admin.from("fnrh_hospedes").update(patch).eq("id", row.id);
    if (upErr) {
      return jsonResponse({ ok: false, error: "Falha ao salvar rascunho." }, 500);
    }
    const email = ensureString(body.email);
    const telefone = ensureString(body.telefone);
    const hu: Record<string, unknown> = { updated_at: now };
    if (email) hu.email = email;
    if (telefone) hu.whatsapp = telefone;
    if (email || telefone) {
      await admin.from("operacional_hospedes").update(hu).eq("id", row.hospede_id);
    }
    return jsonResponse({ ok: true, message: "Rascunho salvo.", status: "rascunho", flow_version: "legacy" });
  }

  // ---------- V2 CONFIRM ----------
  if (flow === "v2") {
    if (actorIsMinor) {
      return jsonResponse({
        ok: false,
        error: "Menor não confirma a própria FNRH. Use o link do responsável.",
      }, 403);
    }

    const actorAlreadyDone =
      STATUS_FINAL_HOSPEDE.has(row.status) ||
      LIFECYCLE_COMPLETE.has(String(row.fnrh_lifecycle_status ?? ""));

    const confirmMinorsRaw = Array.isArray(body.confirm_minors) ? body.confirm_minors : [];
    const confirmOwn = body.confirm_own !== false;

    if (actorAlreadyDone && confirmMinorsRaw.length === 0) {
      return jsonResponse({ ok: true, message: "FNRH já foi finalizada para este hóspede.", idempotente: true });
    }

    const hasDoc = await guestHasDocumentUpload(row.hospede_id, row.reserva_id);
    const { data: fullRow } = await admin
      .from("fnrh_hospedes")
      .select("*")
      .eq("id", row.id)
      .maybeSingle();
    const rowData = (fullRow ?? row) as Record<string, unknown>;

    const confirmedMinorSnapshots: Array<{
      guest_id: string;
      hospede_nome?: string;
      minor_relation?: string | null;
      minor_accompaniment?: string | null;
    }> = [];

    // Confirma o adulto (própria ficha) — não permite confirmar outro adulto.
    if (confirmOwn && !actorAlreadyDone) {
      const draft = draftFromRowAndBody(rowData, body, {
        is_minor: false,
        responsible_guest_id: null,
        has_document_upload: hasDoc,
      });
      // Garante versões de aceite atuais se o client omitir
      draft.terms_version = draft.terms_version || FNRH_TERMS_VERSION;
      draft.privacy_notice_version = draft.privacy_notice_version || FNRH_PRIVACY_NOTICE_VERSION;
      if (!draft.data_nascimento) {
        return jsonResponse({ ok: false, error: "data_nascimento é obrigatória." }, 400);
      }
      if (draft.data_confirmed !== true || draft.privacy_accepted !== true) {
        return jsonResponse({
          ok: false,
          error: "Aceite data_confirmed e privacy_accepted é obrigatório.",
        }, 400);
      }
      if (!hasDoc) {
        return jsonResponse({
          ok: false,
          error: "Adulto precisa de ao menos um documento com storage_ref.",
        }, 400);
      }

      const docs = await loadGuestDocsForSnapshot(row.hospede_id, row.reserva_id);
      const fieldProvenance = buildConfirmFieldProvenance({
        existing: (rowData.field_provenance as FnrhFieldProvenanceMap | null) ?? {},
        previousValues: rowData,
        submittedBody: body,
        fieldKeys: V2_DRAFT_KEYS,
      });
      const result = await confirmV2Guest({
        fnrhId: row.id,
        reservaId: row.reserva_id,
        guestId: row.hospede_id,
        actorGuestId: row.hospede_id,
        confirmationSource: "guest",
        draft,
        docs,
        previousState: {
          status: row.status,
          fnrh_lifecycle_status: row.fnrh_lifecycle_status ?? null,
          flow_version: row.flow_version ?? null,
        },
        fieldProvenance,
        confirmedIp,
        confirmedUa,
        now,
      });
      if (!result.ok) {
        return jsonResponse(
          { ok: false, error: result.error, details: result.details },
          result.status,
        );
      }
    }

    // Confirma menores do responsável
    for (const raw of confirmMinorsRaw) {
      const minorPayload = (typeof raw === "string"
        ? { guest_id: raw }
        : (raw as Record<string, unknown>)) ?? {};
      const minorGuestId = ensureString(minorPayload.guest_id ?? minorPayload.hospede_id);
      if (!minorGuestId) {
        return jsonResponse({ ok: false, error: "confirm_minors exige guest_id." }, 400);
      }

      const { data: minorHospede } = await admin
        .from("operacional_hospedes")
        .select("id, guest_role, is_minor, responsible_guest_id, nome, reserva_id")
        .eq("id", minorGuestId)
        .maybeSingle();
      const mh = minorHospede as {
        id: string;
        guest_role?: string | null;
        is_minor?: boolean | null;
        responsible_guest_id?: string | null;
        nome?: string;
        reserva_id?: string;
      } | null;

      if (!mh || mh.reserva_id !== row.reserva_id) {
        return jsonResponse({ ok: false, error: "Menor não pertence a esta reserva." }, 400);
      }
      if (mh.guest_role !== "minor" && mh.is_minor !== true) {
        return jsonResponse({
          ok: false,
          error: "Adulto não pode confirmar ficha de outro adulto.",
        }, 403);
      }
      if (mh.responsible_guest_id !== row.hospede_id) {
        return jsonResponse({
          ok: false,
          error: "Somente o responsável pode confirmar a FNRH do menor.",
        }, 403);
      }

      const { data: minorFnrh } = await admin
        .from("fnrh_hospedes")
        .select("*")
        .eq("reserva_id", row.reserva_id)
        .eq("hospede_id", minorGuestId)
        .maybeSingle();
      if (!minorFnrh) {
        return jsonResponse({ ok: false, error: "FNRH do menor não encontrada." }, 404);
      }
      const mf = minorFnrh as Record<string, unknown>;
      if (
        STATUS_FINAL_HOSPEDE.has(String(mf.status ?? "")) ||
        LIFECYCLE_COMPLETE.has(String(mf.fnrh_lifecycle_status ?? ""))
      ) {
        continue;
      }

      const minorDraft = draftFromRowAndBody(mf, minorPayload, {
        is_minor: true,
        responsible_guest_id: row.hospede_id,
        has_document_upload: true, // menores não exigem upload próprio na policy
      });
      minorDraft.terms_version = minorDraft.terms_version || FNRH_TERMS_VERSION;
      minorDraft.privacy_notice_version =
        minorDraft.privacy_notice_version || FNRH_PRIVACY_NOTICE_VERSION;
      // Aceite do responsável cobre o menor neste fluxo (body ou payload do menor).
      if (minorDraft.data_confirmed !== true) {
        minorDraft.data_confirmed = ensureBool(body.data_confirmed);
      }
      if (minorDraft.privacy_accepted !== true) {
        minorDraft.privacy_accepted = ensureBool(body.privacy_accepted);
      }
      if (minorDraft.data_confirmed !== true || minorDraft.privacy_accepted !== true) {
        return jsonResponse({
          ok: false,
          error: "Aceite data_confirmed e privacy_accepted do responsável é obrigatório para confirmar menor.",
        }, 400);
      }

      const minorDocs = await loadGuestDocsForSnapshot(minorGuestId, row.reserva_id);
      const fieldProvenance = buildConfirmFieldProvenance({
        existing: (mf.field_provenance as FnrhFieldProvenanceMap | null) ?? {},
        previousValues: mf,
        submittedBody: minorPayload,
        fieldKeys: V2_DRAFT_KEYS,
      });
      const result = await confirmV2Guest({
        fnrhId: String(mf.id),
        reservaId: row.reserva_id,
        guestId: minorGuestId,
        actorGuestId: row.hospede_id,
        confirmationSource: "responsible",
        draft: minorDraft,
        docs: minorDocs,
        previousState: {
          status: mf.status,
          fnrh_lifecycle_status: mf.fnrh_lifecycle_status ?? null,
        },
        fieldProvenance,
        confirmedIp,
        confirmedUa,
        now,
      });
      if (!result.ok) {
        return jsonResponse(
          { ok: false, error: result.error, details: result.details },
          result.status,
        );
      }
      confirmedMinorSnapshots.push({
        guest_id: minorGuestId,
        hospede_nome: minorDraft.hospede_nome ?? mh.nome,
        minor_relation: minorDraft.minor_relation,
        minor_accompaniment: minorDraft.minor_accompaniment,
      });
    }

    void confirmedMinorSnapshots;

    const agregado = await syncLegadoAgregado(row.reserva_id, now);
    if (agregado === "fnrh_completo") {
      await maybeDispararLiberacaoPorRequisitos(row.reserva_id);
    }

    return jsonResponse({
      ok: true,
      message: "FNRH confirmada com sucesso.",
      reserva_id: row.reserva_id,
      fnrh_status_agregado: agregado,
      status: "confirmado_hospede",
      flow_version: "v2",
    });
  }

  // ---------- LEGACY CONFIRM ----------
  if (STATUS_FINAL_HOSPEDE.has(row.status)) {
    return jsonResponse({ ok: true, message: "FNRH já foi finalizada para este hóspede.", idempotente: true });
  }

  const hospede_nome = ensureString(body.hospede_nome);
  const documento = ensureString(body.documento);
  const nacionalidade = ensureString(body.nacionalidade);
  const endereco = ensureString(body.endereco);
  const telefone = ensureString(body.telefone);
  const email = ensureString(body.email);
  const procedencia = ensureString(body.procedencia);
  const destino = ensureString(body.destino);
  if (!hospede_nome || !documento || !nacionalidade || !endereco || !telefone || !email || !procedencia || !destino) {
    return jsonResponse({ ok: false, error: "Preencha todos os campos obrigatórios antes de confirmar." }, 400);
  }
  const assinatura = body.assinatura_base64 != null ? String(body.assinatura_base64).trim() : "";
  if (!assinatura) {
    return jsonResponse({ ok: false, error: "Assinatura obrigatória para confirmar a FNRH." }, 400);
  }

  const update: Record<string, unknown> = {
    hospede_nome,
    documento,
    data_nascimento: ensureDate(body.data_nascimento),
    nacionalidade,
    endereco,
    telefone,
    email,
    procedencia,
    destino,
    placa_veiculo: ensureString(body.placa_veiculo ?? ""),
    cor_veiculo: ensureString(body.cor_veiculo ?? ""),
    modelo_veiculo: ensureString(body.modelo_veiculo ?? ""),
    assinatura_base64: assinatura,
    status: "confirmado_hospede",
    preenchido_em: now,
    updated_at: now,
    flow_version: "legacy",
  };

  const { error: updateErr } = await admin.from("fnrh_hospedes").update(update).eq("id", row.id);

  if (updateErr) {
    return jsonResponse({ ok: false, error: "Falha ao salvar FNRH." }, 500);
  }

  const reservaId = row.reserva_id;
  const hospedeUpdate: Record<string, unknown> = { status_operacional: "confirmado", updated_at: now };
  if (email) hospedeUpdate.email = email;
  if (telefone) hospedeUpdate.whatsapp = telefone;
  await admin.from("operacional_hospedes").update(hospedeUpdate).eq("id", row.hospede_id);

  const agregado = await syncLegadoAgregado(reservaId, now);

  await syncFnrhToHits(admin, row.id, reservaId, now);

  if (agregado === "fnrh_completo") {
    await maybeDispararLiberacaoPorRequisitos(reservaId);
  }

  return jsonResponse({
    ok: true,
    message: "FNRH confirmada com sucesso.",
    reserva_id: reservaId,
    fnrh_status_agregado: agregado,
    status: "confirmado_hospede",
    flow_version: "legacy",
  });
});

/**
 * Quando FNRH fecha por último: se financeiro liberado para acesso e senha não enviada,
 * dispara o fluxo existente send-senha (automático). Idempotente via senha_enviada_em.
 */
async function maybeDispararLiberacaoPorRequisitos(reservaId: string): Promise<void> {
  try {
    const { data: reserva } = await admin
      .from("operacional_reservas")
      .select("id, pagamento_status, senha_enviada_em, acesso_liberado, classificacao_comissionamento, status_reserva")
      .eq("id", reservaId)
      .maybeSingle();
    if (!reserva) return;
    const statusReserva = String(
      (reserva as { status_reserva?: string }).status_reserva ?? "",
    ).toLowerCase();
    if (statusReserva.includes("cancel")) return;
    if ((reserva as { senha_enviada_em?: string | null }).senha_enviada_em) return;

    if (
      !isFinanceiroLiberadoParaAcesso({
        pagamento_status: (reserva as { pagamento_status?: string }).pagamento_status,
        classificacao_comissionamento: (reserva as { classificacao_comissionamento?: string })
          .classificacao_comissionamento,
      })
    ) {
      return;
    }

    if (!(reserva as { acesso_liberado?: boolean }).acesso_liberado) {
      await admin
        .from("operacional_reservas")
        .update({ acesso_liberado: true, updated_at: new Date().toISOString() })
        .eq("id", reservaId);
    }

    const sendUrl = `${supabaseUrl}/functions/v1/send-senha`;
    const res = await fetch(sendUrl, {
      method: "POST",
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({
        reserva_id: reservaId,
        manual: false,
        origem: "requisitos",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn("[fnrh-submit] liberação por requisitos falhou:", data);
      await admin.from("operacional_reserva_eventos").insert({
        reserva_id: reservaId,
        tipo: "falha_enviar_credenciais",
        titulo: "Falha ao enviar credenciais",
        detalhe: JSON.stringify({
          origem: "requisitos",
          erro: (data as { error?: string }).error || res.statusText,
        }),
      });
    }
  } catch (error) {
    console.warn("[fnrh-submit] maybeDispararLiberacaoPorRequisitos:", error);
  }
}

async function syncFnrhToHits(
  client: ReturnType<typeof createClient>,
  fnrhId: string,
  reservaId: string,
  now: string,
): Promise<void> {
  const hitsWebhookUrl = Deno.env.get("HITS_FNRH_WEBHOOK_URL")?.trim();
  if (!hitsWebhookUrl) {
    await client
      .from("fnrh_hospedes")
      .update({
        fnrh_sync_status: "pendente",
        fnrh_sync_erro: "HITS_FNRH_WEBHOOK_URL não configurado.",
        updated_at: now,
      })
      .eq("id", fnrhId);
    await client.from("operacional_reserva_eventos").insert({
      reserva_id: reservaId,
      tipo: "fnrh_sync_hits",
      titulo: "Sync FNRH → HITS",
      detalhe: JSON.stringify({ status: "pendente", erro: "HITS_FNRH_WEBHOOK_URL não configurado." }),
    });
    return;
  }
  try {
    const { data: fnrh } = await client
      .from("fnrh_hospedes")
      .select("hospede_nome, documento, data_nascimento, nacionalidade, endereco, telefone, email, procedencia, destino, placa_veiculo, cor_veiculo, modelo_veiculo")
      .eq("id", fnrhId)
      .single();
    if (!fnrh) return;
    const payload = {
      reserva_id: reservaId,
      fnrh_id: fnrhId,
      hospede_nome: (fnrh as Record<string, unknown>).hospede_nome,
      documento: (fnrh as Record<string, unknown>).documento,
      data_nascimento: (fnrh as Record<string, unknown>).data_nascimento,
      nacionalidade: (fnrh as Record<string, unknown>).nacionalidade,
      endereco: (fnrh as Record<string, unknown>).endereco,
      telefone: (fnrh as Record<string, unknown>).telefone,
      email: (fnrh as Record<string, unknown>).email,
      procedencia: (fnrh as Record<string, unknown>).procedencia,
      destino: (fnrh as Record<string, unknown>).destino,
      placa_veiculo: (fnrh as Record<string, unknown>).placa_veiculo,
      cor_veiculo: (fnrh as Record<string, unknown>).cor_veiculo,
      modelo_veiculo: (fnrh as Record<string, unknown>).modelo_veiculo,
    };
    const res = await fetch(hitsWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const ok = res.ok;
    const errText = ok ? null : await res.text();
    await client
      .from("fnrh_hospedes")
      .update({
        fnrh_sync_status: ok ? "enviado" : "erro",
        fnrh_sync_enviado_em: now,
        fnrh_sync_erro: errText?.slice(0, 500) ?? (ok ? null : `HTTP ${res.status}`),
        status: ok ? "enviado_oficial" : "erro_sincronizacao",
        updated_at: now,
      })
      .eq("id", fnrhId);
    await client.from("operacional_reserva_eventos").insert({
      reserva_id: reservaId,
      tipo: "fnrh_sync_hits",
      titulo: "Sync FNRH → HITS",
      detalhe: JSON.stringify({ status: ok ? "enviado" : "erro", erro: errText ?? null }),
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await client
      .from("fnrh_hospedes")
      .update({
        fnrh_sync_status: "erro",
        fnrh_sync_enviado_em: now,
        fnrh_sync_erro: errMsg.slice(0, 500),
        status: "erro_sincronizacao",
        updated_at: now,
      })
      .eq("id", fnrhId);
    await client.from("operacional_reserva_eventos").insert({
      reserva_id: reservaId,
      tipo: "fnrh_sync_hits",
      titulo: "Sync FNRH → HITS",
      detalhe: JSON.stringify({ status: "erro", erro: errMsg }),
    });
  }
}
