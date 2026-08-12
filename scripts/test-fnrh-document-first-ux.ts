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

// F/G. OCR preenche e Confira dados mostra campos canônicos
{
  assert.match(js, /function applyOcrSuggestions/);
  assert.match(js, /Encontramos estes dados no seu documento/);
  assert.match(js, /Brasileiro — CPF/);
  assert.match(js, /Estrangeiro — Passaporte/);
  const confira = js.slice(js.indexOf("function renderConfiraDados()"), js.indexOf("function renderEndereco()"));
  assert.match(confira, /data-field="documento_tipo"/);
  assert.match(confira, /data-field="documento_numero"/);
  assert.match(confira, /data-field="data_nascimento"/);
  assert.match(confira, /optionHtml\(DOC_TYPES/);
  ok("F/G. OCR + Etapa 2 com campos editáveis canônicos");
}

// H. OCR fail-soft
{
  assert.match(
    js,
    /Alguns dados não foram identificados\. Confira e complete os campos abaixo\./,
  );
  ok("H. fallback manual após OCR");
}

// I. manual vence OCR (valor canônico preenchido)
{
  assert.match(js, /state\.fieldOrigin\[target\] === "manual"/);
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

// M. verso legado só se tipo RG/CNH (não é caminho canônico CPF/passaporte)
{
  assert.match(js, /function needsTwoSides\(docType\)/);
  assert.match(js, /function needsVersoAfterOcr\(\)/);
  assert.match(js, /function isCanonicalDocType/);
  assert.match(js, /Brasileiro — CPF/);
  ok("M. canônicos CPF/passaporte; verso só legado RG/CNH");
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

// Feedback visual OCR (A–I)
{
  assert.match(js, /Enviando documento…/);
  assert.match(js, /Lendo documento…/);
  assert.match(
    js,
    /Estamos identificando seus dados automaticamente\. Isso pode levar alguns segundos\./,
  );
  assert.match(js, /state\.confirmBusy \|\| state\.analyzing \? " disabled"/);
  assert.match(js, /state\.analyzingPhase === "ocr" \? "Lendo documento…" : "Enviando documento…"/);
  assert.match(js, /Leitura concluída ✓/);
  assert.match(js, /Conferir meus dados/);
  assert.match(js, /Documento recebido · lendo dados…/);
  assert.match(js, /role="status"/);
  assert.match(js, /aria-live="polite"/);
  assert.doesNotMatch(js, /%\s*completo|progresso:\s*\d|percentComplete|fakeProgress/i);
  assert.doesNotMatch(js, /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/);
  assert.match(html, /\.doc-process-status/);
  assert.match(html, /\.doc-spinner/);
  assert.match(html, /@keyframes doc-spin/);
  ok("feedback OCR: upload/OCR/final + botão + a11y + sem % falsa");
}

// Skip etapa Hóspedes vazia + texto final (A–I)
{
  assert.match(js, /function hasLinkedMinors\(\)/);
  assert.match(js, /function isStepVisible\(stepId\)/);
  assert.match(js, /function visibleSteps\(\)/);
  assert.match(js, /function nextVisibleStepIndex\(/);
  assert.match(js, /function ensureVisibleStepIndex\(\)/);
  assert.match(js, /stepId === "hospedes_menores" && !hasLinkedMinors\(\)/);
  assert.match(js, /state\.stepIndex = nextVisibleStepIndex\(state\.stepIndex, 1\)/);
  assert.match(js, /state\.stepIndex = nextVisibleStepIndex\(state\.stepIndex, -1\)/);
  assert.match(js, /stepMeta\.total/);
  assert.match(js, /stepMeta\.visualIndex/);
  // A/B: sem menores a etapa é invisível; navegação usa nextVisible (Viagem→Revisão)
  ok("A/B. skip hospedes_menores + Viagem→Revisão via nextVisible");

  // C: numeração visual recalculada
  assert.match(js, /visualNum/);
  assert.match(js, /visibleStepMeta\(\)/);
  ok("C. numeração visual dinâmica");

  // D/E: com menor a etapa permanece no STEPS e renderMenores valida parentesco
  assert.match(js, /id: "hospedes_menores"/);
  assert.match(js, /function renderMenores\(\)/);
  assert.match(js, /Confirme o parentesco e o acompanhamento de cada menor/);
  assert.match(js, /Informe o parentesco de cada menor/);
  ok("D/E. com menor etapa e regras preservadas");

  // F: reload não fica em step inválido
  assert.match(js, /ensureVisibleStepIndex\(\)/);
  assert.match(js, /function render\(\) \{\s*\r?\n\s*ensureVisibleStepIndex\(\)/);
  ok("F. ensureVisibleStepIndex no render (reload seguro)");

  // G/H: texto final novo; antigo removido
  const concluido = js.slice(js.indexOf("function renderConcluido()"), js.indexOf("function render()"));
  assert.match(concluido, /Check-in concluído/);
  assert.match(concluido, /Sua ficha de registro \(FNRH\) foi confirmada com sucesso\./);
  assert.match(concluido, /As credenciais de acesso e demais orientações serão enviadas em breve\./);
  assert.match(concluido, /Seja bem-vindo\(a\) ao Yes Hotel\./);
  assert.doesNotMatch(
    concluido,
    /não há envio imediato de senha só por concluir esta etapa/,
  );
  assert.doesNotMatch(concluido, /Se precisar de ajuda, fale com a recepção/);
  assert.doesNotMatch(concluido, /seguem as regras do hotel e são enviadas quando estiverem prontas/);
  ok("G/H. texto final novo; texto antigo removido");

  // I: sem alteração de acesso/pagamento/TTLock neste arquivo
  assert.doesNotMatch(js, /ttlock|pagarme|liberar.?acesso|gerar.?senha/i);
  ok("I. sem regra de acesso/pagamento/TTLock no UI FNRH");
}

console.log("\nPASS test-fnrh-document-first-ux\n");
