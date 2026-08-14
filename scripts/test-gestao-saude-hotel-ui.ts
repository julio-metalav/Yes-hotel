/**
 * UI Saúde do Hotel — existência, guardas, banner demo e taxonomia de canal.
 * Sem I/O de rede. Sem aplicar migration.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { channelGroup } from "../src/lib/management/channel.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  OK ", name);
}

function read(rel: string) {
  return readFileSync(join(root, rel), "utf8");
}

const files = [
  "ui/gestao-saude-hotel.html",
  "ui/gestao-saude-hotel.js",
  "ui/gestao-saude-hotel.css",
  "ui/data/management-historical-2026.json",
  "ui/data/management-historical-2026.js",
];

for (const rel of files) {
  assert.equal(existsSync(join(root, rel)), true, `falta ${rel}`);
}
ok("arquivos da tela Gestão existem");

const html = read("ui/gestao-saude-hotel.html");
const pageSrc = read("ui/gestao-saude-hotel.js");
const authSrc = read("ui/yes-supabase-auth.js");
const checkinHtml = read("ui/checkin-operacional-mvp.html");
const recepcaoHtml = read("ui/recepcao-mvp.html");
const cafeHtml = read("ui/cafe-da-manha-mvp.html");
const wifiHtml = read("ui/apartamentos-wifi-mvp.html");

assert.match(html, /DADOS HISTÓRICOS REAIS — HITS \+ Omnibees — Jan a Jul\/2026/);
assert.match(html, /Atualização manual por relatórios · integração automática HITS pendente/);
assert.match(html, /aguardando integração online HITS/);
assert.match(html, />Estadias</);
assert.equal(existsSync(join(root, "ui/gestao-saude-hotel-demo.js")), false);
assert.equal(html.includes("gestao-saude-hotel-demo.js"), false);
ok("banner histórico, estadias e fixture demo removido");

assert.match(checkinHtml, /gestao-saude-hotel\.html/);
assert.match(recepcaoHtml, /gestao-saude-hotel\.html/);
assert.match(wifiHtml, /gestao-saude-hotel\.html/);
assert.match(checkinHtml, />\s*Gestão\s*</);
assert.match(recepcaoHtml, />\s*Gestão\s*</);
ok("menu Gestão aparece em Operação, Recepção e Wi-Fi");

assert.equal(cafeHtml.includes("gestao-saude-hotel.html"), false);
ok("sidebar do Café não inclui Gestão");

assert.match(authSrc, /function canAccessManagement/);
assert.match(authSrc, /user\?\.role === "admin" \|\| user\?\.role === "recepcao"/);
assert.match(pageSrc, /currentUser\.role === "cafe"/);
assert.match(pageSrc, /cafe-da-manha-mvp\.html/);
ok("guard: admin/recepção acessam; café é redirecionado");

const historicoSrc = read("ui/data/management-historical-2026.js");
const sandbox: { window: Record<string, unknown>; globalThis: unknown } = {
  window: {},
  globalThis: undefined,
};
sandbox.globalThis = sandbox;
runInContext(historicoSrc, createContext(sandbox));
const historico = (sandbox.window as {
  YesHotelGestaoHistorico: {
    banner: string;
    periods: Record<
      string,
      {
        channels: Array<{ code: string; kind: string; group: string }>;
        alerts: unknown[];
        roomNights: number;
      }
    >;
  };
}).YesHotelGestaoHistorico;

assert.match(historico.banner, /DADOS HISTÓRICOS REAIS/);
assert.equal(channelGroup("booking_engine"), "direct");
const ytd = historico.periods["2026-ytd"];
assert.equal(ytd.channels.some((c) => c.kind === "booking_engine" && c.group === "ota"), false);
assert.ok(ytd.channels.some((c) => c.kind === "booking_engine" && c.group === "direct"));
assert.ok(ytd.channels.some((c) => c.code === "booking" && c.kind === "ota"));
assert.ok(ytd.channels.some((c) => c.kind === "b2b" && c.group === "b2b"));
assert.ok((ytd.alerts || []).length <= 5);
ok("dataset histórico: engine ≠ OTA; B2B separado");

assert.match(html, /id="gestao-period"/);
assert.equal(html.includes("Contas a receber"), false);
assert.match(pageSrc, /Receita de hospedagem/);
assert.match(pageSrc, /Cobertura de identificação de canal/);
assert.match(pageSrc, /Não identificado/);
ok("cobertura de canal explícita na UI");

assert.match(html, /CRM de Hóspedes — em breve/);
assert.equal(html.includes('href="./crm'), false);
ok("CRM futuro sem rota morta");

const wifiJs = read("ui/apartamentos-wifi-mvp.js");
assert.match(wifiHtml, /data-nav="gestao"/);
assert.match(wifiJs, /canAccessManagement/);
assert.match(wifiJs, /data-nav="gestao"/);
ok("Wi-Fi esconde Gestão via canAccessManagement");

console.log(`\n=== ${cases} checks Gestão Saúde do Hotel UI OK ===`);
