/**
 * Policy pura FNRH check-in digital v2 — obrigatoriedades por etapa.
 * Sem I/O. Sem gate financeiro. Sem exigir canvas/assinatura.
 */

export const FNRH_V2_SCHEMA_VERSION = "fnrh-checkin-v2.1";
export const FNRH_TERMS_VERSION = "terms-v1-2026-08";
export const FNRH_PRIVACY_NOTICE_VERSION = "privacy-v1-2026-08";

export type FnrhDocumentoTipoV2 =
  | "cpf"
  | "rg"
  | "cnh"
  | "passport"
  | "birth_certificate"
  | "other";

export type FnrhMinorRelation =
  | "pai"
  | "mae"
  | "tutor_responsavel_legal"
  | "outro";

export type FnrhMinorAccompaniment =
  | "acompanhado_por_pai_mae"
  | "acompanhado_por_responsavel_legal"
  | "acompanhado_por_terceiro_autorizado";

export type FnrhCheckinV2Step =
  | "documento"
  | "confira_dados"
  | "endereco"
  | "viagem"
  | "hospedes_menores"
  | "revisao"
  | "aceite"
  | "concluido";

export type FnrhCheckinV2Draft = {
  documento_tipo?: string | null;
  documento_numero?: string | null;
  documento?: string | null;
  data_nascimento?: string | null;
  hospede_nome?: string | null;
  nome_social?: string | null;
  sexo?: string | null;
  nacionalidade?: string | null;
  orgao_emissor?: string | null;
  pais_emissor?: string | null;
  cep?: string | null;
  logradouro?: string | null;
  numero?: string | null;
  complemento?: string | null;
  bairro?: string | null;
  cidade?: string | null;
  uf?: string | null;
  pais?: string | null;
  endereco_estrangeiro?: string | null;
  endereco?: string | null;
  telefone?: string | null;
  email?: string | null;
  procedencia?: string | null;
  destino?: string | null;
  motivo_viagem?: string | null;
  meio_transporte?: string | null;
  placa_veiculo?: string | null;
  cor_veiculo?: string | null;
  modelo_veiculo?: string | null;
  data_confirmed?: boolean;
  privacy_accepted?: boolean;
  terms_version?: string | null;
  privacy_notice_version?: string | null;
  has_document_upload?: boolean;
  is_minor?: boolean;
  minor_relation?: string | null;
  minor_relation_other?: string | null;
  minor_accompaniment?: string | null;
  responsible_guest_id?: string | null;
};

export type FnrhCheckinV2Validation = {
  ok: boolean;
  missing: string[];
  errors: string[];
};

function hasText(v: unknown): boolean {
  return Boolean(v != null && String(v).trim() !== "");
}

function digitsOnly(v: unknown): string {
  return String(v ?? "").replace(/\D/g, "");
}

function isBrazilResident(draft: FnrhCheckinV2Draft): boolean {
  const pais = String(draft.pais ?? "Brasil").trim().toLowerCase();
  if (!pais || pais === "brasil" || pais === "brazil" || pais === "br") return true;
  const nacionalidade = String(draft.nacionalidade ?? "").trim().toLowerCase();
  if (nacionalidade.includes("brasil") || nacionalidade === "brasileira" || nacionalidade === "brasileiro") {
    return !hasText(draft.endereco_estrangeiro);
  }
  return false;
}

export function validateDocumentoStep(draft: FnrhCheckinV2Draft): FnrhCheckinV2Validation {
  const missing: string[] = [];
  const errors: string[] = [];
  if (!draft.is_minor && !draft.has_document_upload) missing.push("document_upload");
  if (!hasText(draft.documento_tipo) && !hasText(draft.documento)) missing.push("documento_tipo");
  if (!hasText(draft.documento_numero) && !hasText(draft.documento)) missing.push("documento_numero");
  if (!hasText(draft.data_nascimento)) missing.push("data_nascimento");
  return { ok: missing.length === 0 && errors.length === 0, missing, errors };
}

export function validateConfiraDadosStep(draft: FnrhCheckinV2Draft): FnrhCheckinV2Validation {
  const missing: string[] = [];
  if (!hasText(draft.hospede_nome)) missing.push("hospede_nome");
  if (!hasText(draft.data_nascimento)) missing.push("data_nascimento");
  if (!hasText(draft.nacionalidade)) missing.push("nacionalidade");
  if (!draft.is_minor) {
    if (!hasText(draft.telefone)) missing.push("telefone");
    if (!hasText(draft.email)) missing.push("email");
  }
  return { ok: missing.length === 0, missing, errors: [] };
}

