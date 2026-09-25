/**
 * Testes: materialização do vínculo operacional de uma reserva HITS.
 *
 * A Edge roda em Deno com Supabase; aqui o alvo é o que ela NÃO pode fazer —
 * duplicar registro, sobrescrever ficha, inventar data ou tocar em estado
 * operacional. Verificação estática sobre o código versionado, no mesmo padrão
 * de `test-fnrh-hits-sync-guards`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  calcularPosicoesFaltantes,
  MAX_HOSPEDES_POR_RESERVA,
} from "../src/lib/integrations/hits/hits-ocupacao";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}

const ROOT = resolve(process.cwd());
/** Working tree mistura CRLF e LF; as guardas são sobre o código, não sobre EOL. */
function normalizarQuebras(src: string): string {
  return src.replace(/\r\n/g, "\n");
}
const edge = normalizarQuebras(
  readFileSync(resolve(ROOT, "supabase/functions/hits-reserva-materializar/index.ts"), "utf8"),
);
const mvp = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.js"), "utf8");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
// A escrita vive no helper compartilhado com a materialização automática;
// a Edge só faz gate + GET + normalização + resposta. As guardas valem para
// o conjunto (Edge + helper).
const helper = normalizarQuebras(
  readFileSync(resolve(ROOT, "src/lib/integrations/hits/hits-materializar.ts"), "utf8"),
);
const edgeCode = stripComments(edge) + "\n" + stripComments(helper);

