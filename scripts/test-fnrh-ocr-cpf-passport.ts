/**
 * FNRH OCR — CPF brasileiro / passaporte estrangeiro (canônicos).
 * Fixtures sintéticas apenas. Sem PII real / tokens / storage paths.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildOcrPersistPatch,
  canonicalizeOcrSuggestedFields,
  isNonCanonicalDocumentoTipo,
} from "../src/lib/domain/yes-hotel/fnrh-ocr-apply-suggestions";
import {
  extractExplicitPassportNumber,
  extractExplicitValidCpf,
  isValidCpf,
  normalizeGoogleVisionText,
} from "../src/lib/domain/yes-hotel/fnrh-ocr-normalize-google";
import { shouldApplySuggestedValue } from "../src/lib/domain/yes-hotel/fnrh-field-provenance";

/** CPF sintético com checksum válido (não é identidade real de terceiro). */
const VALID_CPF = "52998224725";
const INVALID_CPF = "11111111111";
const RANDOM_11 = "12345678901"; // checksum inválido

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

const CNH_SYNTH = [
  "REPÚBLICA FEDERATIVA DO BRASIL",
  "CARTEIRA NACIONAL DE HABILITAÇÃO",
  "NOME: ANA TESTE SILVA",
  "DOC. IDENTIDADE / ORG. EMISSOR: 1234567 SSP/MS",
  "CPF: 529.982.247-25",
  "DATA NASCIMENTO: 15/03/1990",
  "Nº REGISTRO: 01234567890",
  "CAT. HAB.: B",
  "VALIDADE: 10/10/2030",
].join("\n");

const RG_SYNTH = [
  "REGISTRO GERAL",
  "NOME: BRUNO TESTE SOUZA",
  "RG: 12.345.678-9",
  "CPF: 529.982.247-25",
  "DATA DE NASCIMENTO: 20/01/1988",
  "NACIONALIDADE: BRASILEIRA",
].join("\n");

const PASSPORT_SYNTH = [
  "PASSPORT",
  "PASSAPORTE",
  "NOME / NAME: CARLA TESTE LIMA",
  "PASSPORT NO: AB1234567",
  "DATE OF BIRTH: 05/05/1985",
  "NATIONALITY: PORTUGUESA",
  "P<PRTTESTELIMA<<CARLA<<<<<<<<<<<<<<<<<<",
].join("\n");

const NO_ID_SYNTH = [
  "DOCUMENTO GENÉRICO",
  "NOME: DELTA TESTE",
  "DATA DE NASCIMENTO: 01/01/2000",
].join("\n");

console.log("\n=== FNRH OCR CPF / Passaporte canônico ===\n");

// A — CNH sintética com CPF + registro → CPF canônico
{
  const n = normalizeGoogleVisionText({
    fullText: CNH_SYNTH,
    requested_document_type: "other",
  });
  assert.equal(n.suggested_fields.documento_tipo, "cpf");
  assert.equal(n.suggested_fields.documento_numero, VALID_CPF);
  assert.equal(n.suggested_fields.cpf, VALID_CPF);
  assert.notEqual(n.suggested_fields.documento_numero, "01234567890");
  ok("A. CNH sintética → documento_tipo=cpf (registro ignorado)");
}

// B — RG/CIN com CPF → CPF
{
  const n = normalizeGoogleVisionText({
    fullText: RG_SYNTH,
    requested_document_type: "other",
  });
  assert.equal(n.suggested_fields.documento_tipo, "cpf");
  assert.equal(n.suggested_fields.documento_numero, VALID_CPF);
  assert.notEqual(String(n.suggested_fields.documento_numero), "123456789");
  ok("B. RG sintético → CPF (número RG ignorado)");
}

