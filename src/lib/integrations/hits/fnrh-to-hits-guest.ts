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

/** Nenhum enum resolvido. Base para testes e para o que ainda não se sabe. */
export const FNRH_TO_HITS_ENUMS_UNCONFIRMED: FnrhToHitsEnumMap = {};

/**
 * Enum de documento conhecido, documentado em `types.ts:150` a partir do
 * Swagger: 1=Passaporte, 2=CPF, 3=RG, 7=Certidão de nascimento. A allowlist da
 * busca (`query.ts`) usa a mesma faixa.
 *
 * Referência — não é o que se envia. Ver `FNRH_TO_HITS_ENUMS_CONFIRMED`.
 */
export const HITS_DOC_TYPE_CONHECIDOS = {
  passport: 1,
  cpf: 2,
  rg: 3,
  birth_certificate: 7,
} as const satisfies Record<string, HitsGuestDocumentType>;

/**
 * De/para efetivo do fluxo FNRH → `PUT /Datashare/WebCheckinOut/Guests`.
 *
 * O HITS recusa o PUT sem documento principal
 * (`400 "Deve haver ao menos um documento principal informado"`), e exige CPF ou
 * passaporte para a confirmação. Só esses dois entram por padrão.
 *
 * RG e certidão de nascimento têm enum conhecido (acima), mas não está
 * confirmado que satisfazem a exigência de documento principal neste PUT —
 * enviá-los poderia gravar um documento que o HITS não aceita como principal.
 * `cnh` e `other` não têm enum: 4, 5 e 6 existem na faixa de escrita sem
 * significado documentado.
 *
 * Contato — confirmado por round-trip no Sandbox (16/09/2026, tenant develop):
 * `PUT contact1 + contactType1=1` com um e-mail apareceu em `contactMail`;
 * `contactType1=2` com um número apareceu em `contactPhone`. O GET de hóspede
 * não expõe tipo, então esta era a única via. Atenção: os testes do gateway
 * usam `contactType: 2` com e-mail — convenção antiga, semanticamente invertida.
 * 3 e 4 continuam sem significado conhecido.
 *
 * Sexo, motivo da viagem e meio de transporte seguem sem legenda e omitidos.
 */
export const FNRH_TO_HITS_ENUMS_CONFIRMED: FnrhToHitsEnumMap = {
  docType: {
    cpf: HITS_DOC_TYPE_CONHECIDOS.cpf,
    passport: HITS_DOC_TYPE_CONHECIDOS.passport,
  },
  contactTypeEmail: 1,
  contactTypePhone: 2,
};

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

/**
 * Documento sem máscara. A FNRH valida por dígitos mas grava o texto digitado
 * ("123.456.789-09"); o HITS quer o número. Passaporte é alfanumérico, então a
 * limpeza só remove pontuação quando o valor é claramente numérico mascarado.
 */
export function stripDocumentMask(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  // Só vira dígitos puros quando não há letra: preserva passaporte "AB123456".
  return /[A-Za-z]/.test(raw) ? raw : digits;
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
  /** Default: só os enums confirmados. Injetável para teste. */
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
  const enums = input.enums ?? FNRH_TO_HITS_ENUMS_CONFIRMED;

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
  const doc = stripDocumentMask(fnrh.documento_numero);
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

  // --- Contatos: o HITS exige o par contactN + contactTypeN. Os slots são
  //     preenchidos em sequência: com um contato só, ele vai em contact1 — o
  //     formato provado no Sandbox (contact2 sozinho não foi testado). Com um
  //     valor apenas, o segundo contato não é inventado.
  const contatos: Array<[string, HitsGuestContactType | undefined, string]> = [
    ["telefone", enums.contactTypePhone, clean(fnrh.telefone)],
    ["email", enums.contactTypeEmail, clean(fnrh.email)],
  ];
  let slot = 1;
  for (const [campo, tipo, valor] of contatos) {
    if (!valor) {
      skip(`contato_${campo}`, "vazio");
      continue;
    }
    if (tipo == null) {
      skip(`contato_${campo}`, "enum_nao_confirmado");
      continue;
    }
    add(`contact${slot}` as keyof HitsGuestsPutDto, valor);
    add(`contactType${slot}` as keyof HitsGuestsPutDto, tipo);
    slot += 1;
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