function main() {
  console.log("\n== 1. Cria o mínimo necessário ==");
  {
    assert.match(edgeCode, /\.from\("operacional_reservas"\)\s*\n?\s*\.insert/);
    assert.match(edgeCode, /\.from\("operacional_hospedes"\)\.insert/);
    ok("insere reserva operacional e hóspedes");

    // fnrh_hospedes: nunca escrita (a ficha é do trigger e do fnrh-submit).
    // A única leitura permitida é o status da ficha da posição técnica, para
    // NÃO adotar posição cuja ficha já foi tocada.
    assert.doesNotMatch(
      edgeCode,
      /\.from\("fnrh_hospedes"\)\s*\n?\s*\.(insert|update|upsert|delete)/,
      "a ficha é do trigger, não da Edge",
    );
    const leiturasFicha = [...edgeCode.matchAll(/\.from\("fnrh_hospedes"\)\s*\n?\s*\.select\("([^"]*)"\)/g)].map((m) => m[1]);
    assert.deepEqual(leiturasFicha, ["status, fnrh_lifecycle_status"], "única leitura da ficha: status (guarda da adoção)");
    ok("não cria nem altera fnrh_hospedes — trigger continua responsável; ficha só é lida como guarda");

    const escritas = [
      ...edgeCode.matchAll(/\.from\("([a-z_]+)"\)\s*\n?\s*\.(insert|update|upsert|delete)/g),
    ].map((m) => m[1]);
    assert.deepEqual(
      [...new Set(escritas)].sort(),
      ["operacional_hospedes", "operacional_reservas"],
      "só essas duas tabelas recebem escrita",
    );
    ok("escrita restrita a operacional_reservas e operacional_hospedes");
  }

  console.log("\n== Ocupação declarada pelo HITS (cálculo real) ==");
  {
    // A reserva 100: HITS declara 2 adultos, só 1 PAX tem idEntity.
    assert.equal(calcularPosicoesFaltantes(1, 1), 0, "1 adulto / 1 PAX → nada extra");
    assert.equal(calcularPosicoesFaltantes(2, 1), 1, "2 adultos / 1 PAX → 1 posição");
    assert.equal(calcularPosicoesFaltantes(2, 2), 0, "2 adultos / 2 PAX → nada extra");
    assert.equal(calcularPosicoesFaltantes(3, 1), 2, "3 adultos / 1 PAX → 2 posições");
    ok("1/1→0, 2/1→1, 2/2→0, 3/1→2");

    // Segunda execução: os ativos já cobrem a ocupação.
    assert.equal(calcularPosicoesFaltantes(2, 2), 0, "reexecução não cria nada");
    assert.equal(calcularPosicoesFaltantes(2, 3), 0, "excedente não vira negativo");
    ok("segunda execução é inerte — idempotência no cálculo");

    assert.equal(calcularPosicoesFaltantes(null, 0), 1);
    assert.equal(calcularPosicoesFaltantes("x", 0), 1);
    assert.equal(calcularPosicoesFaltantes(0, 0), 1);
    assert.equal(calcularPosicoesFaltantes(2.7, 0), 2);
    assert.equal(calcularPosicoesFaltantes(999, 0), MAX_HOSPEDES_POR_RESERVA);
    ok("ocupação suja vira 1, fracionária trunca, absurda é cortada pelo teto");
  }

  console.log("\n== Posição sem PAX: mesmo caminho do painel ==");
  {
    // Recorte do passo 4 apenas: daqui até o `return` do resultado. Depois do
    // helper vem a reconciliação de contato, que legitimamente cita
    // pms_external_guest_id (hóspede JÁ vinculado) e não é "posição sem PAX".
    const iniPasso4 = edgeCode.indexOf("const { data: ativos }");
    const bloco = edgeCode.slice(iniPasso4, edgeCode.indexOf("posicoes_criadas: posicoesCriadas", iniPasso4));
    assert.match(bloco, /nome: "Novo hóspede"/);
    assert.match(bloco, /principal: false/);
    assert.match(bloco, /status_operacional: "nao_identificado"/);
    assert.match(bloco, /origem_cadastro: "novo"/);
    assert.match(bloco, /modo_coleta_fnrh: "preenchimento_completo"/);
    assert.match(bloco, /tentativas_envio: 0/);
    // O painel usa as constantes; a Edge, os literais equivalentes.
    const mvpAdd = mvp.slice(mvp.indexOf("async function backendAddHospede"));
    assert.ok(mvpAdd.includes('nome: "Novo hóspede"'));
    assert.ok(mvpAdd.includes("ORIGEM_CADASTRO.NOVO"));
    ok("payload idêntico ao backendAddHospede do painel (mvp:1415)");

    assert.equal(
      /pms_external_guest_id/.test(bloco),
      false,
      "posição sem PAX não recebe idEntity",
    );
    ok("nenhum idEntity inventado para quem o HITS não cadastrou");

    assert.match(bloco, /removed_from_reservation\.is\.null,removed_from_reservation\.eq\.false/);
    ok("hóspede removido da reserva não conta como posição ocupada");

    for (const proibido of ["is_minor", "guest_role", "responsible_guest_id"]) {
      assert.equal(bloco.includes(proibido), false, `${proibido} é da FNRH, não daqui`);
    }
    ok("menor e responsável continuam classificados pela FNRH existente");
  }

  console.log("\n== 2 e 3. Idempotência ==");
  {
    // Reserva: procura antes de inserir, pela chave do índice único.
    assert.match(edgeCode, /eq\("origem_externa", ORIGEM_HITS\)/);
    assert.match(edgeCode, /eq\("external_reservation_id", externalId\)/);
    assert.match(edgeCode, /findReserva\(\)/);
    ok("reserva é procurada por (origem_externa, external_reservation_id) antes de criar");

    // Hóspede: procura por (reserva_id, pms_external_guest_id).
    assert.match(edgeCode, /eq\("reserva_id", reserva\.id\)/);
    assert.match(edgeCode, /eq\("pms_external_guest_id", idEntity\)/);
    assert.match(edgeCode, /if \(existente\) \{[\s\S]*?criado: false[\s\S]*?continue;/);
    ok("hóspede já vinculado é reusado, sem insert");

    // Corrida entre dois cliques: unique violation vira reuso, não erro.
    assert.match(edgeCode, /isUniqueViolation/);
    assert.match(edgeCode, /23505/);
    ok("violação de unicidade (clique duplo simultâneo) reusa em vez de falhar");
  }

  console.log("\n== 4. Não sobrescreve FNRH nem cadastro existente ==");
  {
    // Três updates permitidos, todos guardados: (1) contato de hóspede JÁ
    // vinculado — só email/whatsapp, pelas regras de hits-contato (celular
    // nunca é rebaixado; e-mail só preenche vazio) e só com ficha FNRH intocada;
    // (2) backfill FINANCEIRO de reserva materializada antes desta versão, por
    // reservation_balance_due IS NULL (uma vez só); (3) adoção da posição
    // técnica intocada ("Novo hóspede" sem idEntity) pelo PAX HITS — só
    // identificação, guardada no próprio UPDATE por pms_external_guest_id IS
    // NULL + nome/status técnicos.
    const updates = [...edgeCode.matchAll(/\.update\(([^)]*)\)/g)].map((m) => m[1]!.trim());
    assert.deepEqual(updates, ["contatoHits", "financeiroHits", "identificacaoHits"], "só os três updates guardados");
    const iniContato = edgeCode.indexOf("async function atualizarContatoExistente(");
    const fimContato = edgeCode.indexOf("\n}\n", iniContato);
    const contato = edgeCode.slice(iniContato, fimContato);
    assert.match(contato, /const contatoHits: \{ whatsapp\?: string; email\?: string \} = \{\};/, "patch de contato só com whatsapp/email");
    assert.match(contato, /if \(await fichaFnrhTocada\(admin, row\.id\)\) return false;/, "ficha tocada → não mexe no contato");
    assert.match(contato, /\.update\(contatoHits\)\s*\.eq\("id", row\.id\)\s*\.select\("id"\)/);
    for (const proibido of ["nome", "principal", "status_operacional", "fnrh_lifecycle_status", "link_token", "confirmation_source", "completed_at", "documento", "origem_cadastro"]) {
      assert.equal(new RegExp("\\b" + proibido + "\\s*:").test(contato), false, "contato não toca " + proibido);
    }
    assert.match(edgeCode, /\.update\(financeiroHits\)\s*\.eq\("id", reserva\.id\)\s*\.is\("reservation_balance_due", null\)/);
    assert.match(edgeCode, /if \(!reservaCriada\) \{[\s\S]*?\.update\(financeiroHits\)/, "backfill só para reserva já existente");
    assert.match(
      edgeCode,
      /\.update\(identificacaoHits\)\s*\.eq\("id", posicao\.id\)\s*\.eq\("reserva_id", reserva\.id\)\s*\.is\("pms_external_guest_id", null\)\s*\.eq\("nome", POSICAO_TECNICA\.nome\)\s*\.eq\("status_operacional", POSICAO_TECNICA\.status_operacional\)/,
      "adoção guardada: só linha técnica sem idEntity",
    );
    const iniIdent = edgeCode.indexOf("const identificacaoHits = {");
    const identificacao = edgeCode.slice(iniIdent, edgeCode.indexOf("};", iniIdent));
    for (const proibido of ["fnrh_lifecycle_status", "link_token", "removed_from_reservation", "guest_role", "responsible_guest_id", "fnrh_required", "modo_coleta_fnrh", "tentativas_envio", "ultimo_envio", "created_at", "updated_at"]) {
      assert.equal(identificacao.includes(proibido), false, "adoção não toca " + proibido);
    }
    assert.match(edgeCode, /if \(candidatas\.length !== 1\) \{/, "adota só com EXATAMENTE uma candidata");
    assert.equal(/\.upsert\(/.test(edgeCode), false, "nenhum upsert que sobrescreva");
    assert.equal(/\.delete\(/.test(edgeCode), false, "nenhum delete");
    ok("só insert de registro ausente + 2 updates guardados (backfill financeiro; adoção de posição técnica) — ficha e cadastro intactos");
  }

  console.log("\n== 5. Datas vêm do HITS ==");
  {
    assert.match(edgeCode, /check_in_previsto: checkIn/);
    assert.match(edgeCode, /check_out_previsto: checkOut/);
    assert.match(edgeCode, /ymdOrNull\(synced\.checkIn\)/);
    assert.match(edgeCode, /ymdOrNull\(synced\.checkOut\)/);
    ok("check-in e check-out saem do detalhe normalizado do HITS");

    for (const proibido of ["current_date", "now()", "new Date()", "Date.now"]) {
      assert.equal(
        edgeCode.includes(proibido),
        false,
        `${proibido} não pode virar data de reserva`,
      );
    }
    ok("nenhum relógio local ou current_date entra nas datas");
  }

  console.log("\n== 6. Financeiro do HITS na materialização ==");
  {
    // Regra do domínio (mapPaymentStatusFromBalanceDue): saldo <= 0 → pago;
    // > 0 → pendente; ausente → desconhecido. A materialização persiste o que o
    // normalizador já calculou — antes a coluna nascia com o default 'pendente'.
    assert.match(edgeCode, /pagamento_status: synced\.paymentStatus/);
    assert.match(edgeCode, /reservation_balance_due: synced\.reservationBalanceDue/);
    assert.match(edgeCode, /reservation_total_amount: synced\.reservationTotalAmount/);
    assert.match(edgeCode, /classificacao_comissionamento: synced\.classificacaoComissionamento/);
    assert.match(edgeCode, /classificacao_comissionamento_origem: "hits_campo"/);
    ok("insert grava pagamento_status/saldo/total/classificação do detalhe normalizado");

    assert.match(
      edgeCode,
      /\.from\("operacional_reservas"\)\s*\.insert\(\{[\s\S]{0,400}?\.\.\.financeiroHits,\s*\}\)/,
      "insert usa o mesmo objeto financeiro",
    );
    // Só saldo/total/classificação: nada de cartão, contato ou payload bruto.
    const fin = edgeCode.slice(edgeCode.indexOf("const financeiroHits = {"), edgeCode.indexOf("};", edgeCode.indexOf("const financeiroHits = {")));
    assert.doesNotMatch(fin, /card|cart|contact|contato|email|phone|telefone|raw|payload|credit/i);
    ok("nenhum dado de cartão, contato ou payload bruto no financeiro persistido");

    assert.match(edgeCode, /financeiro: \{ pagamento_status: synced\.paymentStatus, backfilled: financeiroBackfilled \}/);
    assert.doesNotMatch(edgeCode, /reservation_balance_due: synced\.reservationBalanceDue[\s\S]{0,400}return json\(\{\s*ok: true/, "resposta não devolve valores");
    ok("resposta informa só o status derivado e se houve backfill (sem valores)");

    assert.match(edgeCode, /reserva_sem_datas_no_hits/);
    ok("sem datas no HITS a materialização falha, em vez de chutar");
  }

  console.log("\n== 6. idEntity preservado ==");
  {
    assert.match(edgeCode, /for \(const guest of synced\.guests \?\? \[\]\)/);
    assert.match(edgeCode, /String\(guest\.externalGuestId \?\? ""\)\.trim\(\)/);
    assert.match(edgeCode, /if \(!idEntity\) continue;/);
    assert.match(edgeCode, /pms_external_guest_id: idEntity/);
    ok("todos os guests com idEntity viram hóspede; sem idEntity é ignorado");

    assert.match(edgeCode, /principal: guest\.isPrincipal === true/);
    ok("o principal do HITS é preservado como principal no Yes");
  }

  console.log("\n== 7. Nada de operacional é alterado ==");
  {
    // pagamento_status passou a ser gravado a partir do HITS (seção 6) — só
    // via `financeiroHits`; acesso, check-in, senha, TTLock e quarto continuam fora.
    for (const proibido of [
      "acesso_liberado",
      "entrou_no_apto",
      "ttlock",
      "senha",
      "credencial",
      "checkin_realizado",
      "idRoom",
      "rooms",
    ]) {
      assert.equal(
        edgeCode.includes(proibido),
        false,
        `${proibido} não pode aparecer na materialização`,
      );
    }
    // 3 ocorrências: objeto financeiro (escrita), tipo do resultado e resposta.
    assert.equal((edgeCode.match(/pagamento_status/g) || []).length, 3, "pagamento_status só no objeto financeiro, no tipo e na resposta");
    ok("sem acesso, check-in, senha, TTLock ou quarto; pagamento só via financeiro do HITS");

    // Leitura no HITS, escrita só no Yes: existe um único fetch, e ele é GET.
    const fetches = (edgeCode.match(/await fetch\(/g) || []).length;
    assert.equal(fetches, 1, "só uma chamada de rede na Edge");
    assert.match(edgeCode, /\/v1\/reservations\/\$\{encodeURIComponent\(externalId\)\}/);
    const metodosFetch = [...edgeCode.matchAll(/await fetch\([\s\S]{0,300}?method: "(\w+)"/g)]
      .map((m) => m[1]);
    assert.deepEqual(metodosFetch, ["GET"], "o único fetch é GET");
    ok("no HITS só há GET — nenhuma escrita upstream");
  }

  console.log("\n== 8. UI: ação na lista e retorno ao fluxo normal ==");
  {
    // O detalhe não abre para reserva somente leitura: a ação vive na lista.
    // Só-snapshot é estado transitório (materialização automática): sem CTA na
    // linha; o roteador mantém 'preparar_fnrh' → acaoPrepararFnrhHits como
    // contingência interna, ainda tratado antes de openDetail.
    assert.doesNotMatch(mvp, /cta: \{ kind: "preparar_fnrh"/);
    assert.match(mvp, /texto: "Sincronizando com o HITS", destaque: false, cta: null/);
    assert.match(mvp, /if \(kind === "preparar_fnrh"\) \{\s*\n\s*acaoPrepararFnrhHits/);
    ok("linha só-snapshot sem CTA ('Sincronizando com o HITS'); contingência manual roteada antes de openDetail");

    assert.match(mvp, /hits-reserva-materializar/);
    assert.match(mvp, /external_reservation_id: String\(externalReservationId/);
    ok("chama a Edge com o idReservation do HITS");

    assert.match(mvp, /await refreshFromSource\(\);/);
    ok("depois do sucesso recarrega — o dedupe existente faz a troca");

    // openDetail continua fechado para somente leitura: nenhum guard foi furado.
    assert.match(mvp, /if \(isReservaSomenteLeituraHits\(reserva\)\) return;/);
    const usos = (mvp.match(/isReservaSomenteLeituraHits\(/g) || []).length;
    assert.equal(usos, 9, "os 8 pontos de bloqueio + a definição seguem intactos");
    ok("nenhum guard removido; openDetail segue bloqueado para somente leitura");
  }

  console.log(`\nOK test-hits-reserva-materializar (${cases} casos)`);
}

main();
