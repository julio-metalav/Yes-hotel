/**
 * Testes FNRH check-in digital v2 — cenários A–L (domínio puro + flags).
 * Sem I/O de rede real; ViaCEP com fetch mock; OCR no-op.
 */
import assert from "node:assert/strict";
import {
  composeDocumentoLegado,
  composeEnderecoLegado,
  FNRH_PRIVACY_NOTICE_VERSION,
  FNRH_TERMS_VERSION,
  isFnrhFaceVerificationEnabled,
  isFnrhOcrEnabled,
  validateAceiteStep,
  validateConfiraDadosStep,
  validateDocumentoStep,
  validateEnderecoStep,
  validateFnrhCheckinV2Confirm,
  validateMenorStep,
  validateViagemStep,
  type FnrhCheckinV2Draft,
} from "../src/lib/domain/yes-hotel/fnrh-checkin-v2-policy";
import {
  buildConfirmationProof,
  canonicalizeJson,
  serializeConfirmationSnapshot,
} from "../src/lib/domain/yes-hotel/fnrh-confirmation-snapshot";
import {
  mergeFieldProvenance,
  preferFieldOrigin,
  shouldApplySuggestedValue,
} from "../src/lib/domain/yes-hotel/fnrh-field-provenance";
import { createFnrhOcrProvider, NoopFnrhOcrProvider } from "../src/lib/domain/yes-hotel/fnrh-ocr-port";
import { createViaCepProvider, normalizeCepDigits } from "../src/lib/domain/yes-hotel/fnrh-cep-port";
import { evaluateReservationFnrhState } from "../src/lib/domain/yes-hotel/reservation-fnrh-state";
import { evaluateFnrhCompletion } from "../src/lib/domain/yes-hotel/fnrh-completion-policy";
import {
  assertAuditPayloadSafe,
  sanitizeFnrhAuditState,
} from "../src/lib/domain/yes-hotel/fnrh-audit-sanitize";
import { resolveEffectiveFnrhStatusSource } from "../src/lib/infrastructure/supabase/yes-hotel/reservation-pending-mapper";

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

const G_ADULT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const G_MINOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const G_RESP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FNRH_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RES_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function adultDraft(partial: Partial<FnrhCheckinV2Draft> = {}): FnrhCheckinV2Draft {
  return {
    has_document_upload: true,
    documento_tipo: "rg",
    documento_numero: "1234567",
    data_nascimento: "1990-01-15",
    hospede_nome: "Maria Silva",
    nacionalidade: "Brasileira",
    telefone: "5567999999999",
    email: "maria@example.com",
    cep: "79002000",
    logradouro: "Rua A",
    numero: "100",
    bairro: "Centro",
    cidade: "Campo Grande",
    uf: "MS",
    pais: "Brasil",
    procedencia: "Campo Grande",
    destino: "Corumbá",
    motivo_viagem: "lazer",
    meio_transporte: "carro",
    placa_veiculo: "ABC1D23",
    data_confirmed: true,
    privacy_accepted: true,
    terms_version: FNRH_TERMS_VERSION,
    privacy_notice_version: FNRH_PRIVACY_NOTICE_VERSION,
    is_minor: false,
    ...partial,
  };
}

