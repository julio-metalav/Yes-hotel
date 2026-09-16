/**
 * Testes de guarda do sync FNRH → HITS e da ação no painel.
 *
 * Estáticos sobre o código versionado: a Edge roda em Deno com Supabase e o
 * painel é DOM. O que importa aqui é o que NÃO pode existir — escrita fora do
 * cadastro do hóspede, perda da ficha em erro, formulário dentro do MVP.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}

const ROOT = resolve(process.cwd());
const submitSrc = readFileSync(resolve(ROOT, "supabase/functions/fnrh-submit/index.ts"), "utf8");
const mvpSrc = readFileSync(resolve(ROOT, "ui/checkin-operacional-mvp.js"), "utf8");

/** Trecho do sync: as duas funções vivem no fim do arquivo. */
const syncBlock = submitSrc.slice(submitSrc.indexOf("function registrarSyncFnrh"));

/** Comentário citando "pagamento" não é escrita de pagamento — só o código conta. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}
const syncCode = stripComments(syncBlock);

function main() {
  console.log("\n== Destino da sincronização ==");
  {
    assert.equal(
      submitSrc.includes("HITS_FNRH_WEBHOOK_URL"),
      false,
      "webhook genérico não pode continuar no código",
    );
    ok("webhook antigo removido — não sobrou destino morto");

    assert.match(syncBlock, /\$\{gatewayUrl\}\/v1\/guests/);
    assert.match(syncBlock, /method:\s*"PUT"/);
    ok("destino é o PUT /v1/guests do gateway existente");

    assert.match(syncBlock, /HITS_GATEWAY_URL/);
    assert.match(syncBlock, /HITS_GATEWAY_TOKEN/);
    ok("usa as envs do gateway que já existem");

    assert.match(submitSrc, /buildHitsGuestPutFromFnrh/);
    assert.match(submitSrc, /fnrh-to-hits-guest\.ts/);
    ok("o payload vem do mapper puro, não é montado inline");
  }

  console.log("\n== Identificadores do HITS ==");
  {
    assert.match(syncBlock, /pms_external_guest_id/);
    assert.match(syncBlock, /external_reservation_id/);
    ok("idEntity vem de pms_external_guest_id; idReservation, de external_reservation_id");

    assert.match(syncBlock, /toPositiveInt/);
    ok("ambos passam por validação de inteiro positivo antes do envio");

    // Sem os dois ids não é erro: a reserva pode não ter origem HITS.
    assert.match(syncBlock, /syncStatus:\s*"pendente"/);
    ok("reserva sem vínculo HITS fica pendente, não vira erro");
  }

  console.log("\n== A ficha nunca é perdida ==");
  {
    assert.equal(/\.delete\(\)/.test(syncBlock), false, "nada é apagado no sync");
    ok("nenhum delete no caminho de sincronização");

    // No catch: registra erro e mantém tudo.
    const catchBlock = syncBlock.slice(syncBlock.lastIndexOf("} catch"));
    assert.match(catchBlock, /syncStatus:\s*"erro"/);
    assert.match(catchBlock, /fichaStatus:\s*"erro_sincronizacao"/);
    assert.equal(/delete|null,\s*hospede_nome|update\(\{\s*documento/.test(catchBlock), false);
    ok("falha do HITS grava erro_sincronizacao e preserva os dados da ficha");

    for (const campo of ["fnrh_sync_status", "fnrh_sync_erro", "fnrh_sync_enviado_em"]) {
      assert.ok(syncBlock.includes(campo), `${campo} precisa continuar sendo gravado`);
    }
    ok("fnrh_sync_status, fnrh_sync_erro e fnrh_sync_enviado_em preservados");

    assert.match(syncBlock, /operacional_reserva_eventos/);
    assert.match(syncBlock, /fnrh_sync_hits/);
    ok("evento operacional continua registrado, permitindo retry depois");
  }

  console.log("\n== Nada além do cadastro do hóspede ==");
  {
    // O sync só escreve em fnrh_hospedes e no log de eventos.
    const tabelas = [...syncBlock.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]);
    const escritas = [...syncBlock.matchAll(/\.from\("([a-z_]+)"\)\s*\.(update|insert|upsert|delete)/g)]
      .map((m) => m[1]);
    assert.deepEqual(
      [...new Set(escritas)].sort(),
      ["fnrh_hospedes", "operacional_reserva_eventos"],
      "só a ficha e o log de eventos podem receber escrita",
    );
    assert.equal(tabelas.includes("operacional_reservas"), true, "reserva é lida…");
    assert.equal(escritas.includes("operacional_reservas"), false, "…mas nunca escrita");
    ok("operacional_reservas é só leitura; escrita restrita à ficha e ao evento");

    for (const proibido of [
      "entrou_no_apto",
      "acesso_liberado",
      "senha_enviada",
      "ttlock",
      "check_in",
      "checkin_realizado",
      "apartamento",
      "pagamento",
      "cobranca",
    ]) {
      assert.equal(
        syncCode.includes(proibido),
        false,
        `${proibido} não pode aparecer no sync`,
      );
    }
    ok("sem status de reserva, check-in, quarto, pagamento, senha ou TTLock");
  }

  console.log("\n== Ação no painel: só a porta de entrada ==");
  {
    assert.match(mvpSrc, /guest-copiar-fnrh-btn/);
    assert.match(mvpSrc, /h\.fnrhLink\s*\n?\s*\?/);
    ok("botão existe e é condicionado ao fnrhLink já montado");

    assert.match(mvpSrc, /class="secondary-button guest-copiar-fnrh-btn"/);
    ok("usa CSS existente — nenhuma classe nova");

    assert.match(mvpSrc, /querySelectorAll\("\.guest-copiar-fnrh-btn"\)/);
    assert.match(mvpSrc, /clipboard\.writeText/);
    ok("listener copia o link, no mesmo padrão dos outros botões do card");

    // A FNRH continua na página pública: o MVP não ganha formulário nem OCR.
    const trecho = mvpSrc.slice(
      mvpSrc.indexOf("guest-copiar-fnrh-btn"),
      mvpSrc.indexOf("guest-copiar-fnrh-btn") + 2000,
    );
    for (const proibido of ["ocr", "viacep", "<form", "documento_numero", "openModal"]) {
      assert.equal(
        trecho.toLowerCase().includes(proibido.toLowerCase()),
        false,
        `${proibido} não pode entrar no MVP`,
      );
    }
    ok("sem formulário, OCR, CEP ou modal no painel");

    assert.match(mvpSrc, /fnrh-preenchimento\.html\?v=2&guest_id=/);
    ok("o link aponta para a página pública existente");
  }

  console.log("\n== Guard somenteLeituraHits intocado ==");
  {
    const usos = (mvpSrc.match(/isReservaSomenteLeituraHits\(/g) || []).length;
    assert.equal(usos, 9, "8 pontos de bloqueio + a definição, como antes");
    ok("guard de reserva somente leitura permanece com todos os pontos");
  }

  console.log(`\nOK test-fnrh-hits-sync-guards (${cases} casos)`);
}

main();
