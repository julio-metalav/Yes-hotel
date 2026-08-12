/**
 * FNRH digital — leitura por reserva_id (painel) ou guest_id+token (formulário público).
 * Pré-preenche com merge: fnrh_hospedes + operacional_hospedes + operacional_reservas.
 * guest_id = fnrh_hospedes.id (ou legado hospede_id).
 * v2: campos estruturados, documentos (metadados), menores do responsável, feature flags.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  FNRH_PRIVACY_NOTICE_VERSION,
  FNRH_TERMS_VERSION,
  isFnrhFaceVerificationEnabled,
  isFnrhOcrEnabled,
} from "../../../src/lib/domain/yes-hotel/fnrh-checkin-v2-policy.ts";
import { isFnrhLifecycleComplete } from "../../../src/lib/domain/yes-hotel/fnrh-completion-policy.ts";
import {
  mergeFieldProvenance,
  shouldApplySuggestedValue,
  type FnrhFieldProvenanceMap,
} from "../../../src/lib/domain/yes-hotel/fnrh-field-provenance.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  // POST: guest_id+token no body (evita token em access log de query string).
  // GET legado: ainda aceito para compatibilidade de links antigos.
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function str(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

/** Estados em que o hóspede já encerrou a ficha no Yes (somente leitura no formulário público). */
const STATUS_ENCERRADO_HOSPEDE = new Set([
  "preenchido",
  "confirmado_hospede",
  "enviado_oficial",
  "erro_sincronizacao",
]);

const FNRH_GET_SELECT = [
  "id",
  "reserva_id",
  "hospede_id",
  "hospede_nome",
  "status",
  "link_token",
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
  "preenchido_em",
  "nome_social",
  "sexo",
  "documento_tipo",
  "documento_numero",
  "orgao_emissor",
  "pais_emissor",
  "documento_validade",
  "cep",
  "logradouro",
  "numero",
  "complemento",
  "bairro",
  "cidade",
  "uf",
  "pais",
  "endereco_estrangeiro",
  "motivo_viagem",
  "meio_transporte",
  "terms_version",
  "privacy_notice_version",
  "terms_accepted_at",
  "data_confirmed",
  "privacy_accepted",
  "field_provenance",
  "flow_version",
  "fnrh_lifecycle_status",
  "confirmation_source",
  "completed_at",
  "completed_by_guest_id",
  "has_required_core_fields",
  "has_required_documents",
  "identity_verification_status",
  "document_verification_status",
  "face_verification_status",
  "minor_relation",
  "minor_relation_other",
  "minor_accompaniment",
].join(", ");

function resolveFlowVersion(row: Record<string, unknown>): "legacy" | "v2" {
  const fv = str(row.flow_version);
  if (fv === "v2") return "v2";
  // flow_version=legacy (incl. default DB): mantém canvas se já há progresso legado;
  // formulários editáveis novos (pendente) → v2.
  if (str(row.assinatura_base64)) return "legacy";
  const st = str(row.status);
  if (st === "rascunho") {
    const hasV2Shape = Boolean(
      str(row.documento_tipo) || str(row.cep) || str(row.motivo_viagem) || str(row.logradouro),
    );
    return hasV2Shape ? "v2" : "legacy";
  }
  return "v2";
}