export function validateEnderecoStep(draft: FnrhCheckinV2Draft): FnrhCheckinV2Validation {
  const missing: string[] = [];
  const errors: string[] = [];
  if (isBrazilResident(draft)) {
    const cep = digitsOnly(draft.cep);
    if (cep.length !== 8) missing.push("cep");
    if (!hasText(draft.logradouro)) missing.push("logradouro");
    if (!hasText(draft.numero)) missing.push("numero");
    if (!hasText(draft.bairro)) missing.push("bairro");
    if (!hasText(draft.cidade)) missing.push("cidade");
    if (!hasText(draft.uf) || String(draft.uf).trim().length !== 2) missing.push("uf");
  } else if (!hasText(draft.endereco_estrangeiro) && !hasText(draft.endereco)) {
    missing.push("endereco_estrangeiro");
  }
  return { ok: missing.length === 0 && errors.length === 0, missing, errors };
}

export function validateViagemStep(draft: FnrhCheckinV2Draft): FnrhCheckinV2Validation {
  const missing: string[] = [];
  if (!hasText(draft.procedencia)) missing.push("procedencia");
  if (!hasText(draft.destino)) missing.push("destino");
  if (!hasText(draft.motivo_viagem)) missing.push("motivo_viagem");
  if (!hasText(draft.meio_transporte)) missing.push("meio_transporte");
  const meio = String(draft.meio_transporte ?? "").toLowerCase();
  if (meio === "carro" || meio === "automovel" || meio === "veiculo") {
    if (!hasText(draft.placa_veiculo)) missing.push("placa_veiculo");
  }
  return { ok: missing.length === 0, missing, errors: [] };
}

export function validateMenorStep(draft: FnrhCheckinV2Draft): FnrhCheckinV2Validation {
  if (!draft.is_minor) return { ok: true, missing: [], errors: [] };
  const missing: string[] = [];
  const errors: string[] = [];
  if (!hasText(draft.responsible_guest_id)) missing.push("responsible_guest_id");
  if (!hasText(draft.minor_relation)) missing.push("minor_relation");
  if (draft.minor_relation === "outro" && !hasText(draft.minor_relation_other)) {
    missing.push("minor_relation_other");
  }
  if (!hasText(draft.minor_accompaniment)) missing.push("minor_accompaniment");
  return { ok: missing.length === 0 && errors.length === 0, missing, errors };
}

export function validateAceiteStep(draft: FnrhCheckinV2Draft): FnrhCheckinV2Validation {
  const missing: string[] = [];
  const errors: string[] = [];
  if (draft.data_confirmed !== true) missing.push("data_confirmed");
  if (draft.privacy_accepted !== true) missing.push("privacy_accepted");
  if (draft.terms_version !== FNRH_TERMS_VERSION) errors.push("terms_version_mismatch");
  if (draft.privacy_notice_version !== FNRH_PRIVACY_NOTICE_VERSION) {
    errors.push("privacy_notice_version_mismatch");
  }
  return { ok: missing.length === 0 && errors.length === 0, missing, errors };
}

/** Validação completa do confirm v2 (adulto ou menor via responsável). */
export function validateFnrhCheckinV2Confirm(draft: FnrhCheckinV2Draft): FnrhCheckinV2Validation {
  const parts = [
    validateDocumentoStep(draft),
    validateConfiraDadosStep(draft),
    validateEnderecoStep(draft),
    validateViagemStep(draft),
    validateMenorStep(draft),
    validateAceiteStep(draft),
  ];
  const missing = Array.from(new Set(parts.flatMap((p) => p.missing)));
  const errors = Array.from(new Set(parts.flatMap((p) => p.errors)));
  return { ok: missing.length === 0 && errors.length === 0, missing, errors };
}

export function composeEnderecoLegado(draft: FnrhCheckinV2Draft): string {
  if (hasText(draft.endereco_estrangeiro)) return String(draft.endereco_estrangeiro).trim();
  if (hasText(draft.endereco) && !hasText(draft.logradouro)) return String(draft.endereco).trim();
  const parts = [
    draft.logradouro,
    draft.numero ? `nº ${draft.numero}` : null,
    draft.complemento,
    draft.bairro,
    draft.cidade,
    draft.uf,
    draft.cep ? `CEP ${digitsOnly(draft.cep)}` : null,
    draft.pais || "Brasil",
  ]
    .map((p) => (p != null ? String(p).trim() : ""))
    .filter(Boolean);
  return parts.join(", ");
}

export function composeDocumentoLegado(draft: FnrhCheckinV2Draft): string {
  if (hasText(draft.documento_numero)) return String(draft.documento_numero).trim();
  return String(draft.documento ?? "").trim();
}

export function isFnrhOcrEnabled(envValue: string | undefined | null): boolean {
  return String(envValue ?? "").trim() === "true";
}

export function isFnrhFaceVerificationEnabled(envValue: string | undefined | null): boolean {
  return String(envValue ?? "").trim() === "true";
}
