/**
 * Testes das funções puras de apresentação do Check-in Operacional.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(
  path.join(__dirname, "../ui/yes-checkin-panel-presentation.js"),
  "utf8",
);
const sandbox: { YesHotelCheckinPanelPresentation?: any; globalThis: any } = {
  globalThis: {},
};
sandbox.globalThis = sandbox;
vm.runInNewContext(src, sandbox);
const P = sandbox.YesHotelCheckinPanelPresentation;
assert.ok(P, "módulo de apresentação não carregou");

function isoCampoGrande(y: number, m: number, d: number, hh: number, mm: number) {
  // Constrói instante cujo relógio em America/Campo_Grande é o pedido (UTC-4 sem DST atual).
  const utc = Date.UTC(y, m - 1, d, hh + 4, mm, 0);
  return new Date(utc).toISOString();
}

let passed = 0;
function ok(label: string) {
  passed += 1;
  console.log("  ok", label);
}

// 1. FNRH confirmada: Cadastro OK; sem “ainda não enviado”
{
  const g = P.presentGuestCardState({
    statusOperacional: "confirmado",
    nome: "Ana",
    email: "a@x.com",
    whatsapp: "67984020002",
    tentativasEnvio: 3,
    ultimoEnvioCanal: null,
  });
  assert.equal(g.cadastroOkLabel, "Cadastro do hóspede: OK");
  assert.equal(g.showSendNoise, false);
  assert.equal(g.preferReadOnly, true);
  assert.equal(g.whatsappDisplay, "(67) 98402-0002");

  const resumo = P.formatResumoComunicacaoApresentacao(
    { porWhatsapp: 0, porEmail: 0, porAmbos: 0, naoEnviado: 1 },
    { allFnrhConfirmed: true },
  );
  assert.equal(resumo, "");
  assert.ok(!String(resumo).includes("ainda não enviado"));
  ok("1 FNRH confirmada → Cadastro OK sem ainda não enviado");
}

// 2. FNRH pendente
{
  const g = P.presentGuestCardState({
    statusOperacional: "enviado",
    nome: "Bia",
    email: "b@x.com",
    whatsapp: "",
  });
  assert.equal(g.mode, "pending");
  assert.ok(g.pendencyText.toLowerCase().includes("aguardando"));
  assert.equal(g.cadastroOkLabel, "");
  ok("2 FNRH pendente mostra pendência");
}

// 3. Nove falhas idênticas → grupo com 9 tentativas
{
  const base = Date.parse("2026-08-08T22:28:00.000Z");
  const events = Array.from({ length: 9 }, (_, i) => ({
    tipo: "envio_auto_fnrh",
    titulo: "Envio de links FNRH",
    detalhe: JSON.stringify({ enviados: 0, erros: 1, enviados_whatsapp: 0, erro: "timeout" }),
    criadoEmIso: new Date(base + i * 20_000).toISOString(),
  })).reverse(); // mais recente primeiro
  const groups = P.groupHistoricoEvents(events);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 9);
  assert.match(groups[0].title, /FNRH não enviada/);
  assert.match(groups[0].title, /9 tentativas/);
  ok("3 nove falhas idênticas agrupadas");
}

// 4. Falhas seguidas de sucesso
{
  const events = [
    {
      tipo: "envio_auto_fnrh",
      titulo: "Envio",
      detalhe: JSON.stringify({ enviados: 1, erros: 0, enviados_whatsapp: 1 }),
      criadoEmIso: "2026-08-08T22:40:00.000Z",
    },
    {
      tipo: "envio_auto_fnrh",
      titulo: "Envio",
      detalhe: JSON.stringify({ enviados: 0, erros: 1, erro: "timeout" }),
      criadoEmIso: "2026-08-08T22:32:00.000Z",
    },
    {
      tipo: "envio_auto_fnrh",
      titulo: "Envio",
      detalhe: JSON.stringify({ enviados: 0, erros: 1, erro: "timeout" }),
      criadoEmIso: "2026-08-08T22:30:00.000Z",
    },
    {
      tipo: "envio_auto_fnrh",
      titulo: "Envio",
      detalhe: JSON.stringify({ enviados: 0, erros: 1, erro: "timeout" }),
      criadoEmIso: "2026-08-08T22:28:00.000Z",
    },
  ];
  const groups = P.groupHistoricoEvents(events);
  assert.ok(groups[0].status === "success");
  assert.match(groups[0].title, /Link da FNRH enviado/);
  assert.ok((groups[0].afterFailures || 0) >= 3 || /após 3/.test(groups[0].description));
  assert.ok(groups.some((g: any) => g.status === "fail"));
  ok("4 falhas + sucesso: sucesso claro e falhas nos detalhes");
}

// 5. Falha e sucesso não agrupados juntos
{
  const events = [
    {
      tipo: "envio_auto_fnrh",
      titulo: "Envio",
      detalhe: JSON.stringify({ enviados: 1, erros: 0 }),
      criadoEmIso: "2026-08-08T22:31:00.000Z",
    },
    {
      tipo: "envio_auto_fnrh",
      titulo: "Envio",
      detalhe: JSON.stringify({ enviados: 0, erros: 1, erro: "x" }),
      criadoEmIso: "2026-08-08T22:30:00.000Z",
    },
  ];
  const groups = P.groupHistoricoEvents(events);
  assert.equal(groups.length, 2);
  assert.notEqual(groups[0].status, groups[1].status);
  ok("5 falha e sucesso não são um único grupo");
}

// 6. Canais diferentes não agrupam
{
  const events = [
    {
      tipo: "envio_manual_senha",
      titulo: "Envio manual",
      detalhe: JSON.stringify({ ok: true, canais: { email: true, whatsapp: false } }),
      criadoEmIso: "2026-08-08T22:31:00.000Z",
    },
    {
      tipo: "envio_manual_senha",
      titulo: "Envio manual",
      detalhe: JSON.stringify({ ok: true, canais: { email: false, whatsapp: true } }),
      criadoEmIso: "2026-08-08T22:30:00.000Z",
    },
  ];
  const groups = P.groupHistoricoEvents(events);
  assert.equal(groups.length, 2);
  ok("6 canais diferentes não agrupam");
}

// 7. Evento desconhecido: fallback + detalhes técnicos
{
  const p = P.presentHistoricoEvent({
    tipo: "evento_xyz_desconhecido",
    titulo: "",
    detalhe: '{"foo":1}',
    criadoEmIso: "2026-08-08T22:00:00.000Z",
  });
  assert.ok(p.title);
  assert.equal(p.status, "info");
  assert.equal(p.technical.tipo, "evento_xyz_desconhecido");
  const html = P.renderHistoricoGroupsHtml(P.groupHistoricoEvents([
    {
      tipo: "evento_xyz_desconhecido",
      titulo: "Algo",
      detalhe: '{"foo":1}',
      criadoEmIso: "2026-08-08T22:00:00.000Z",
    },
  ]));
  assert.match(html, /Ver detalhes técnicos/);
  assert.match(html, /evento_xyz_desconhecido/);
  ok("7 evento desconhecido com fallback e detalhes");
}

// 8. Payload HTML escapado
{
  const html = P.renderHistoricoGroupsHtml(
    P.groupHistoricoEvents([
      {
        tipo: "evento_xyz_desconhecido",
        titulo: "<script>alert(1)</script>",
        detalhe: '{"x":"<img onerror=alert(1)>"}',
        criadoEmIso: "2026-08-08T22:00:00.000Z",
      },
    ]),
  );
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;") || html.includes("&lt;img"));
  ok("8 HTML do payload escapado");
}

// 9. Datas America/Campo_Grande
{
  const iso = isoCampoGrande(2026, 8, 8, 18, 28);
  const label = P.formatDateTimeCampoGrande(iso);
  assert.match(label, /08\/08/);
  assert.match(label, /18:28/);
  ok("9 datas em America/Campo_Grande");
}

// 10. TTLock provisionada → Senha pronta (PR #14)
{
  const t = P.presentTtlockPasswordStatus({
    status: "provisionada",
    syncStatus: null,
    resumo: "provisionada | 3 provisionado(s)",
  });
  assert.equal(t.statusLabel, "Senha pronta");
  assert.equal(t.resumoText, "");
  assert.equal(t.statusClass, "sync-ok");
  ok("10 TTLock provisionada → Senha pronta");
}

console.log("\nPASS test-checkin-panel-presentation (" + passed + " casos)");