async function main() {
  console.log("\n=== FNRH check-in digital v2 (A–L) ===\n");

  // A — adulto: documento obrigatório (upload); tipo/número/nascimento na etapa Confira dados
  {
    const missing = validateDocumentoStep(adultDraft({ has_document_upload: false }));
    assert.equal(missing.ok, false);
    assert.ok(missing.missing.includes("document_upload"));
    assert.equal(validateDocumentoStep(adultDraft()).ok, true);
    assert.equal(
      validateDocumentoStep(
        adultDraft({ documento_tipo: "", documento_numero: "", data_nascimento: "" }),
      ).ok,
      true,
    );
    ok("A adulto exige upload de documento (sem tipo/número/nascimento na etapa 1)");
  }

  // B — adulto: dados pessoais + contato
  {
    const bad = validateConfiraDadosStep(adultDraft({ email: "", telefone: "" }));
    assert.equal(bad.ok, false);
    assert.ok(bad.missing.includes("email"));
    assert.ok(bad.missing.includes("telefone"));
    const badDoc = validateConfiraDadosStep(
      adultDraft({ documento_tipo: "", documento_numero: "", documento: "" }),
    );
    assert.equal(badDoc.ok, false);
    ok("B adulto exige telefone, e-mail e documento na etapa Confira dados");
  }

  // C — endereço CEP-first BR
  {
    const badCep = validateEnderecoStep(adultDraft({ cep: "123" }));
    assert.equal(badCep.ok, false);
    assert.ok(badCep.missing.includes("cep"));
    const foreign = validateEnderecoStep(
      adultDraft({
        pais: "Argentina",
        nacionalidade: "Argentina",
        cep: "",
        logradouro: "",
        endereco_estrangeiro: "Buenos Aires, Av. 9 de Julio 100",
      }),
    );
    assert.equal(foreign.ok, true);
    ok("C CEP BR 8 dígitos; estrangeiro sem CEP");
  }

  // D — viagem + placa só se carro
  {
    const noPlaca = validateViagemStep(adultDraft({ placa_veiculo: "" }));
    assert.equal(noPlaca.ok, false);
    const bus = validateViagemStep(adultDraft({ meio_transporte: "onibus", placa_veiculo: "" }));
    assert.equal(bus.ok, true);
    ok("D placa obrigatória só para carro");
  }

  // E — aceite nunca implícito + versões
  {
    const unchecked = validateAceiteStep(adultDraft({ data_confirmed: false, privacy_accepted: false }));
    assert.equal(unchecked.ok, false);
    const wrongVer = validateAceiteStep(adultDraft({ terms_version: "old" }));
    assert.equal(wrongVer.ok, false);
    assert.ok(wrongVer.errors.includes("terms_version_mismatch"));
    ok("E aceite exige 2 checkboxes + versões canônicas");
  }

  // F — confirm v2 completo vs incompleto
  {
    assert.equal(validateFnrhCheckinV2Confirm(adultDraft()).ok, true);
    assert.equal(validateFnrhCheckinV2Confirm(adultDraft({ has_document_upload: false })).ok, false);
    ok("F validateFnrhCheckinV2Confirm agrega etapas");
  }

  // G — menor: relação + responsável; sem contato próprio
  {
    const minor = adultDraft({
      is_minor: true,
      has_document_upload: true,
      telefone: "",
      email: "",
      responsible_guest_id: G_RESP,
      minor_relation: "pai",
      minor_accompaniment: "acompanhado_por_pai_mae",
    });
    assert.equal(validateConfiraDadosStep(minor).ok, true);
    assert.equal(validateMenorStep(minor).ok, true);
    assert.equal(validateMenorStep({ ...minor, responsible_guest_id: null }).ok, false);
    const policy = evaluateFnrhCompletion({
      guest_id: G_MINOR,
      guest_role: "minor",
      fnrh_required: true,
      fnrh_status: "awaiting_responsible_confirmation",
      responsible_guest_id: G_RESP,
      has_required_core_fields: false,
      has_required_documents: false,
      has_contact_channel: false,
    });
    assert.equal(policy.is_required, true);
    assert.ok(!policy.pending_reasons.includes("missing_contact"));
    ok("G menor exige responsável; contato próprio não bloqueia");
  }

  // H — snapshot SHA-256 determinístico
  {
    const base = {
      fnrh_id: FNRH_ID,
      reservation_id: RES_ID,
      guest_id: G_ADULT,
      flow_version: "v2" as const,
      terms_version: FNRH_TERMS_VERSION,
      privacy_notice_version: FNRH_PRIVACY_NOTICE_VERSION,
      data_confirmed: true as const,
      privacy_accepted: true as const,
      confirmation_source: "guest" as const,
      completed_by_guest_id: G_ADULT,
      confirmed_at: "2026-08-12T12:00:00.000Z",
      fields: { hospede_nome: "Maria", b: 1, a: 2 },
      documents: [{ document_type: "rg", document_subject: "guest", storage_ref: "r/g/x.jpg" }],
    };
    const s1 = serializeConfirmationSnapshot(base);
    const s2 = serializeConfirmationSnapshot({
      ...base,
      fields: { a: 2, b: 1, hospede_nome: "Maria" },
    });
    assert.equal(s1, s2);
    const p1 = await buildConfirmationProof(base);
    const p2 = await buildConfirmationProof(base);
    assert.equal(p1.snapshot_hash, p2.snapshot_hash);
    assert.equal(p1.hash_algorithm, "SHA-256");
    assert.match(p1.snapshot_hash, /^[a-f0-9]{64}$/);
    const canon = canonicalizeJson({ z: 1, a: { c: 2, b: 3 } }) as Record<string, unknown>;
    assert.deepEqual(Object.keys(canon), ["a", "z"]);
    ok("H snapshot canônico + SHA-256 estável");
  }

  // I — provenance manual > ocr > hits > legacy
  {
    assert.equal(preferFieldOrigin("hits", "manual"), "manual");
    assert.equal(preferFieldOrigin("manual", "ocr"), "manual");
    assert.equal(preferFieldOrigin("legacy", "hits"), "hits");
    const merged = mergeFieldProvenance({ nome: "hits" }, { nome: "ocr", cep: "manual" });
    assert.equal(merged.nome, "ocr");
    assert.equal(merged.cep, "manual");
    assert.equal(
      shouldApplySuggestedValue({
        currentValue: "Maria",
        currentOrigin: "manual",
        suggestedOrigin: "ocr",
      }),
      false,
    );
    assert.equal(
      shouldApplySuggestedValue({ currentValue: "", suggestedOrigin: "ocr" }),
      true,
    );
    ok("I provenance prioridade e merge");
  }

  // J — OCR port no-op + flags fail-closed
  {
    assert.equal(isFnrhOcrEnabled(undefined), false);
    assert.equal(isFnrhOcrEnabled("false"), false);
    assert.equal(isFnrhOcrEnabled("true"), true);
    assert.equal(isFnrhFaceVerificationEnabled("TRUE"), false);
    assert.equal(isFnrhFaceVerificationEnabled("true"), true);
    const ocr = createFnrhOcrProvider(true);
    assert.ok(ocr instanceof NoopFnrhOcrProvider);
    const result = await ocr.extract({ storage_ref: "x", document_type: "rg" });
    assert.equal(result.skipped, true);
    assert.deepEqual(result.suggested_fields, {});
    ok("J flags fail-closed; OCR no-op mesmo se enabled");
  }

  // K — ViaCEP provider (mock fetch) + normalize
  {
    assert.equal(normalizeCepDigits("79.002-000"), "79002000");
    const provider = createViaCepProvider(async () =>
      new Response(
        JSON.stringify({
          cep: "79002-000",
          logradouro: "Rua Teste",
          complemento: "",
          bairro: "Centro",
          localidade: "Campo Grande",
          uf: "MS",
        }),
        { status: 200 },
      ),
    );
    const found = await provider.lookup("79002-000");
    assert.equal(found.ok, true);
    if (found.ok) {
      assert.equal(found.address.cidade, "Campo Grande");
      assert.equal(found.address.uf, "MS");
    }
    const bad = await createViaCepProvider().lookup("12");
    assert.equal(bad.ok, false);
    ok("K ViaCEP mock + CEP inválido");
  }

  // L — agregado reserva + lifecycle prevalece + auditoria safe + legado compose
  {
    const state = evaluateReservationFnrhState([
      {
        guest_id: G_ADULT,
        guest_role: "primary_adult",
        fnrh_required: true,
        fnrh_status: "completed",
        confirmation_source: "guest",
        completed_by_guest_id: G_ADULT,
        has_required_core_fields: true,
        has_required_documents: true,
        has_contact_channel: true,
      },
      {
        guest_id: G_MINOR,
        guest_role: "minor",
        fnrh_required: true,
        fnrh_status: "completed",
        responsible_guest_id: G_ADULT,
        confirmation_source: "responsible",
        completed_by_guest_id: G_ADULT,
        has_required_core_fields: true,
        has_required_documents: true,
        has_contact_channel: false,
      },
    ]);
    assert.equal(state.all_required_complete, true);
    assert.equal(state.pending_fnrhs, 0);

    const resolved = resolveEffectiveFnrhStatusSource({
      fnrh_lifecycle_status: "awaiting_guest_confirmation",
      fnrh_status: "confirmado_hospede",
    });
    assert.equal(resolved.source, "lifecycle");
    assert.equal(resolved.value, "awaiting_guest_confirmation");

    const sanitized = sanitizeFnrhAuditState({
      event: "fnrh_confirmed",
      token: "secret-token-value",
      documento: "12345678900",
      flow_version: "v2",
    });
    assert.equal(sanitized.token, "[redacted]");
    assert.equal(sanitized.documento, "[redacted]");
    assertAuditPayloadSafe(sanitized);

    assert.match(composeEnderecoLegado(adultDraft()), /Rua A/);
    assert.equal(composeDocumentoLegado(adultDraft()), "1234567");
    ok("L agregado + lifecycle prevalece + audit sanitize + compose legado");
  }

  console.log(`\n=== ${passed}/12 cenários A–L OK ===\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
