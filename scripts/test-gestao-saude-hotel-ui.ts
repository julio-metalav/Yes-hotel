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
  "ui/gestao-saude-hotel-demo.js",
];

for (const rel of files) {
  assert.equal(existsSync(join(root, rel)), true, `falta ${rel}`);
}
ok("arquivos da tela Gestão existem");

const html = read("ui/gestao-saude-hotel.html");
const demoSrc = read("ui/gestao-saude-hotel-demo.js");
const pageSrc = read("ui/gestao-saude-hotel.js");
const authSrc = read("ui/yes-supabase-auth.js");
const checkinHtml = read("ui/checkin-operacional-mvp.html");
const recepcaoHtml = read("ui/recepcao-mvp.html");
const cafeHtml = read("ui/cafe-da-manha-mvp.html");
const wifiHtml = read("ui/apartamentos-wifi-mvp.html");

assert.match(html, /DADOS DEMONSTRATIVOS — aguardando integração gerencial/);
ok("banner de dados demonstrativos no HTML");

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

const sandbox: { window: Record<string, unknown>; globalThis: unknown } = {
  window: {},
  globalThis: undefined,
};
sandbox.globalThis = sandbox;
runInContext(demoSrc, createContext(sandbox));
const demo = (sandbox.window as { YesHotelGestaoSaudeDemo: {
  DEMO_BANNER: string;
  channelGroup: (kind: string) => string;
  CHANNEL_ROWS: Array<{ code: string; kind: string; group: string; label: string }>;
  buildDashboard: () => {
    demo: boolean;
    banner: string;
    channels: Array<{ code: string; kind: string; group: string; label: string }>;
    alerts: unknown[];
  };
} }).YesHotelGestaoSaudeDemo;

assert.equal(demo.DEMO_BANNER, "DADOS DEMONSTRATIVOS — aguardando integração gerencial");
assert.equal(demo.channelGroup("booking_engine"), "direct");
assert.equal(demo.channelGroup("booking_engine"), channelGroup("booking_engine"));
assert.equal(demo.channelGroup("ota"), "ota");
assert.equal(demo.channelGroup("b2b"), "b2b");
ok("channelGroup demo = fundação (engine ≠ OTA)");

const engine = demo.CHANNEL_ROWS.find((r) => r.code === "booking_engine");
const bookingOta = demo.CHANNEL_ROWS.find((r) => r.code === "booking");
const b2b = demo.CHANNEL_ROWS.find((r) => r.code === "b2b");
assert.ok(engine);
assert.ok(bookingOta);
assert.ok(b2b);
assert.equal(engine.kind, "booking_engine");
assert.equal(engine.group, "direct");
assert.notEqual(engine.group, "ota");
assert.equal(bookingOta.kind, "ota");
assert.equal(b2b.kind, "b2b");
assert.equal(b2b.group, "b2b");
ok("Booking Engine não agrupado como OTA; B2B separado");

const dash = demo.buildDashboard();
assert.equal(dash.demo, true);
assert.match(dash.banner, /DADOS DEMONSTRATIVOS/);
assert.equal(
  dash.channels.some((c) => c.kind === "booking_engine" && c.group === "ota"),
  false,
);
assert.ok(dash.channels.some((c) => c.kind === "b2b" && c.group === "b2b"));
assert.ok(dash.alerts.length <= 5);
ok("dashboard demo: banner, canais e no máximo 5 alertas");

assert.match(html, /CRM de Hóspedes — em breve/);
assert.equal(html.includes('href="./crm'), false);
ok("CRM futuro sem rota morta");

const wifiJs = read("ui/apartamentos-wifi-mvp.js");
assert.match(wifiHtml, /data-nav="gestao"/);
assert.match(wifiJs, /canAccessManagement/);
assert.match(wifiJs, /data-nav="gestao"/);
ok("Wi-Fi esconde Gestão via canAccessManagement");

console.log(`\n=== ${cases} checks Gestão Saúde do Hotel UI OK ===`);