// C — CPF inválido rejeitado
{
  assert.equal(isValidCpf(INVALID_CPF), false);
  assert.equal(extractExplicitValidCpf(`CPF: ${INVALID_CPF}`), null);
  const n = normalizeGoogleVisionText({
    fullText: `NOME: X\nCPF: 111.111.111-11\nNº REGISTRO: 99999999999\n`,
    requested_document_type: "other",
  });
  assert.equal(n.suggested_fields.cpf, undefined);
  assert.equal(n.suggested_fields.documento_tipo, undefined);
  ok("C. CPF inválido rejeitado");
}

// D — 11 dígitos aleatórios sem rótulo → não promove
{
  assert.equal(extractExplicitValidCpf(RANDOM_11), null);
  assert.equal(extractExplicitValidCpf(`REGISTRO: ${VALID_CPF}`), null);
  const n = normalizeGoogleVisionText({
    fullText: `NOME: Y\nREGISTRO: ${VALID_CPF}\n`,
    requested_document_type: "other",
  });
  assert.equal(n.suggested_fields.documento_tipo, undefined);
  assert.equal(n.suggested_fields.documento_numero, undefined);
  ok("D. 11 dígitos sem rótulo CPF → não promove");
}

// E — Passaporte sintético
{
  const n = normalizeGoogleVisionText({
    fullText: PASSPORT_SYNTH,
    requested_document_type: "other",
  });
  assert.equal(n.suggested_fields.documento_tipo, "passport");
  assert.equal(n.suggested_fields.documento_numero, "AB1234567");
  assert.ok(extractExplicitPassportNumber(PASSPORT_SYNTH));
  ok("E. Passaporte sintético → passport");
}

// F — Sem CPF/passaporte seguro
{
  const n = normalizeGoogleVisionText({
    fullText: NO_ID_SYNTH,
    requested_document_type: "other",
  });
  assert.equal(n.suggested_fields.documento_tipo, undefined);
  assert.equal(n.suggested_fields.documento_numero, undefined);
  assert.ok(n.suggested_fields.hospede_nome || n.suggested_fields.data_nascimento);
  ok("F. Sem identificador → não inventa");
}

// G — requested other não vira documento_tipo=other
{
  const n = normalizeGoogleVisionText({
    fullText: NO_ID_SYNTH,
    requested_document_type: "other",
  });
  assert.notEqual(n.suggested_fields.documento_tipo, "other");
  assert.equal(isNonCanonicalDocumentoTipo("other"), true);
  const canon = canonicalizeOcrSuggestedFields({
    documento_tipo: "other",
    documento_numero: "XYZ",
  });
  assert.equal(canon.documento_tipo, undefined);
  ok("G. other não vira documento_tipo");
}

// H — persistência server-side (patch) permite resume
{
  const patch = buildOcrPersistPatch({
    currentRow: {
      hospede_nome: "",
      documento_tipo: "other",
      documento_numero: "",
      data_nascimento: null,
      nacionalidade: "",
    },
    currentProvenance: { documento_tipo: "manual" },
    suggested: {
      documento_tipo: "cpf",
      documento_numero: VALID_CPF,
      cpf: VALID_CPF,
      hospede_nome: "ANA TESTE SILVA",
      data_nascimento: "1990-03-15",
    },
  });
  assert.equal(patch.update.documento_tipo, "cpf");
  assert.equal(patch.update.documento_numero, VALID_CPF);
  assert.equal(patch.provenanceUpdates.documento_tipo, "ocr");
  assert.equal(patch.provenanceUpdates.documento_numero, "ocr");
  assert.ok(patch.appliedKeys.includes("documento_numero"));
  ok("H. OCR persist patch (resume server-side)");
}

// I — manual existente não sobrescrito
{
  const patch = buildOcrPersistPatch({
    currentRow: { hospede_nome: "NOME MANUAL", documento_tipo: "cpf", documento_numero: "000" },
    currentProvenance: { hospede_nome: "manual", documento_numero: "manual" },
    suggested: { hospede_nome: "NOME OCR", documento_numero: VALID_CPF, documento_tipo: "cpf", cpf: VALID_CPF },
  });
  assert.equal(patch.update.hospede_nome, undefined);
  assert.equal(patch.update.documento_numero, undefined);
  ok("I. manual não sobrescrito por OCR");
}

