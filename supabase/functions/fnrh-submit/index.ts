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
  buildHitsGuestPostFromFnrh,
  buildHitsGuestPutFromFnrh,
  findIdEntityByDoc,
  hasUpdatableFields,
} from "../../../src/lib/integrations/hits/fnrh-to-hits-guest.ts";
import { resolveGuestIdentity } from "../../../src/lib/crm/identity.ts";
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

/**
 * Autosave: valores podem ser reenviados sem mudar provenance.
 * Somente campos em dirty_manual_fields (edição real do hóspede) viram manual.
 * Sem dirty_manual_fields → não inventa provenance manual (legado seguro).
 */
function parseDirtyManualFields(body: Record<string, unknown>): Set<string> | null {
  const raw = body.dirty_manual_fields;
  if (!Array.isArray(raw)) return null;
  return new Set(raw.map((x) => String(x)));
}

function applyDraftFields(
  body: Record<string, unknown>,
  keys: readonly string[],
): { update: Record<string, unknown>; provenanceUpdates: FnrhFieldProvenanceMap } {
  const update: Record<string, unknown> = {};
  const provenanceUpdates: FnrhFieldProvenanceMap = {};
  const dirty = parseDirtyManualFields(body);
  for (const k of keys) {
    if (!(k in body)) continue;
    const v = body[k];
    if (DATE_KEYS.has(k)) {
      update[k] = ensureDate(v);
    } else if (BOOL_KEYS.has(k)) {
      update[k] = ensureBool(v);
    } else if (k === "assinatura_base64") {
      update[k] = v != null && String(v).trim() !== "" ? String(v) : null;
    } else if (k === "documento_tipo") {
      const tipo = v != null ? String(v).trim().toLowerCase() : "";
      // Placeholder técnico do upload — não persistir como tipo semântico.
      update[k] = tipo === "other" ? null : tipo || null;
    } else {
      update[k] = v != null ? String(v) : "";
    }
    if (dirty?.has(k)) {
      provenanceUpdates[k] = "manual";
    }
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

// --- crm-guests:begin ---
// Cadastro mestre reutilizável (crm_guests), alimentado no confirm da FNRH.
//
// Bloco autocontido: scripts/test-fnrh-crm-guests-upsert.ts o extrai pelos
// marcadores e o executa contra um cliente Supabase falso. Por isso ele só
// depende de resolveGuestIdentity (import no topo) e do `client` recebido.
//
// Regras: identidade forte (CPF válido ou passaporte com tipo declarado) é a
// única chave; e-mail/telefone nunca identificam. Sem identidade não há
// registro fraco. Valor vazio nunca sobrescreve valor existente. Nome social
// nunca vira full_name. Falha aqui não derruba a confirmação da FNRH.

type CrmGuestSource = {
  hospede_nome?: string | null;
  documento_tipo?: string | null;
  documento_numero?: string | null;
  nacionalidade?: string | null;
  data_nascimento?: string | null;
  email?: string | null;
  telefone?: string | null;
  cidade?: string | null;
  uf?: string | null;
  pais?: string | null;
  is_minor?: boolean;
};

type CrmGuestUpsertOutcome =
  | { status: "created" | "updated" }
  | { status: "skipped"; reason: "no_strong_identity" }
  | { status: "error"; code: string };

function crmText(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function crmDate(v: unknown): string | null {
  const s = crmText(v);
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : s.slice(0, 10);
}

/** Só chave forte: CPF com dígito verificador válido ou passaporte com tipo declarado. */
function resolveCrmIdentity(
  src: CrmGuestSource,
): { kind: "cpf" | "passport"; value: string; matchKey: string } | null {
  const r = resolveGuestIdentity({
    documentType: src.documento_tipo,
    documentNumber: src.documento_numero,
    nationality: src.nacionalidade,
  });
  if (!r.identity || r.identity.confidence !== "confirmed" || !r.matchKey) return null;
  return { kind: r.identity.kind, value: r.identity.valueNormalized, matchKey: r.matchKey };
}

/** Atributos confirmados e não vazios. Nome social fica fora — full_name é o nome civil. */
function buildCrmGuestAttributes(src: CrmGuestSource): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, value: unknown) => {
    const s = crmText(value);
    if (s) out[key] = s;
  };
  put("full_name", src.hospede_nome);
  put("birth_date", crmDate(src.data_nascimento));
  if (src.is_minor !== true) {
    put("email", src.email);
    put("phone", src.telefone);
  }
  put("city", src.cidade);
  put("state", src.uf);
  put("country", src.pais);
  return out;
}

function crmErrorCode(error: { code?: string | null } | null | undefined, fallback: string): string {
  const code = crmText(error?.code);
  return code ?? fallback;
}

/**
 * Upsert por match_key. Registro existente mantém first_seen_at e recebe
 * last_seen_at + atributos não vazios; novo registro nasce com os dois.
 * Não usa ON CONFLICT: o índice único de match_key é parcial.
 */
async function upsertCrmGuestFromFnrh(
  client: ReturnType<typeof createClient>,
  input: { source: CrmGuestSource; now: string },
): Promise<CrmGuestUpsertOutcome> {
  const identity = resolveCrmIdentity(input.source);
  if (!identity) return { status: "skipped", reason: "no_strong_identity" };

  const attrs = buildCrmGuestAttributes(input.source);
  const touch = { ...attrs, last_seen_at: input.now, updated_at: input.now };
  try {
    const { data: existing, error: selErr } = await client
      .from("crm_guests")
      .select("id, first_seen_at")
      .eq("match_key", identity.matchKey)
      .maybeSingle();
    if (selErr) return { status: "error", code: crmErrorCode(selErr, "select_failed") };

    if (existing) {
      const { error } = await client
        .from("crm_guests")
        .update(touch)
        .eq("id", (existing as { id: string }).id);
      if (error) return { status: "error", code: crmErrorCode(error, "update_failed") };
      return { status: "updated" };
    }

    const { error: insErr } = await client.from("crm_guests").insert({
      match_key: identity.matchKey,
      document_type: identity.kind,
      document_number_normalized: identity.value,
      country_code: identity.kind === "cpf" ? "BR" : null,
      full_name: attrs.full_name ?? "",
      ...touch,
      first_seen_at: input.now,
    });
    if (insErr) {
      // Corrida entre dois confirms: o outro inseriu primeiro → vira update.
      if (insErr.code === "23505") {
        const { error } = await client
          .from("crm_guests")
          .update(touch)
          .eq("match_key", identity.matchKey);
        if (error) return { status: "error", code: crmErrorCode(error, "update_failed") };
        return { status: "updated" };
      }
      return { status: "error", code: crmErrorCode(insErr, "insert_failed") };
    }
    return { status: "created" };
  } catch {
    return { status: "error", code: "exception" };
  }
}

/** Falha do CRM: log e evento operacional sem PII — só o código do erro. */
async function registrarFalhaCrmGuest(
  client: ReturnType<typeof createClient>,
  reservaId: string,
  code: string,
): Promise<void> {
  console.warn("[fnrh-submit] crm_guests não atualizado:", code);
  try {
    await client.from("operacional_reserva_eventos").insert({
      reserva_id: reservaId,
      tipo: "crm_guest_upsert",
      titulo: "Cadastro mestre (CRM) não atualizado",
      detalhe: JSON.stringify({ status: "erro", code }),
    });
  } catch {
    // Evento é apoio; a FNRH confirmada não depende dele.
  }
}
// --- crm-guests:end ---

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
}): Promise<
  | { ok: true; crm: CrmGuestUpsertOutcome }
  | { ok: false; error: string; status: number; details?: unknown }
