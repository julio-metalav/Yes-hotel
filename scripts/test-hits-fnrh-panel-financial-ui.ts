/**
 * Testes auxiliares HITS → FNRH provenance + painel (asserts estáticos).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  mergeFieldProvenance,
  shouldApplySuggestedValue,
} from "../src/lib/domain/yes-hotel/fnrh-field-provenance.ts";

// 17–19 FNRH precedence
{
  assert.equal(
    shouldApplySuggestedValue({
      currentValue: "",
      currentOrigin: null,
      suggestedOrigin: "hits",
    }),
    true,
  );
  assert.equal(
    shouldApplySuggestedValue({
      currentValue: "Manual",
      currentOrigin: "manual",
      suggestedOrigin: "hits",
    }),
    false,
  );
  assert.equal(
    shouldApplySuggestedValue({
      currentValue: "OCR",
      currentOrigin: "ocr",
      suggestedOrigin: "hits",
    }),
    false,
  );
  const merged = mergeFieldProvenance({ nome: "manual" }, { email: "hits", nome: "hits" });
  assert.equal(merged.nome, "manual");
  assert.equal(merged.email, "hits");
}

const panel = readFileSync(resolve("ui/checkin-operacional-mvp.js"), "utf8");
const html = readFileSync(resolve("ui/checkin-operacional-mvp.html"), "utf8");
const finJs = readFileSync(resolve("ui/yes-reservation-financial.js"), "utf8");

// 15–16 hóspedes HITS read-only / sem adicionar acompanhante no fluxo HITS
assert.match(panel, /hitsGuestsReadonly/);
assert.match(panel, /Corrigir contato/);
assert.doesNotMatch(
  panel.slice(panel.indexOf("hitsGuestsReadonly"), panel.indexOf("hitsGuestsReadonly") + 800),
  /showHeaderAdd:\s*true/,
);

// 20–22 UI
assert.match(panel, /buildOrigemComercialHtml/);
assert.match(panel, /Situação atual/);
assert.match(panel, /Cobrança Pagar\.me fica no card Situação/);
assert.match(html, /yes-reservation-financial\.js/);
assert.match(finJs, /Pendente \(comissionado\)/);
assert.match(panel, /Histórico da reserva/);

console.log("ok: test-hits-fnrh-panel-financial-ui");
