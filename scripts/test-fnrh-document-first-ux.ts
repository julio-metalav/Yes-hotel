/**
 * FNRH document-first UX — asserts estáticos no HTML/JS da jornada v2.
 * Sem rede e sem PII/token.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shouldApplySuggestedValue } from "../src/lib/domain/yes-hotel/fnrh-field-provenance";
import {
  validateConfiraDadosStep,
  validateDocumentoStep,
} from "../src/lib/domain/yes-hotel/fnrh-checkin-v2-policy";

const ROOT = resolve(".");
const js = readFileSync(resolve(ROOT, "ui/fnrh-checkin-v2.js"), "utf8");
const html = readFileSync(resolve(ROOT, "ui/fnrh-preenchimento.html"), "utf8");

function ok(label: string) {
  console.log(`  ok — ${label}`);
}

// A. Etapa 1 sem tipo/número/nascimento no renderDocumento
{
  const start = js.indexOf("function renderDocumento()");
  const end = js.indexOf("function renderConfiraDados()");
  assert.ok(start > 0 && end > start);
  const slice = js.slice(start, end);
  assert.doesNotMatch(slice, /data-field="documento_tipo"/);
  assert.doesNotMatch(slice, /data-field="documento_numero"/);
  assert.doesNotMatch(slice, /data-field="data_nascimento"/);
  assert.doesNotMatch(slice, /<select data-field="documento_tipo">/);
  ok("A. Etapa 1 sem tipo/número/nascimento");
}

// B. CTA Tirar foto
{
  assert.match(js, /Tirar foto do documento/);
  assert.match(js, /doc-cta--primary/);
  assert.match(js, /btn-doc-camera/);
  ok("B. CTA Tirar foto do documento");
}

// C. input câmera oculto com capture=environment + accept image/*
{
  assert.match(
    js,
    /id="doc-camera-front"[^>]*accept="image\/\*"[^>]*capture="environment"/,
  );
  ok("C. câmera oculta accept=image/* capture=environment");
}

// D. file picker secundário sem capture
{
  assert.match(js, /id="doc-file-front"[^>]*accept="image\/\*,application\/pdf"/);
  const fileFront = js.match(/id="doc-file-front"[^>]*>/);
  assert.ok(fileFront);
  assert.doesNotMatch(fileFront![0], /capture=/);
  ok("D. file picker secundário sem capture");
}

// E. upload pode iniciar sem documento_tipo
{
  assert.match(js, /document_type", state\.documento_tipo \|\| "other"/);
  ok("E. upload com document_type=other sem tipo prévio");
}

// F/G. OCR preenche e Confira dados mostra campos
{
  assert.match(js, /function applyOcrSuggestions/);
  const confira = js.slice(js.indexOf("function renderConfiraDados()"), js.indexOf("function renderEndereco()"));
  assert.match(confira, /data-field="documento_tipo"/);
  assert.match(confira, /data-field="documento_numero"/);
  assert.match(confira, /data-field="data_nascimento"/);
  assert.match(confira, /Encontramos estes dados no seu documento/);
  ok("F/G. OCR + Etapa 2 com campos editáveis");
}

// H. OCR fail-soft
{
  assert.match(
    js,
    /Não conseguimos ler todos os dados automaticamente\. Você pode preenchê-los na próxima etapa\./,
  );
  ok("H. fallback manual após OCR");
}

// I. manual vence OCR
{
  assert.match(js, /if \(state\.fieldOrigin\[target\] === "manual"\) return;/);
  assert.equal(
    shouldApplySuggestedValue({
      currentValue: "ABC",
      currentOrigin: "manual",
      suggestedOrigin: "ocr",
    }),
    false,
  );
  ok("I. manual posterior vence OCR");
}

// J. HITS permanece quando OCR não traz; OCR pode sobrescrever hits
{
  assert.equal(
    shouldApplySuggestedValue({
      currentValue: "hits-val",
      currentOrigin: "hits",
      suggestedOrigin: "ocr",
    }),
    true,
  );
  assert.equal(
    shouldApplySuggestedValue({
      currentValue: "hits-val",
      currentOrigin: "hits",
      suggestedOrigin: "hits",
    }),
    false,
  );
  ok("J. OCR sobrescreve hits; hits não sobrescreve hits");
}

// K. menor continua sem link próprio (gate no start)
{
  assert.match(js, /if \(data\.is_minor\)/);
  assert.match(js, /responsável/);
  ok("K. menor sem jornada própria");
}

// L. documento obrigatório para concluir etapa 1
{
  assert.equal(validateDocumentoStep({ has_document_upload: false }).ok, false);
  assert.equal(validateDocumentoStep({ has_document_upload: true }).ok, true);
  ok("L. upload obrigatório na etapa Documento");
}

// M. verso só após tipo RG/CNH (needsTwoSides + needsVersoAfterOcr)
{
  assert.match(js, /function needsTwoSides\(docType\)/);
  assert.match(js, /function needsVersoAfterOcr\(\)/);
  assert.match(js, /Tirar foto do verso/);
  ok("M. verso após OCR quando RG/CNH");
}

// N. Google Vision path intacto (upload edge + applyOcrSuggestions)
{
  assert.match(js, /fnrh-document-upload/);
  assert.match(js, /suggested_fields/);
  ok("N. reutiliza fnrh-document-upload / suggested_fields");
}

// O. sem token/PII hardcoded
{
  assert.doesNotMatch(js, /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/);
  assert.doesNotMatch(html, /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/);
  ok("O. sem JWT/PII nos assets");
}

// Confira dados exige tipo/número/nascimento
{
  const bad = validateConfiraDadosStep({
    hospede_nome: "A",
    nacionalidade: "BR",
    telefone: "1",
    email: "a@b.com",
    documento_tipo: "",
    documento_numero: "",
    data_nascimento: "",
  });
  assert.equal(bad.ok, false);
  ok("Confira dados exige documento + nascimento");
}

assert.match(html, /\.doc-cta--primary/);
assert.match(html, /\.sr-only-file/);
ok("CSS document-first presente");

console.log("\nPASS test-fnrh-document-first-ux\n");