function fechadoPayload(st: string, lifecycle: string | null): Response {
  if (st === "erro_sincronizacao") {
    return jsonResponse({
      message: "Sua ficha foi confirmada. O envio ao sistema oficial falhou; procure a recepção se precisar.",
      status: st,
      fnrh_lifecycle_status: lifecycle,
      fechado: true,
    });
  }
  if (st === "enviado_oficial") {
    return jsonResponse({
      message: "FNRH confirmada e registrada com sucesso.",
      status: st,
      fnrh_lifecycle_status: lifecycle,
      fechado: true,
    });
  }
  return jsonResponse({
    message: "Esta FNRH já foi preenchida e confirmada.",
    status: st === "preenchido" ? "confirmado_hospede" : st,
    fnrh_lifecycle_status: lifecycle,
    fechado: true,
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") {
    return jsonResponse({ error: "Método não permitido." }, 405);
  }

  const url = new URL(req.url);
  let reservaId = url.searchParams.get("reserva_id")?.trim() || "";
  let guestId = url.searchParams.get("guest_id")?.trim() || "";
  let token = url.searchParams.get("token")?.trim() || "";

  // Preferência: credenciais no body (POST) — não aparecem na query do access log.
  if (req.method === "POST") {
    try {
      const body = (await req.json()) as Record<string, unknown>;
      if (!reservaId) reservaId = str(body.reserva_id);
      if (!guestId) guestId = str(body.guest_id ?? body.hospede_id);
      if (!token) token = str(body.token);
    } catch {
      return jsonResponse({ error: "Body JSON inválido." }, 400);
    }
  }

  if (reservaId) {
    const { data: reserva, error: errReserva } = await admin
      .from("operacional_reservas")
      .select("id, fnrh_status_agregado")
      .eq("id", reservaId)
      .maybeSingle();
    if (errReserva || !reserva) {
      return jsonResponse({ error: "Reserva não encontrada." }, 404);
    }
    const { data: list, error: errList } = await admin
      .from("fnrh_hospedes")
      .select("id, hospede_id, hospede_nome, status, preenchido_em, link_token, flow_version, fnrh_lifecycle_status")
      .eq("reserva_id", reservaId)
      .order("created_at", { ascending: true });
    if (errList) return jsonResponse({ error: "Falha ao listar FNRH." }, 500);
    return jsonResponse({
      reserva_id: reservaId,
      fnrh_status_agregado: (reserva as { fnrh_status_agregado: string }).fnrh_status_agregado ?? "fnrh_pendente",
      hospedes: (list ?? []).map((r: Record<string, unknown>) => ({
        hospede_id: r.hospede_id,
        hospede_nome: r.hospede_nome,
        status: r.status,
        preenchido_em: r.preenchido_em,
        link_token: r.link_token,
        flow_version: r.flow_version ?? "legacy",
        fnrh_lifecycle_status: r.fnrh_lifecycle_status ?? null,
      })),
    });
  }

  if (guestId && token) {
    let row: Record<string, unknown> | null = null;
    const { data: byFnrhId, error: errId } = await admin
      .from("fnrh_hospedes")
      .select(FNRH_GET_SELECT)
      .eq("id", guestId)
      .eq("link_token", token)
      .maybeSingle();
    if (errId) return jsonResponse({ error: "Falha ao validar link." }, 500);
    if (byFnrhId) row = byFnrhId as Record<string, unknown>;
    if (!row) {
      const { data: byHospedeId, error: errH } = await admin
        .from("fnrh_hospedes")
        .select(FNRH_GET_SELECT)
        .eq("hospede_id", guestId)
        .eq("link_token", token)
        .maybeSingle();
      if (errH) return jsonResponse({ error: "Falha ao validar link." }, 500);
      if (byHospedeId) row = byHospedeId as Record<string, unknown>;
    }
    if (!row) {
      return jsonResponse({ error: "Link inválido ou expirado." }, 404);
    }

    const st = str(row.status);
    const lifecycle = str(row.fnrh_lifecycle_status) || null;
    if (
      STATUS_ENCERRADO_HOSPEDE.has(st) ||
      isFnrhLifecycleComplete(lifecycle as "completed" | "manually_completed" | "waived" | null)
    ) {
      return fechadoPayload(st || "confirmado_hospede", lifecycle);
    }

    const hospedeOperacionalId = str(row.hospede_id);
    const reservaFk = str(row.reserva_id);

    const { data: hospede } = await admin
      .from("operacional_hospedes")
      .select(
        "principal, nome, email, whatsapp, guest_role, responsible_guest_id, is_minor, data_nascimento, pms_external_guest_id",
      )
      .eq("id", hospedeOperacionalId)
      .maybeSingle();
    const h = hospede as {
      principal?: boolean;
      nome?: string;
      email?: string;
      whatsapp?: string;
      guest_role?: string | null;
      responsible_guest_id?: string | null;
      is_minor?: boolean | null;
      data_nascimento?: string | null;
      pms_external_guest_id?: string | null;
    } | null;

    const { data: resv } = await admin
      .from("operacional_reservas")
      .select("hospede_principal, check_in_previsto, check_out_previsto, veiculo_placa, veiculo_cor, apartamento")
      .eq("id", reservaFk)
      .maybeSingle();
    const rv = resv as {
      hospede_principal?: string;
      check_in_previsto?: string;
      check_out_previsto?: string;
      veiculo_placa?: string;
      veiculo_cor?: string;
      apartamento?: string;
    } | null;

    const pick = (dbVal: unknown, fallback: string) => {
      const d = str(dbVal);
      return d !== "" ? d : fallback;
    };

    const nomeHotel = str(rv?.hospede_principal);
    const hintDestino = rv?.check_out_previsto
      ? `Saída prevista ${String(rv.check_out_previsto).slice(0, 10)}`
      : "";

    const preenchido: Record<string, unknown> = {
      hospede_nome: pick(row.hospede_nome, pick(h?.nome, nomeHotel)),
      nome_social: pick(row.nome_social, ""),
      sexo: pick(row.sexo, ""),
      documento: pick(row.documento, pick(row.documento_numero, "")),
      documento_tipo: pick(row.documento_tipo, ""),
      documento_numero: pick(row.documento_numero, pick(row.documento, "")),
      orgao_emissor: pick(row.orgao_emissor, ""),
      pais_emissor: pick(row.pais_emissor, ""),
      documento_validade: row.documento_validade ?? null,
      data_nascimento: row.data_nascimento ?? h?.data_nascimento ?? null,
      nacionalidade: pick(row.nacionalidade, ""),
      endereco: pick(row.endereco, ""),
      cep: pick(row.cep, ""),
      logradouro: pick(row.logradouro, ""),
      numero: pick(row.numero, ""),
      complemento: pick(row.complemento, ""),
      bairro: pick(row.bairro, ""),
      cidade: pick(row.cidade, ""),
      uf: pick(row.uf, ""),
      pais: pick(row.pais, "Brasil"),
      endereco_estrangeiro: pick(row.endereco_estrangeiro, ""),
      telefone: pick(row.telefone, str(h?.whatsapp)),
      email: pick(row.email, str(h?.email)),
      procedencia: pick(row.procedencia, ""),
      destino: pick(row.destino, hintDestino),
      motivo_viagem: pick(row.motivo_viagem, ""),
      meio_transporte: pick(row.meio_transporte, ""),
      placa_veiculo: pick(row.placa_veiculo, str(rv?.veiculo_placa)),
      cor_veiculo: pick(row.cor_veiculo, str(rv?.veiculo_cor)),
      modelo_veiculo: pick(row.modelo_veiculo, ""),
      data_confirmed: row.data_confirmed === true,
      privacy_accepted: row.privacy_accepted === true,
      minor_relation: pick(row.minor_relation, ""),
      minor_relation_other: pick(row.minor_relation_other, ""),
      minor_accompaniment: pick(row.minor_accompaniment, ""),
    };

    // Pré-preenchimento HITS via espelho PMS (não sobrescreve manual/ocr/confirmado).
    let fieldProvenance: FnrhFieldProvenanceMap =
      ((row.field_provenance as FnrhFieldProvenanceMap | null) ?? {}) as FnrhFieldProvenanceMap;
    const pmsExt = str(h?.pms_external_guest_id);
    if (pmsExt && row.data_confirmed !== true) {
      const { data: pmsGuest } = await admin
        .from("pms_hospedes")
        .select("nome, email, telefone, documento, nacionalidade, sexo, data_nascimento")
        .eq("provider", "hits")
        .eq("external_guest_id", pmsExt)
        .maybeSingle();
      const pg = pmsGuest as {
        nome?: string | null;
        email?: string | null;
        telefone?: string | null;
        documento?: string | null;
        nacionalidade?: string | null;
        sexo?: string | null;
        data_nascimento?: string | null;
      } | null;
      if (pg) {
        const hitsSuggestions: Array<{ field: string; value: unknown }> = [
          { field: "hospede_nome", value: pg.nome },
          { field: "email", value: pg.email },
          { field: "telefone", value: pg.telefone },
          { field: "documento", value: pg.documento },
          { field: "documento_numero", value: pg.documento },
          { field: "nacionalidade", value: pg.nacionalidade },
          { field: "sexo", value: pg.sexo },
          { field: "data_nascimento", value: pg.data_nascimento },
        ];
        const hitsProv: FnrhFieldProvenanceMap = {};
        for (const s of hitsSuggestions) {
          const val = s.value == null ? "" : String(s.value).trim();
          if (!val) continue;
          const currentOrigin = fieldProvenance[s.field] ?? null;
          if (
            !shouldApplySuggestedValue({
              currentValue: preenchido[s.field],
              currentOrigin,
              suggestedOrigin: "hits",
            })
          ) {
            continue;
          }
          preenchido[s.field] = val;
          hitsProv[s.field] = "hits";
        }
        if (Object.keys(hitsProv).length > 0) {
          fieldProvenance = mergeFieldProvenance(fieldProvenance, hitsProv);
        }
      }
    }

    const { data: docs } = await admin
      .from("operacional_fnrh_documentos")
      .select("id, document_type, document_subject, validation_status, storage_ref")
      .eq("guest_id", hospedeOperacionalId)
      .eq("reservation_id", reservaFk);

    const documents = (docs ?? []).map((d: Record<string, unknown>) => ({
      id: d.id,
      document_type: d.document_type,
      document_subject: d.document_subject,
      validation_status: d.validation_status,
      storage_ref_present: Boolean(str(d.storage_ref)),
    }));

    const guestRole = h?.guest_role ?? null;
    const isMinor = h?.is_minor === true || guestRole === "minor";
    const isResponsibleAdult =
      !isMinor &&
      (guestRole === "primary_adult" || guestRole === "adult_companion" || h?.principal === true);

    let minors: Array<Record<string, unknown>> = [];
    if (isResponsibleAdult) {
      const { data: minorHospedes } = await admin
        .from("operacional_hospedes")
        .select("id, nome, guest_role, is_minor, responsible_guest_id, data_nascimento")
        .eq("reserva_id", reservaFk)
        .eq("guest_role", "minor")
        .eq("responsible_guest_id", hospedeOperacionalId)
        .eq("removed_from_reservation", false);

      const minorIds = (minorHospedes ?? []).map((m: { id: string }) => m.id);
      let minorFnrhByGuest = new Map<string, Record<string, unknown>>();
      if (minorIds.length > 0) {
        const { data: minorFnrh } = await admin
          .from("fnrh_hospedes")
          .select(
            "id, hospede_id, hospede_nome, status, fnrh_lifecycle_status, flow_version, data_nascimento, minor_relation, minor_relation_other, minor_accompaniment, documento_tipo, documento_numero, nacionalidade",
          )
          .eq("reserva_id", reservaFk)
          .in("hospede_id", minorIds);
        for (const mf of minorFnrh ?? []) {
          const rec = mf as Record<string, unknown>;
          minorFnrhByGuest.set(str(rec.hospede_id), rec);
        }
      }

      minors = (minorHospedes ?? []).map((m: Record<string, unknown>) => {
        const fnrh = minorFnrhByGuest.get(str(m.id));
        return {
          guest_id: m.id,
          nome: pick(fnrh?.hospede_nome, str(m.nome)),
          data_nascimento: fnrh?.data_nascimento ?? m.data_nascimento ?? null,
          status: fnrh?.status ?? "pendente",
          fnrh_lifecycle_status: fnrh?.fnrh_lifecycle_status ?? null,
          flow_version: fnrh?.flow_version ?? null,
          minor_relation: fnrh?.minor_relation ?? null,
          minor_relation_other: fnrh?.minor_relation_other ?? null,
          minor_accompaniment: fnrh?.minor_accompaniment ?? null,
          documento_tipo: fnrh?.documento_tipo ?? null,
          documento_numero: fnrh?.documento_numero ?? null,
          nacionalidade: fnrh?.nacionalidade ?? null,
          fnrh_id: fnrh?.id ?? null,
        };
      });
    }

    const principal = !!h?.principal || guestRole === "primary_adult";
    const flow_version = resolveFlowVersion(row);

    return jsonResponse({
      hospede_id: row.hospede_id,
      fnrh_id: row.id,
      hospede_nome: preenchido.hospede_nome,
      reserva_id: row.reserva_id,
      status: st,
      principal,
      guest_role: guestRole,
      responsible_guest_id: h?.responsible_guest_id ?? null,
      is_minor: isMinor,
      editavel: true,
      flow_version,
      fnrh_lifecycle_status: lifecycle,
      terms_version: FNRH_TERMS_VERSION,
      privacy_notice_version: FNRH_PRIVACY_NOTICE_VERSION,
      field_provenance: fieldProvenance,
      identity_verification_status: row.identity_verification_status ?? "not_required",
      document_verification_status: row.document_verification_status ?? "not_required",
      face_verification_status: row.face_verification_status ?? "not_required",
      feature_flags: {
        ocr_enabled: isFnrhOcrEnabled(Deno.env.get("FNRH_OCR_ENABLED")),
        face_verification_enabled: isFnrhFaceVerificationEnabled(
          Deno.env.get("FNRH_FACE_VERIFICATION_ENABLED"),
        ),
      },
      meta: {
        apartamento: str(rv?.apartamento),
        check_in_previsto: rv?.check_in_previsto ?? null,
        check_out_previsto: rv?.check_out_previsto ?? null,
      },
      preenchido,
      documents,
      minors,
      // Legado: só expõe assinatura no fluxo canvas.
      assinatura_base64: flow_version === "legacy" ? (row.assinatura_base64 ?? null) : null,
    });
  }

  return jsonResponse({ error: "Informe reserva_id ou guest_id e token." }, 400);
});
