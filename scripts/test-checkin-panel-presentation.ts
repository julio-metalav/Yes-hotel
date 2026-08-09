/**
 * Testes das funções puras de apresentação do Check-in Operacional (acabamento).
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

function isoCG(y: number, m: number, d: number, hh: number, mm: number) {
  return new Date(Date.UTC(y, m - 1, d, hh + 4, mm, 0)).toISOString();
}

let passed = 0;
function ok(label: string) {
  passed += 1;
  console.log("  ok", label);
}

// 1 recentes primeiro
{
  const events = [
    { tipo: "acesso_liberado", titulo: "A", criadoEmIso: isoCG(2026, 4, 6, 10, 0) },
    { tipo: "acesso_liberado", titulo: "B", criadoEmIso: isoCG(2026, 4, 6, 18, 0) },
    { tipo: "acesso_liberado", titulo: "C", criadoEmIso: isoCG(2026, 4, 6, 12, 0) },
  ];
  const g = P.groupHistoricoEvents(events);
  assert.ok(g[0].whenLabel.includes("18:00"));
  ok("1 eventos mais recentes primeiro");
}

// 2 entrada fora de ordem
{
  const events = [
    {
      tipo: "envio_auto_fnrh",
      titulo: "Envio",
      detalhe: JSON.stringify({ enviados: 0, erros: 1, erro: "timeout" }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 32),
    },
    {
      tipo: "envio_auto_fnrh",
      titulo: "Envio",
      detalhe: JSON.stringify({ enviados: 0, erros: 1, erro: "timeout" }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 28),
    },
  ];
  const g = P.groupHistoricoEvents(events);
  assert.equal(g.length, 1);
  assert.match(g[0].description, /Entre 06\/04 18:28 e 06\/04 18:32/);
  ok("2 entrada fora de ordem + intervalo crescente");
}

// 3 intervalo sempre crescente (já coberto) + 4 evento único
{
  const one = P.groupHistoricoEvents([
    {
      tipo: "envio_auto_fnrh",
      titulo: "Envio",
      detalhe: JSON.stringify({ enviados: 0, erros: 1 }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 30),
    },
  ]);
  assert.equal(one.length, 1);
  assert.ok(!/Entre /.test(one[0].description || ""));
  ok("4 evento único sem intervalo artificial");
}

// 5 erro técnico FNRH oculto
{
  const p = P.presentHistoricoEvent({
    tipo: "fnrh_sync_hits",
    titulo: "Sync",
    detalhe: JSON.stringify({
      status: "pendente",
      erro: "HITS_FNRH_WEBHOOK_URL não configurado.",
    }),
    criadoEmIso: isoCG(2026, 4, 6, 12, 0),
  });
  assert.ok(!/HITS_FNRH_WEBHOOK_URL/.test(p.description || ""));
  assert.ok(!/HITS_FNRH_WEBHOOK_URL/.test(p.title || ""));
  assert.match(p.technical.detalhe || "", /HITS_FNRH_WEBHOOK_URL/);
  ok("5 erro técnico FNRH oculto no resumo e preservado nos detalhes");
}

// 6 TTLock inglês oculto
{
  const p = P.presentHistoricoEvent({
    tipo: "ttlock_provision_falhou",
    titulo: "TTLock fail",
    detalhe: JSON.stringify({
      status_final: "falhou",
      erro_resumido: "Failed to add keyboard password: invalid lock",
    }),
    criadoEmIso: isoCG(2026, 4, 6, 12, 0),
  });
  assert.equal(p.title, "Falha ao criar a senha");
  assert.ok(!/Failed to add/i.test(p.description || ""));
  assert.match(p.technical.detalhe || "", /Failed to add/);
  ok("6 erro TTLock em inglês oculto no resumo");
}

// 7 falha + sucesso
{
  const events = [
    {
      tipo: "ttlock_provision_sucesso",
      titulo: "ok",
      detalhe: JSON.stringify({ status_final: "provisionada" }),
      criadoEmIso: isoCG(2026, 4, 6, 19, 0),
    },
    {
      tipo: "ttlock_provision_falhou",
      titulo: "fail",
      detalhe: JSON.stringify({ status_final: "falhou", erro_resumido: "GAT" }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 50),
    },
  ];
  const g = P.groupHistoricoEvents(events);
  assert.equal(g[0].status, "success");
  assert.match(g[0].description || "", /Concluído após/);
  assert.ok(g.some((x: any) => x.superseded || x.tone === "muted"));
  ok("7 falha seguida de sucesso com sucesso predominante");
}

// 8 falha sem sucesso permanece ativa
{
  const g = P.groupHistoricoEvents([
    {
      tipo: "ttlock_provision_falhou",
      titulo: "fail",
      detalhe: JSON.stringify({ status_final: "falhou" }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 0),
    },
  ]);
  assert.equal(g[0].status, "fail");
  assert.notEqual(g[0].tone, "muted");
  assert.ok(!g[0].superseded);
  ok("8 falha sem sucesso posterior continua ativa");
}

// 9 sucessos idempotentes
{
  const events = [
    {
      tipo: "ttlock_provision_ja_concluido",
      titulo: "ok",
      detalhe: "{}",
      criadoEmIso: isoCG(2026, 4, 6, 18, 2),
    },
    {
      tipo: "ttlock_provision_ja_concluido",
      titulo: "ok",
      detalhe: "{}",
      criadoEmIso: isoCG(2026, 4, 6, 18, 1),
    },
    {
      tipo: "ttlock_provision_ja_concluido",
      titulo: "ok",
      detalhe: "{}",
      criadoEmIso: isoCG(2026, 4, 6, 18, 0),
    },
  ];
  const g = P.groupHistoricoEvents(events);
  assert.equal(g.length, 1);
  assert.match(g[0].title, /3 confirmações|3/);
  ok("9 sucessos idempotentes agrupados");
}

// 10 fechaduras diferentes não agrupam
{
  const events = [
    {
      tipo: "ttlock_provision_falhou",
      titulo: "f",
      detalhe: JSON.stringify({ codigo_logico_destino: "APT-12", status_final: "falhou" }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 1),
    },
    {
      tipo: "ttlock_provision_falhou",
      titulo: "f",
      detalhe: JSON.stringify({ codigo_logico_destino: "PORTAO-EXT", status_final: "falhou" }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 0),
    },
  ];
  const g = P.groupHistoricoEvents(events);
  assert.equal(g.length, 2);
  ok("10 fechaduras diferentes não agrupam");
}

// 11 / 12 gestão de hóspedes
{
  const one = P.presentGuestManagementEntry(1);
  assert.equal(one.label, "Adicionar acompanhante");
  assert.equal(one.showHeaderAdd, true);
  assert.equal(one.showPerGuestManage, false);
  const many = P.presentGuestManagementEntry(3);
  assert.match(many.label, /Gerenciar hóspedes \(3\)/);
  assert.equal(many.showHeaderAdd, false);
  assert.equal(many.showPerGuestManage, true);
  ok("11-12 Adicionar acompanhante / Gerenciar hóspedes (N)");
}

// 13 aguardar chegada
{
  const a = P.presentPrimaryNextAction({
    pagamentoOk: true,
    fnrhCompleta: true,
    acessoLiberado: true,
    senhaRegistrada: true,
    entrouNoApto: false,
    falhaSenhaAtiva: false,
  });
  assert.equal(a.listaLabel, "Aguardar chegada");
  assert.equal(a.cta, null);
  ok("13 reserva regular mostra Aguardar chegada");
}

// 14 falha / contato / senha pendente
{
  const fail = P.presentPrimaryNextAction({
    pagamentoOk: true,
    fnrhCompleta: true,
    acessoLiberado: true,
    senhaRegistrada: false,
    entrouNoApto: false,
    falhaSenhaAtiva: true,
  });
  assert.equal(fail.ctaKind, "ir_ttlock");
  const contato = P.presentPrimaryNextAction({
    pagamentoOk: true,
    fnrhCompleta: false,
    acessoLiberado: false,
    senhaRegistrada: false,
    entrouNoApto: false,
    faltamContato: true,
  });
  assert.equal(contato.listaLabel, "Corrigir contatos");
  const pend = P.presentPrimaryNextAction({
    pagamentoOk: true,
    fnrhCompleta: true,
    acessoLiberado: true,
    senhaRegistrada: false,
    entrouNoApto: false,
    credencialNaoEnviada: true,
  });
  assert.equal(pend.ctaKind, "gerar_senha");
  ok("14 falha / contato / senha pendente com ação corretiva");
}

// 15 HTML seguro
{
  const html = P.renderHistoricoGroupsHtml(
    P.groupHistoricoEvents([
      {
        tipo: "x_desconhecido",
        titulo: "<img onerror=alert(1)>",
        detalhe: '{"x":"<script>alert(1)</script>"}',
        criadoEmIso: isoCG(2026, 4, 6, 12, 0),
      },
    ]),
  );
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;") || html.includes("&#"));
  ok("15 sem HTML não confiável renderizado");
}

// 16 contagens
{
  const reservas = [
    { acessoLiberado: true },
    { acessoLiberado: true, ttlockPrincipalTodosProvisionados: true },
    { acessoLiberado: false },
    { ttlockPrincipalTodosProvisionados: true },
    { acessoLiberado: true },
  ];
  const total = P.countAcessosLiberados(reservas);
  assert.equal(total, 4);
  const operacional = P.countAcessosLiberados(reservas, {
    scope: "lista_operacional",
    isVisibleInListaOperacional: (r: any, idx?: number) => r.acessoLiberado !== false || !!r.ttlockPrincipalTodosProvisionados,
  });
  // filter keeps 4 with access flags — use visibility that hides one
  const op2 = P.countAcessosLiberados(reservas, {
    scope: "lista_operacional",
    isVisibleInListaOperacional: (r: any) => !!r.acessoLiberado,
  });
  assert.equal(op2, 3);
  ok("16 contagens com semântica lista vs total");
}

// 17 TTLock Senha pronta
{
  const t = P.presentTtlockPasswordStatus({
    status: "provisionada",
    syncStatus: null,
    resumo: "provisionada | 3 provisionado(s)",
  });
  assert.equal(t.statusLabel, "Senha pronta");
  assert.equal(t.resumoText, "");
  ok("17 regressão TTLock Senha pronta");
}

// 18 FNRH confirmada sem ainda não enviado
{
  const g = P.presentGuestCardState({
    statusOperacional: "confirmado",
    nome: "Ana",
    email: "a@x.com",
    whatsapp: "67984020002",
  });
  assert.equal(g.cadastroOkLabel, "Cadastro do hóspede: OK");
  assert.equal(g.showSendNoise, false);
  const resumo = P.formatResumoComunicacaoApresentacao(
    { porWhatsapp: 0, porEmail: 0, porAmbos: 0, naoEnviado: 1 },
    { allFnrhConfirmed: true },
  );
  assert.equal(resumo, "");
  ok("18 FNRH confirmada não mostra ainda não enviado");
}

// sanitize env
{
  const s = P.sanitizeOperationalText("HITS_FNRH_WEBHOOK_URL não configurado.");
  assert.ok(!/HITS_FNRH_WEBHOOK_URL/.test(s));
  assert.ok(s.length > 0);
  ok("sanitize remove variável de ambiente");
}

console.log("\nPASS test-checkin-panel-presentation (" + passed + " casos)");
