/**
 * FNRH (Yes) → DTO de atualização de PAX aceito pelo gateway (`PUT /v1/guests`).
 *
 * Função pura: sem fetch, sem Supabase, sem env, sem efeito colateral. Só
 * transforma dados. Quem chama decide o que fazer com o resultado.
 *
 * Princípio: **na dúvida, omitir**. Um campo ausente deixa o cadastro do HITS
 * como está; um campo errado corrompe dado de hóspede. Por isso os enums do
 * contrato (docType, contactType, gender, purposeTrip, arrivingBy) só são
 * enviados quando o de/para for confirmado com a HITS — ver ENUMS abaixo.
 */

import type {
  HitsGuestAddress,
  HitsGuestArrivingBy,
  HitsGuestContactType,
  HitsGuestDocumentType,
  HitsGuestGender,
  HitsGuestPurposeTrip,
  HitsGuestsPutDto,
} from "./types.ts";

/** Colunas de `fnrh_hospedes` usadas aqui. Todas opcionais: a ficha pode estar parcial. */
export type FnrhGuestData = {
  hospede_nome?: string | null;
  data_nascimento?: string | null;
  documento_numero?: string | null;
  documento_tipo?: string | null;
  telefone?: string | null;
  email?: string | null;
  sexo?: string | null;
  cep?: string | null;
  logradouro?: string | null;
  numero?: string | null;
  complemento?: string | null;
  bairro?: string | null;
  cidade?: string | null;
  uf?: string | null;
  pais?: string | null;
  motivo_viagem?: string | null;
  meio_transporte?: string | null;
  placa_veiculo?: string | null;
  /** Texto livre. Nunca vira `nationalityCountryId` — ver README do mapa. */
  nacionalidade?: string | null;
};

/**
 * De/para dos enums do contrato HITS.
 *
 * `types.ts:168-175` declara apenas as FAIXAS válidas ("Enums Swagger V1"), sem
 * dizer o que cada número significa, e nada no repositório documenta isso —
 * `HOMOLOGACAO-PAX.md` usa `docType: 2` e `contactType: 2` em exemplos, sem
 * legenda. Enviar um palpite gravaria "passaporte" onde é CPF.
 *
 * Enquanto o de/para não for confirmado com a HITS, estes campos são OMITIDOS.
 * Ao confirmar, preencher aqui — a lógica abaixo não muda.
 */
export type FnrhToHitsEnumMap = {
  /** `documento_tipo` normalizado (minúsculo, sem acento) → docType. */
  docType?: Record<string, HitsGuestDocumentType>;
  /** Tipo de contato para telefone e para e-mail. */
  contactTypePhone?: HitsGuestContactType;
  contactTypeEmail?: HitsGuestContactType;
  /** `sexo` normalizado → gender. */
  gender?: Record<string, HitsGuestGender>;
  /** `motivo_viagem` normalizado → purposeTrip. */
  purposeTrip?: Record<string, HitsGuestPurposeTrip>;
  /** `meio_transporte` normalizado → arrivingBy. */
  arrivingBy?: Record<string, HitsGuestArrivingBy>;
};

/** Default: nenhum enum confirmado. Trocar só com o Swagger em mãos. */
export const FNRH_TO_HITS_ENUMS_UNCONFIRMED: FnrhToHitsEnumMap = {};

/** Motivo pelo qual um campo não entrou — diagnóstico sem valor, só rótulo. */
export type FnrhToHitsOmission = {
  field: string;
  reason: "vazio" | "enum_nao_confirmado" | "sem_campo_no_contrato";
};

export type FnrhToHitsResult = {
  dto: HitsGuestsPutDto;
  /** Nomes dos campos enviados. Seguro para log — sem valores. */
  included: string[];
  omitted: FnrhToHitsOmission[];
};

