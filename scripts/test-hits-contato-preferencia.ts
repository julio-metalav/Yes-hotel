/**
 * Testes: contato do hóspede HITS → Yes com preferência por CELULAR.
 * - hits-contato: classificação BR (celular/fixo/desconhecido), escolha entre
 *   candidatos, regras de atualização de hóspede já materializado;
 * - normalizador: guests[].contactPhone com um ou mais números; contact2 da
 *   reserva como candidato do principal só quando é celular;
 * - fixture fictícia com a FORMA do caso real (fixo + celular + e-mail).
 * Sem rede, sem banco.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classificarTelefoneBr,
  decidirEmailExistente,
  decidirWhatsappExistente,
  digitosTelefoneBr,
  escolherTelefonePreferido,
  separarTelefones,
} from "../src/lib/integrations/hits/hits-contato.ts";
import { normalizeHitsDetailToSynced } from "../src/lib/integrations/hits/normalize-hits-detail-to-synced.ts";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}
const ROOT = process.cwd();
const fixture = () =>
  JSON.parse(readFileSync(join(ROOT, "fixtures/hits-contato-fixo-celular-detail.json"), "utf8")) as Record<string, unknown>;
const real = () =>
  JSON.parse(readFileSync(join(ROOT, "fixtures/hits-real-sample-detail.json"), "utf8")) as Record<string, unknown>;

const FIXO = "+55 (67) 3321-4567";
const CEL = "+55 (67) 99123-4567";

console.log("\n== A. Classificação e escolha ==");
{
  assert.equal(digitosTelefoneBr("+55 (67) 99123-4567"), "67991234567");
  assert.equal(digitosTelefoneBr("0 67 3321-4567"), "6733214567");
  assert.equal(digitosTelefoneBr("5567991234567"), "67991234567");
  assert.equal(classificarTelefoneBr(CEL), "celular");
  assert.equal(classificarTelefoneBr("67991234567"), "celular");
  assert.equal(classificarTelefoneBr(FIXO), "fixo");
  assert.equal(classificarTelefoneBr("(11) 2345-6789"), "fixo");
  assert.equal(classificarTelefoneBr("+1 415 555 0100"), "desconhecido", "sem heurística internacional");
  assert.equal(classificarTelefoneBr("0800 123 4567"), "desconhecido");
  assert.equal(classificarTelefoneBr("6791234567"), "desconhecido", "10 dígitos começando por 9 não é fixo nem celular");
  assert.equal(classificarTelefoneBr(""), "desconhecido");
  assert.equal(classificarTelefoneBr(null), "desconhecido");
  ok("classificação BR: celular = DDD+9XXXXXXXX; fixo = DDD+[2-5]XXXXXXX; resto desconhecido");

  assert.deepEqual(separarTelefones("(67) 3321-4567 / 99123-4567"), ["(67) 3321-4567", "99123-4567"]);
  assert.deepEqual(separarTelefones("+55 67 3321-4567; +55 67 99123-4567"), ["+55 67 3321-4567", "+55 67 99123-4567"]);
  assert.deepEqual(separarTelefones("67 3321-4567 ou 67 99123-4567"), ["67 3321-4567", "67 99123-4567"]);
  assert.deepEqual(separarTelefones(CEL), [CEL], "hífen e parênteses não separam");
  ok("separação de múltiplos números num mesmo campo (/ ; | , ou)");

  // 1. somente fixo → fixo; 2. somente celular → celular; 3. fixo + celular → celular; 5. nada → null
  assert.equal(escolherTelefonePreferido([FIXO]), FIXO);
  assert.equal(escolherTelefonePreferido([CEL]), CEL);
  assert.equal(escolherTelefonePreferido([FIXO, CEL]), CEL);
  assert.equal(escolherTelefonePreferido([CEL, FIXO]), CEL);
  assert.equal(escolherTelefonePreferido([FIXO + " / " + CEL]), CEL, "dois números no mesmo campo → celular");
  assert.equal(escolherTelefonePreferido(["(11) 2345-6789", "(11) 3456-7890"]), "(11) 2345-6789", "só fixos → primeiro fixo");
  assert.equal(escolherTelefonePreferido(["+1 415 555 0100"]), "+1 415 555 0100", "desconhecido único → mantido como veio");
  assert.equal(escolherTelefonePreferido(["+1 415 555 0100", FIXO]), FIXO, "fixo BR vence desconhecido");
  assert.equal(escolherTelefonePreferido([null, "", undefined]), null);
  assert.equal(escolherTelefonePreferido([]), null);
  assert.equal(escolherTelefonePreferido([CEL, "67991234567"]), CEL, "mesmo número em formatos diferentes conta uma vez");
  ok("1–3,5: somente fixo → fixo; somente celular → celular; fixo+celular → celular; nada → null");
}

console.log("\n== B. Regras para hóspede já materializado ==");
{
  assert.equal(decidirWhatsappExistente("", CEL), CEL, "local vazio → preenche");
  assert.equal(decidirWhatsappExistente(null, FIXO), FIXO, "local vazio + só fixo → preenche com fixo");
  assert.equal(decidirWhatsappExistente(FIXO, CEL), CEL, "fixo → celular");
  assert.equal(decidirWhatsappExistente(CEL, FIXO), null, "celular nunca rebaixa para fixo");
  assert.equal(decidirWhatsappExistente(CEL, "(67) 98888-0000"), null, "celular local não é trocado por outro celular");
  assert.equal(decidirWhatsappExistente(CEL, "67991234567"), null, "mesmo número → no-op");
  assert.equal(decidirWhatsappExistente(FIXO, "(67) 3322-0000"), null, "fixo → outro fixo: não mexe");
  assert.equal(decidirWhatsappExistente("+1 415 555 0100", CEL), null, "local desconhecido (possível edição manual/estrangeiro) → não mexe");
  assert.equal(decidirWhatsappExistente(FIXO, ""), null, "HITS vazio → nada");
  assert.equal(decidirWhatsappExistente(FIXO, "+1 415 555 0100"), null, "fixo não é trocado por desconhecido");
  ok("whatsapp: vazio→preenche; fixo→celular; celular nunca rebaixa; igual→no-op; desconhecido→conservador");

  assert.equal(decidirEmailExistente("", "camila.exemplo@example.com"), "camila.exemplo@example.com");
  assert.equal(decidirEmailExistente("camila.exemplo@example.com", "camila.exemplo@example.com"), null);
  assert.equal(decidirEmailExistente("outro@example.com", "camila.exemplo@example.com"), null, "e-mail diferente já existente → não troca");
  assert.equal(decidirEmailExistente("", "nao-e-email"), null, "HITS sem e-mail plausível → nada");
  assert.equal(decidirEmailExistente("", ""), null);
  ok("email: vazio→preenche; igual→no-op; diferente→mantém; inválido→ignora");
}

console.log("\n== C. Normalizador (forma do caso real: fixo + celular + e-mail) ==");
{
  // Forma A: fixo em guests[].contactPhone, celular em contact2 da reserva.
  const s = normalizeHitsDetailToSynced(fixture(), "2026-09-25T12:00:00Z");
  assert.equal(s.externalReservationId, "3490");
  assert.equal(s.guests.length, 1);
  const p = s.guests[0]!;
  assert.equal(p.externalGuestId, "4300");
  assert.equal(p.isPrincipal, true);
  assert.equal(p.phone, CEL, "forma A: contactPhone fixo + contact2 celular → celular no PAX principal");
  assert.equal(p.email, "camila.exemplo@example.com");
  assert.equal(s.phone, CEL, "telefone da reserva acompanha o principal");
  assert.equal(s.email, "camila.exemplo@example.com");
  ok("forma A (fixo no hóspede, celular no contato da reserva) → Yes escolhe o celular; e-mail vai para email (caso 4)");

  // Forma B: os dois números no MESMO campo contactPhone.
  const b = fixture();
  (b.guests as Array<Record<string, unknown>>)[0]!.contactPhone = FIXO + " / " + CEL;
  b.contact2 = FIXO;
  const sb = normalizeHitsDetailToSynced(b, null);
  assert.equal(sb.guests[0]!.phone, CEL, "forma B: dois números no contactPhone → celular");
  ok("forma B (fixo e celular no mesmo campo) → celular");

  // Só fixo em tudo → fixo (não inventa celular); contact2 fixo diferente não substitui.
  const c = fixture();
  (c.guests as Array<Record<string, unknown>>)[0]!.contactPhone = FIXO;
  c.contact2 = "(67) 3322-0000";
  const sc = normalizeHitsDetailToSynced(c, null);
  assert.equal(sc.guests[0]!.phone, FIXO, "só fixos → mantém o do hóspede");
  ok("somente fixo → usa fixo (contact2 fixo não substitui o do hóspede)");

  // Hóspede já com celular + contact2 com outro celular → mantém o do hóspede.
  const d = fixture();
  (d.guests as Array<Record<string, unknown>>)[0]!.contactPhone = CEL;
  d.contact2 = "(67) 98888-0000";
  assert.equal(normalizeHitsDetailToSynced(d, null).guests[0]!.phone, CEL);
  ok("hóspede já com celular → contact2 não interfere");

  // Hóspede sem telefone + contact2 fixo → guest.phone continua null (comportamento anterior); reserva usa contact2.
  const e = fixture();
  (e.guests as Array<Record<string, unknown>>)[0]!.contactPhone = null;
  e.contact2 = FIXO;
  const se = normalizeHitsDetailToSynced(e, null);
  assert.equal(se.guests[0]!.phone, null, "contact2 fixo não sobe para o PAX (regra só sobe celular)");
  assert.equal(se.phone, FIXO, "fallback da reserva inalterado");
  ok("sem telefone no PAX + contact2 fixo → PAX sem telefone (como antes); reserva mantém fallback");

  // Acompanhante (não principal) nunca recebe o contact2 da reserva.
  const f = fixture();
  (f.guests as Array<Record<string, unknown>>).push({ idEntity: 4301, name: "Acompanhante Exemplo", contactPhone: FIXO, main: false });
  const sf = normalizeHitsDetailToSynced(f, null);
  assert.equal(sf.guests[1]!.phone, FIXO, "acompanhante mantém o próprio telefone");
  ok("contact2 só entra para o principal");

  // Regressão: fixture real (contactPhone == contact2, celular) inalterada.
  const r = normalizeHitsDetailToSynced(real(), null);
  const realPhone = String((real().guests as Array<Record<string, unknown>>)[0]!.contactPhone ?? "").trim();
  assert.equal(r.guests[0]!.phone, realPhone);
  assert.equal(r.phone, realPhone);
  ok("regressão: fixture real (um único celular) → mesmo telefone de antes");

  // Sem contato nenhum → null (caso 5).
  const g = fixture();
  (g.guests as Array<Record<string, unknown>>)[0]!.contactPhone = null;
  (g.guests as Array<Record<string, unknown>>)[0]!.contactMail = null;
  g.contact1 = null;
  g.contact2 = null;
  const sg = normalizeHitsDetailToSynced(g, null);
  assert.equal(sg.guests[0]!.phone, null);
  assert.equal(sg.guests[0]!.email, null);
  assert.equal(sg.phone, null);
  assert.equal(sg.email, null);
  ok("nenhum contato → null (contrato atual)");
}

console.log("\n== D. Sem rede, sem envio, sem escrita HITS ==");
{
  const src = readFileSync(join(ROOT, "src/lib/integrations/hits/hits-contato.ts"), "utf8");
  for (const proibido of ["fetch(", "supabase", "digisac", "resend", "whatsapp-message", "send-", "method:"]) {
    assert.equal(src.toLowerCase().includes(proibido), false, "hits-contato não pode conter " + proibido);
  }
  const norm = readFileSync(join(ROOT, "src/lib/integrations/hits/normalize-hits-detail-to-synced.ts"), "utf8");
  assert.doesNotMatch(norm, /fetch\(|\/v1\/guests/, "normalizador continua sem rede (nenhum GET extra por hóspede)");
  ok("módulos puros: sem rede, sem envio, sem HITS");
}

console.log(`\nOK test-hits-contato-preferencia (${cases} casos)`);