> {
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
  // Cadastro operacional recebe o que o hóspede confirmou — só valores não
  // vazios (vazio nunca apaga o que já existe) e nunca o nome social no lugar
  // do nome civil. Dados da reserva não são tocados aqui.
  const nomeCivilConfirmado = crmText(input.draft.hospede_nome);
  if (nomeCivilConfirmado) hospedeUpdate.nome = nomeCivilConfirmado;
  const nascimentoConfirmado = crmDate(input.draft.data_nascimento);
  if (nascimentoConfirmado) hospedeUpdate.data_nascimento = nascimentoConfirmado;
  if (!input.draft.is_minor) {
    if (input.draft.email) hospedeUpdate.email = input.draft.email;
    if (input.draft.telefone) hospedeUpdate.whatsapp = input.draft.telefone;
  }
  await admin.from("operacional_hospedes").update(hospedeUpdate).eq("id", input.guestId);

  // Cadastro mestre (crm_guests): só com identidade forte; falha não derruba a
  // confirmação nem repete o envio ao HITS — fica no resultado interno.
  const crm = await upsertCrmGuestFromFnrh(admin, { source: input.draft, now: input.now });
  if (crm.status === "error") {
    await registrarFalhaCrmGuest(admin, input.reservaId, crm.code);
  }

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
  return { ok: true, crm };
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
async function sumPagarmePaidCentavos(reservaId: string): Promise<number> {
  const { data, error } = await admin
    .from("operacional_cobrancas_pagarme")
    .select("valor_centavos, status")
    .eq("reserva_id", reservaId)
    .eq("status", "paid");
  if (error || !data) return 0;
  let total = 0;
  for (const row of data as Array<{ valor_centavos?: number }>) {
    const v = Number(row.valor_centavos);
    if (Number.isInteger(v) && v > 0) total += v;
  }
  return total;
}

async function maybeDispararLiberacaoPorRequisitos(reservaId: string): Promise<void> {
  try {
    const { data: reserva } = await admin
      .from("operacional_reservas")
      .select(
        "id, pagamento_status, senha_enviada_em, acesso_liberado, classificacao_comissionamento, status_reserva, reservation_balance_due",
      )
      .eq("id", reservaId)
      .maybeSingle();
    if (!reserva) return;
    const statusReserva = String(
      (reserva as { status_reserva?: string }).status_reserva ?? "",
    ).toLowerCase();
    if (statusReserva.includes("cancel")) return;
    if ((reserva as { senha_enviada_em?: string | null }).senha_enviada_em) return;

    const paidTotal = await sumPagarmePaidCentavos(reservaId);
    if (
      !isFinanceiroLiberadoParaAcesso({
        pagamento_status: (reserva as { pagamento_status?: string }).pagamento_status,
        classificacao_comissionamento: (reserva as { classificacao_comissionamento?: string })
          .classificacao_comissionamento,
        reservation_balance_due: (reserva as { reservation_balance_due?: number | null })
          .reservation_balance_due,
        pagarme_paid_centavos_total: paidTotal,
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

/** Campos da ficha que alimentam o DTO PAX. Nenhum outro é lido. */
const FNRH_SYNC_SELECT = [
  "hospede_id",
  "hospede_nome",
  "data_nascimento",
  "documento_numero",
  "documento_tipo",
  "telefone",
  "email",
  "sexo",
  "cep",
  "logradouro",
  "numero",
  "complemento",
  "bairro",
  "cidade",
  "uf",
  "pais",
  "motivo_viagem",
  "meio_transporte",
  "placa_veiculo",
  "nacionalidade",
].join(", ");

/** Inteiro positivo ou null — idEntity e idReservation do HITS são numéricos. */
function toPositiveInt(value: unknown): number | null {
  const n = Number(String(value ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Registra o desfecho do sync sem apagar nada da ficha.
 *
 * A FNRH permanece salva em qualquer cenário: aqui só se escreve o estado da
 * sincronização e um evento operacional. Nenhum status de reserva, quarto,
 * check-in, pagamento ou credencial é tocado.
 */
async function registrarSyncFnrh(
  client: ReturnType<typeof createClient>,
  fnrhId: string,
  reservaId: string,
  now: string,
  outcome: {
    syncStatus: "enviado" | "erro" | "pendente";
    erro?: string | null;
    /** Só em enviado/erro: `enviado_oficial` | `erro_sincronizacao`. */
    fichaStatus?: "enviado_oficial" | "erro_sincronizacao";
    /** Nomes de campos enviados — nunca valores. */
    campos?: string[];
  },
): Promise<void> {
  const update: Record<string, unknown> = {
    fnrh_sync_status: outcome.syncStatus,
    fnrh_sync_erro: outcome.erro ? String(outcome.erro).slice(0, 500) : null,
    updated_at: now,
  };
  if (outcome.syncStatus !== "pendente") update.fnrh_sync_enviado_em = now;
  if (outcome.fichaStatus) update.status = outcome.fichaStatus;

  await client.from("fnrh_hospedes").update(update).eq("id", fnrhId);
  await client.from("operacional_reserva_eventos").insert({
    reserva_id: reservaId,
    tipo: "fnrh_sync_hits",
    titulo: "Sync FNRH → HITS",
    // Sem PII: status, erro sanitizado e a lista de NOMES de campos.
    detalhe: JSON.stringify({
      status: outcome.syncStatus,
      erro: outcome.erro ?? null,
      campos: outcome.campos ?? [],
    }),
  });
}

/**
 * Garante o PAX no HITS para uma posição criada pelo Yes (ocupação declarada)
 * que ainda não tem idEntity. Devolve o idEntity persistido, ou `null` depois
 * de registrar o motivo — nunca inventa id.
 *
 * Ordem, e por que ela é idempotente:
 *   3. GET do detalhe da reserva e busca do PAX pelo documento — um POST
 *      anterior cujo persist falhou é reencontrado aqui, sem novo POST;
 *   5. POST mínimo (name, doc/docType, contact/contactType — é tudo o que o
 *      contrato do POST aceita; o resto vai no PUT);
 *   6–7. GET de novo e localização pelo documento (o gateway não reencaminha o
 *      corpo do HITS, então o idEntity só existe no detalhe);
 *   8. persiste `pms_external_guest_id` SOMENTE se ainda nulo — quem persistiu
 *      primeiro vence, e o valor persistido é o que segue para o PUT.
 * Escopo é a reserva: nunca uma busca global de entidade por CPF.
 */
async function garantirPaxNoHits(
  client: ReturnType<typeof createClient>,
  fnrhId: string,
  reservaId: string,
  now: string,
  input: {
    hospedeId: string;
    idReservation: number;
    fnrh: Record<string, unknown>;
    gatewayUrl: string;
    gatewayToken: string;
  },
): Promise<number | null> {
  const headers = {
    Authorization: `Bearer ${input.gatewayToken}`,
    Accept: "application/json",
  };
  const item = buildHitsGuestPostFromFnrh(input.fnrh);
  if (!item || !item.doc) {
    await registrarSyncFnrh(client, fnrhId, reservaId, now, {
      syncStatus: "pendente",
      erro: "Hóspede sem documento principal: PAX não criado no HITS.",
    });
    return null;
  }
  const doc = item.doc;
  const reservaPath = `${input.gatewayUrl}/v1/reservations/${encodeURIComponent(String(input.idReservation))}`;
  // Falha de GET e "PAX não existe" são coisas diferentes: só a segunda
  // autoriza um POST. Um GET transitório quebrado antes do POST duplicaria PAX.
  const lerDetalhe = async (): Promise<
    { ok: true; detail: unknown } | { ok: false; status: number }
  > => {
    const r = await fetch(reservaPath, { method: "GET", headers });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, detail: await r.json() };
  };

  // 3–4. Já está na reserva? Então só falta persistir e seguir para o PUT.
  const antes = await lerDetalhe();
  if (!antes.ok) {
    await registrarSyncFnrh(client, fnrhId, reservaId, now, {
      syncStatus: "erro",
      erro: `Leitura da reserva no HITS falhou antes de criar o PAX (HTTP ${antes.status}); POST não executado.`,
      fichaStatus: "erro_sincronizacao",
    });
    return null;
  }
  let idEntity = findIdEntityByDoc(antes.detail, doc);

  if (idEntity == null) {
    // 5. Inclusão mínima do PAX na reserva.
    const res = await fetch(`${reservaPath}/guests`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ guests: [item] }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      await registrarSyncFnrh(client, fnrhId, reservaId, now, {
        syncStatus: "erro",
        erro: `POST PAX no HITS: HTTP ${res.status} ${body}`,
        fichaStatus: "erro_sincronizacao",
      });
      return null;
    }
    // 6–7. O id só aparece no detalhe. Releitura falha ≠ PAX ausente: nos dois
    //      casos nada é inventado, mas o motivo registrado é distinto — e no
    //      retry a busca pré-POST reencontra o PAX sem criar outro.
    const depois = await lerDetalhe();
    if (!depois.ok) {
      await registrarSyncFnrh(client, fnrhId, reservaId, now, {
        syncStatus: "erro",
        erro: `PAX criado no HITS, mas a releitura da reserva falhou (HTTP ${depois.status}).`,
        fichaStatus: "erro_sincronizacao",
      });
      return null;
    }
    idEntity = findIdEntityByDoc(depois.detail, doc);
    if (idEntity == null) {
      await registrarSyncFnrh(client, fnrhId, reservaId, now, {
        syncStatus: "erro",
        erro: "PAX criado no HITS, mas não localizado no detalhe da reserva pelo documento.",
        fichaStatus: "erro_sincronizacao",
      });
      return null;
    }
  }

  // 8. Persistência guardada: só preenche se ainda for nulo.
  await client
    .from("operacional_hospedes")
    .update({ pms_external_guest_id: idEntity, updated_at: now })
    .eq("id", input.hospedeId)
    .is("pms_external_guest_id", null);
  const { data: h } = await client
    .from("operacional_hospedes")
    .select("pms_external_guest_id")
    .eq("id", input.hospedeId)
    .single();
  const persistido = toPositiveInt(
    (h as Record<string, unknown> | null)?.pms_external_guest_id,
  );
  if (persistido == null) {
    await registrarSyncFnrh(client, fnrhId, reservaId, now, {
      syncStatus: "erro",
      erro: "idEntity obtido no HITS, mas não persistido no hóspede.",
      fichaStatus: "erro_sincronizacao",
    });
    return null;
  }
  return persistido;
}

/**
 * Envia os campos suportados da ficha para o cadastro PAX do HITS, pelo gateway
 * (`PUT /v1/guests`) — a única fronteira de escrita que existe. Sem fila, sem
 * webhook novo, sem tabela nova: o estado do envio continua em `fnrh_hospedes`.
 *
 * Escopo estrito: cadastro do hóspede. Não altera status da reserva, quarto,
 * check-in, pagamento nem credencial.
 */
async function syncFnrhToHits(
  client: ReturnType<typeof createClient>,
  fnrhId: string,
  reservaId: string,
  now: string,
): Promise<void> {
  const gatewayUrl = (Deno.env.get("HITS_GATEWAY_URL") ?? "").trim().replace(/\/+$/, "");
  const gatewayToken = (Deno.env.get("HITS_GATEWAY_TOKEN") ?? "").trim();
  if (!gatewayUrl || !gatewayToken) {
    await registrarSyncFnrh(client, fnrhId, reservaId, now, {
      syncStatus: "pendente",
      erro: "HITS_GATEWAY_URL/HITS_GATEWAY_TOKEN não configurados.",
    });
    return;
  }

  try {
    const { data: fnrh } = await client
      .from("fnrh_hospedes")
      .select(FNRH_SYNC_SELECT)
      .eq("id", fnrhId)
      .single();
    if (!fnrh) return;

    // idReservation vem da reserva operacional; idEntity, do hóspede espelhado
    // do HITS. Sem os dois não há o que atualizar — e não é erro: a reserva
    // pode simplesmente não ter origem HITS.
    const { data: reserva } = await client
      .from("operacional_reservas")
      .select("external_reservation_id")
      .eq("id", reservaId)
      .single();
    const { data: hospede } = await client
      .from("operacional_hospedes")
      .select("pms_external_guest_id")
      .eq("id", (fnrh as Record<string, unknown>).hospede_id)
      .single();

    const idReservation = toPositiveInt(
      (reserva as Record<string, unknown> | null)?.external_reservation_id,
    );
    if (idReservation == null) {
      await registrarSyncFnrh(client, fnrhId, reservaId, now, {
        syncStatus: "pendente",
        erro: "Reserva sem external_reservation_id numérico.",
      });
      return;
    }

    // Posição criada pelo Yes (ocupação declarada) ainda sem PAX no HITS: cria
    // e obtém o idEntity antes de sincronizar. Com idEntity já persistido este
    // passo é pulado — o retry vai direto ao PUT, sem novo POST.
    let idEntity = toPositiveInt(
      (hospede as Record<string, unknown> | null)?.pms_external_guest_id,
    );
    if (idEntity == null) {
      idEntity = await garantirPaxNoHits(client, fnrhId, reservaId, now, {
        hospedeId: String((fnrh as Record<string, unknown>).hospede_id ?? ""),
        idReservation,
        fnrh: fnrh as Record<string, unknown>,
        gatewayUrl,
        gatewayToken,
      });
      if (idEntity == null) return; // motivo já registrado; ficha preservada
    }

    const mapped = buildHitsGuestPutFromFnrh({
      idEntity,
      idReservation,
      fnrh: fnrh as Record<string, unknown>,
    });
    if (!hasUpdatableFields(mapped)) {
      await registrarSyncFnrh(client, fnrhId, reservaId, now, {
        syncStatus: "pendente",
        erro: "Nenhum campo suportado para enviar.",
      });
      return;
    }

    const res = await fetch(`${gatewayUrl}/v1/guests`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${gatewayToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(mapped.dto),
    });
    const ok = res.ok;
    // O corpo do gateway já é sanitizado (code + request_id, sem PII upstream).
    const errText = ok ? null : (await res.text()).slice(0, 500);
    await registrarSyncFnrh(client, fnrhId, reservaId, now, {
      syncStatus: ok ? "enviado" : "erro",
      erro: errText ?? (ok ? null : `HTTP ${res.status}`),
      fichaStatus: ok ? "enviado_oficial" : "erro_sincronizacao",
      campos: mapped.included,
    });
  } catch (e) {
    // A ficha continua salva: aqui só se registra a falha, para retry posterior.
    const errMsg = e instanceof Error ? e.message : String(e);
    await registrarSyncFnrh(client, fnrhId, reservaId, now, {
      syncStatus: "erro",
      erro: errMsg,
      fichaStatus: "erro_sincronizacao",
    });
  }
}