// J — HITS pode ser substituído por OCR
{
  assert.equal(
    shouldApplySuggestedValue({
      currentValue: "hits-nome",
      currentOrigin: "hits",
      suggestedOrigin: "ocr",
    }),
    true,
  );
  const patch = buildOcrPersistPatch({
    currentRow: { hospede_nome: "HITS NOME" },
    currentProvenance: { hospede_nome: "hits" },
    suggested: { hospede_nome: "OCR NOME" },
  });
  assert.equal(patch.update.hospede_nome, "OCR NOME");
  assert.equal(patch.provenanceUpdates.hospede_nome, "ocr");
  ok("J. OCR substitui hits conforme precedência");
}

// K/L — autosave dirty: contract no UI + submit
{
  const js = readFileSync(resolve("ui/fnrh-checkin-v2.js"), "utf8");
  assert.match(js, /dirtyManualFields/);
  assert.match(js, /dirty_manual_fields/);
  assert.match(js, /function markDirtyManual/);
  const submit = readFileSync(resolve("supabase/functions/fnrh-submit/index.ts"), "utf8");
  assert.match(submit, /dirty_manual_fields/);
  assert.match(submit, /parseDirtyManualFields/);
  assert.match(submit, /if \(dirty\?\.has\(k\)\)/);
  ok("K/L. autosave dirty preserva ocr/hits (contrato)");
}

// M — edição real → manual (contrato UI)
{
  const js = readFileSync(resolve("ui/fnrh-checkin-v2.js"), "utf8");
  assert.match(js, /markDirtyManual\(key\)/);
  assert.match(js, /state\.fieldOrigin\[key\] = "manual"/);
  ok("M. edição real marca dirty + manual");
}

// N — banner única na Etapa 2 + UI canônica
{
  const js = readFileSync(resolve("ui/fnrh-checkin-v2.js"), "utf8");
  assert.match(js, /step\.id !== "confira_dados"/);
  assert.match(js, /Encontramos estes dados no seu documento/);
  assert.match(js, /Alguns dados não foram identificados/);
  assert.match(js, /Brasileiro — CPF/);
  assert.match(js, /Estrangeiro — Passaporte/);
  // DOC_TYPES só cpf/passport (sem cnh/rg/other como opção de jornada)
  const docTypesBlock = js.slice(js.indexOf("var DOC_TYPES = ["), js.indexOf("];", js.indexOf("var DOC_TYPES = [")) + 2);
  assert.match(docTypesBlock, /value: "cpf"/);
  assert.match(docTypesBlock, /value: "passport"/);
  assert.doesNotMatch(docTypesBlock, /value: "cnh"/);
  assert.doesNotMatch(docTypesBlock, /value: "rg"/);
  assert.doesNotMatch(docTypesBlock, /value: "other"/);
  ok("N. banner única + UI CPF/Passaporte");
}

// O — sem PII/token em fixtures deste arquivo
{
  const self = readFileSync(resolve("scripts/test-fnrh-ocr-cpf-passport.ts"), "utf8");
  assert.doesNotMatch(self, /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/);
  assert.doesNotMatch(self, /storage\/v1\/object/);
  ok("O. sem JWT/storage path neste teste");
}

// Persist upload edge contract
{
  const upload = readFileSync(resolve("supabase/functions/fnrh-document-upload/index.ts"), "utf8");
  assert.match(upload, /buildOcrPersistPatch/);
  assert.match(upload, /ocr_persisted_fields/);
  ok("upload persiste OCR server-side");
}

console.log(`\nPASS test-fnrh-ocr-cpf-passport (${passed} checks)\n`);