function clean(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

/** Chave de lookup estável: minúscula, sem acento, sem espaço duplo. */
export function normalizeEnumKey(value: unknown): string {
  return clean(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

/** Só a data; o HITS aceita `YYYY-MM-DD`. Formato inesperado é omitido. */
function toBirthdate(value: unknown): string | null {
  const raw = clean(value);
  if (!raw) return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1]! : null;
}

function buildAddress(fnrh: FnrhGuestData): HitsGuestAddress | null {
  const address: HitsGuestAddress = {};
  const pairs: Array<[keyof HitsGuestAddress, string]> = [
    ["address", clean(fnrh.logradouro)],
    ["number", clean(fnrh.numero)],
    ["details", clean(fnrh.complemento)],
    ["neighborhood", clean(fnrh.bairro)],
    ["city", clean(fnrh.cidade)],
    ["state", clean(fnrh.uf)],
    ["country", clean(fnrh.pais)],
    ["zipCode", clean(fnrh.cep)],
  ];
  let has = false;
  for (const [key, value] of pairs) {
    if (!value) continue;
    (address as Record<string, string>)[key] = value;
    has = true;
  }
  return has ? address : null;
}

export type BuildHitsGuestPutInput = {
  idEntity: number;
  idReservation: number;
  fnrh: FnrhGuestData;
  /** Default: nenhum enum. Injetável para teste e para o dia da confirmação. */
  enums?: FnrhToHitsEnumMap;
};

/**
 * Monta o DTO do `PUT /v1/guests`. Não valida o contrato — quem valida é o
 * gateway (`guest-write.ts`), que é a fronteira única de escrita.
 */
export function buildHitsGuestPutFromFnrh(
  input: BuildHitsGuestPutInput,
): FnrhToHitsResult {
  const fnrh = input.fnrh ?? {};
  const enums = input.enums ?? FNRH_TO_HITS_ENUMS_UNCONFIRMED;

  const dto: HitsGuestsPutDto = {
    idEntity: input.idEntity,
    idReservation: input.idReservation,
  };
  const included: string[] = [];
  const omitted: FnrhToHitsOmission[] = [];

  const add = (field: keyof HitsGuestsPutDto, value: unknown): void => {
    (dto as Record<string, unknown>)[field] = value;
    included.push(field);
  };
  const skip = (field: string, reason: FnrhToHitsOmission["reason"]): void => {
    omitted.push({ field, reason });
  };

  // --- Diretos: sem enum, sem ambiguidade ---
  const name = clean(fnrh.hospede_nome);
  if (name) add("name", name);
  else skip("name", "vazio");

  const birthdate = toBirthdate(fnrh.data_nascimento);
  if (birthdate) add("birthdate", birthdate);
  else skip("birthdate", "vazio");

  const plate = clean(fnrh.placa_veiculo);
  if (plate) add("carLicensePlate", plate);
  else skip("carLicensePlate", "vazio");

  const address = buildAddress(fnrh);
  if (address) add("addresses", [address]);
  else skip("addresses", "vazio");

  // --- Documento: número e tipo andam juntos (contrato do POST). Sem o de/para
  //     de docType confirmado, enviar o número isolado gravaria um documento sem
  //     tipo — os dois ficam de fora.
  const doc = clean(fnrh.documento_numero);
  const docTypeKey = normalizeEnumKey(fnrh.documento_tipo);
  const docType = enums.docType?.[docTypeKey];
  if (doc && docType != null) {
    add("doc", doc);
    add("docType", docType);
  } else if (!doc) {
    skip("doc", "vazio");
  } else {
    skip("doc", "enum_nao_confirmado");
    skip("docType", "enum_nao_confirmado");
  }

  // --- Contatos: o HITS exige o par contactN + contactTypeN ---
  const phone = clean(fnrh.telefone);
  if (phone && enums.contactTypePhone != null) {
    add("contact1", phone);
    add("contactType1", enums.contactTypePhone);
  } else if (!phone) {
    skip("contact1", "vazio");
  } else {
    skip("contact1", "enum_nao_confirmado");
  }

  const email = clean(fnrh.email);
  if (email && enums.contactTypeEmail != null) {
    add("contact2", email);
    add("contactType2", enums.contactTypeEmail);
  } else if (!email) {
    skip("contact2", "vazio");
  } else {
    skip("contact2", "enum_nao_confirmado");
  }

  // --- Enums puros ---
  const gender = enums.gender?.[normalizeEnumKey(fnrh.sexo)];
  if (gender != null) add("gender", gender);
  else if (clean(fnrh.sexo)) skip("gender", "enum_nao_confirmado");
  else skip("gender", "vazio");

  const purposeTrip = enums.purposeTrip?.[normalizeEnumKey(fnrh.motivo_viagem)];
  if (purposeTrip != null) add("purposeTrip", purposeTrip);
  else if (clean(fnrh.motivo_viagem)) skip("purposeTrip", "enum_nao_confirmado");
  else skip("purposeTrip", "vazio");

  const arrivingBy = enums.arrivingBy?.[normalizeEnumKey(fnrh.meio_transporte)];
  if (arrivingBy != null) add("arrivingBy", arrivingBy);
  else if (clean(fnrh.meio_transporte)) skip("arrivingBy", "enum_nao_confirmado");
  else skip("arrivingBy", "vazio");

  // --- Sem correspondência no contrato atual ---
  // nacionalidade: o HITS quer `nationalityCountryId` numérico; a FNRH guarda
  // texto. Sem tabela de países, não há conversão honesta.
  if (clean(fnrh.nacionalidade)) skip("nationalityCountryId", "sem_campo_no_contrato");

  return { dto, included, omitted };
}

/** O PUT exige ao menos um campo além dos identificadores. */
export function hasUpdatableFields(result: FnrhToHitsResult): boolean {
  return result.included.length > 0;
}
