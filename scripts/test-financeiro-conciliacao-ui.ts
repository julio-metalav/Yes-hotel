/**
 * UI Conciliação financeira — existência, guardas, read-only, sem PII.
 * Sem I/O de rede.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  OK ", name);
}
function read(rel: string) {
  return readFileSync(join(root, rel), "utf8");
}

console.log("\n=== UI Conciliação financeira ===\n");

const files = [
  "ui/financeiro-conciliacao.html",
  "ui/financeiro-conciliacao.js",
  "ui/financeiro-conciliacao.css",
];
for (const rel of files) {
  assert.equal(existsSync(join(root, rel)), true, `falta ${rel}`);
}
ok("arquivos da tela Conciliação existem");

const html = read("ui/financeiro-conciliacao.html");
const pageSrc = read("ui/financeiro-conciliacao.js");
const authSrc = read("ui/yes-supabase-auth.js");
const edgeSrc = read("supabase/functions/financial-recon-review/index.ts");
const decideSrc = read("supabase/functions/financial-recon-decide/index.ts");
const cafeHtml = read("ui/cafe-da-manha-mvp.html");
const gestaoHtml = read("ui/gestao-saude-hotel.html");
const checkinHtml = read("ui/checkin-operacional-mvp.html");
const recepcaoHtml = read("ui/recepcao-mvp.html");
const wifiHtml = read("ui/apartamentos-wifi-mvp.html");

assert.match(html, /Financeiro/);
assert.match(html, /Conciliação/);
assert.match(html, /fin-kpis/);
assert.match(html, /Conciliados automaticamente/);
assert.match(html, /Suggested/);
assert.match(html, /Ambiguous/);
assert.match(html, /Não conciliado Omie/);
assert.match(html, /Não conciliado banco/);
assert.match(html, /Transferência interna/);
assert.match(html, /Possíveis agrupamentos/);
assert.match(html, /Conta Sicredi/);
ok("rota, KPIs e filtros presentes");

assert.match(authSrc, /function canAccessFinancialRecon/);
assert.match(authSrc, /user\?\.role === "admin"/);
assert.match(pageSrc, /canAccessFinancialRecon/);
assert.match(pageSrc, /Conciliação financeira é restrita a admin/);
assert.match(pageSrc, /currentUser\.role === "cafe"/);
ok("admin acessa; não-admin e café bloqueados");

assert.match(gestaoHtml, /financeiro-conciliacao\.html/);
assert.match(checkinHtml, /financeiro-conciliacao\.html/);
assert.match(recepcaoHtml, /financeiro-conciliacao\.html/);
assert.match(wifiHtml, /financeiro-conciliacao\.html/);
assert.equal(cafeHtml.includes("financeiro-conciliacao.html"), false);
ok("nav Conciliação nas telas de gestão/operação; ausente no Café");

assert.match(pageSrc, /Confirmar conciliação/);
assert.match(pageSrc, /Rejeitar sugestão/);
assert.match(pageSrc, /financial-recon-decide/);
assert.doesNotMatch(html, /Desfazer/);
assert.doesNotMatch(pageSrc, /\.insert\(/);
assert.doesNotMatch(pageSrc, /\.update\(/);
assert.doesNotMatch(pageSrc, /\.delete\(/);
assert.doesNotMatch(pageSrc, /raw_payload/);
assert.doesNotMatch(pageSrc, /service_role|SERVICE_ROLE/);
assert.doesNotMatch(html, /raw_payload/);
assert.match(pageSrc, /group_detail/);
assert.match(pageSrc, /financial-recon-review/);
assert.match(pageSrc, /data-review/);
ok("UI admin escreve só via edge decide; sem PII/raw payload/service role");

assert.match(pageSrc, /Transferência interna — não é receita nem despesa/);
assert.match(pageSrc, /Não conciliado\. Não é erro nem fraude/);
assert.match(pageSrc, /Diagnóstico — não conciliado/);
assert.match(pageSrc, /Pendências — Suggested/);
assert.match(pageSrc, /possible_aggregations/);
assert.match(pageSrc, /Não foi possível calcular a análise neste momento/);
assert.match(pageSrc, /High recomputado/);
assert.match(pageSrc, /Conciliados automaticamente: 601 high/);
assert.match(html, /601 high/);
assert.match(html, /PENDÊNCIAS DE AUDITORIA/);
ok("internal transfer, unmatched e possible aggregation com etiquetas corretas");

assert.match(edgeSrc, /Acesso restrito a admin/);
assert.match(edgeSrc, /Revisao financeira e somente leitura|somente leitura/);
assert.doesNotMatch(edgeSrc, /raw_payload/);
assert.match(edgeSrc, /ANALYSIS_ENTRY_SELECT/);
assert.match(edgeSrc, /includePossibleAggregations/);
assert.match(edgeSrc, /possible_aggregations/);
assert.match(decideSrc, /Acesso restrito a admin/);
assert.match(decideSrc, /actor_user_id: actor.id/);
assert.doesNotMatch(decideSrc, /raw_payload/);
ok("backend read-only admin-only sem raw_payload");

console.log(`\n${cases} checks OK\n`);
