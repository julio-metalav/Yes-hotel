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

/** Campo Grande (UTC-4): hora local → ISO UTC. */
function isoCG(y: number, m: number, d: number, hh: number, mm: number, ss = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh + 4, mm, ss)).toISOString();
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

// 2 entrada fora de ordem + intervalo entre minutos diferentes
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
  ok("2 entrada fora de ordem + intervalo crescente entre minutos");
}

// 3 timestamps brutos iguais → horário único
{
  const iso = isoCG(2026, 4, 6, 23, 22, 0);
  const g = P.groupHistoricoEvents([
    {
      tipo: "envio_auto_fnrh",
      titulo: "Envio",
      detalhe: JSON.stringify({ enviados: 0, erros: 1 }),
      criadoEmIso: iso,
    },
    {
      tipo: "envio_auto_fnrh",
      titulo: "Envio",
      detalhe: JSON.stringify({ enviados: 0, erros: 1 }),
      criadoEmIso: iso,
    },
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].count, 2);
  assert.ok(!/Entre /.test(g[0].description || ""));
  assert.match(g[0].whenLabel || "", /06\/04 23:22/);
  ok("3 timestamps brutos iguais sem Entre");
}

// 4 timestamps diferentes por segundos, mesmo minuto exibido
{
  const g = P.groupHistoricoEvents([
    {
      tipo: "envio_auto_fnrh",
      titulo: "Envio",
      detalhe: JSON.stringify({ enviados: 0, erros: 1 }),
      criadoEmIso: isoCG(2026, 4, 6, 23, 22, 45),
    },
    {
      tipo: "envio_auto_fnrh",
      titulo: "Envio",
      detalhe: JSON.stringify({ enviados: 0, erros: 1 }),
      criadoEmIso: isoCG(2026, 4, 6, 23, 22, 3),
    },
  ]);
  assert.equal(g.length, 1);
  assert.match(g[0].title, /2 tentativas/);
  assert.ok(!/Entre /.test(g[0].description || ""));
  // horário único fica no whenLabel; descrição não repete "Entre X e X"
  assert.ok(!/^06\/04 23:22$/.test((g[0].description || "").trim()));
  assert.match(g[0].whenLabel || "", /06\/04 23:22/);
  ok("4 mesmo minuto exibido → horário único (sem Entre redundante)");
}

// 5 evento único sem intervalo artificial
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
  ok("5 evento único sem intervalo artificial");
}

// 6 erro técnico FNRH oculto
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
  ok("6 erro técnico FNRH oculto no resumo e preservado nos detalhes");
}

// 7 TTLock inglês oculto
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
  ok("7 erro TTLock em inglês oculto no resumo");
}

// 8 falha + sucesso (regressão; envio mais novo não impede desfecho)
{
  const events = [
    {
      tipo: "envio_manual_senha",
      titulo: "envio",
      detalhe: JSON.stringify({ canais: { email: true, whatsapp: true }, ok: true }),
      criadoEmIso: isoCG(2026, 4, 6, 19, 5),
    },
    {
      tipo: "ttlock_provision_sucesso",
      titulo: "ok",
      detalhe: JSON.stringify({
        status_final: "provisionada",
        credencial_id: "cred-same",
      }),
      criadoEmIso: isoCG(2026, 4, 6, 19, 0),
    },
    {
      tipo: "ttlock_provision_ja_concluido",
      titulo: "ok",
      detalhe: JSON.stringify({
        status_final: "provisionada",
        credencial_id: "cred-same",
      }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 58),
    },
    {
      tipo: "ttlock_provision_falhou",
      titulo: "fail",
      detalhe: JSON.stringify({
        status_final: "falhou",
        erro_resumido: "GAT",
        credencial_id: "cred-same",
      }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 50),
    },
  ];
  const g = P.groupHistoricoEvents(events);
  const success = g.find((x: any) => x.status === "success" && x.category === "ttlock_senha");
  assert.ok(success);
  assert.equal(success.count, 2);
  assert.match(success.description || "", /Concluído após/);
  assert.ok(g.some((x: any) => x.superseded || x.tone === "muted"));
  const fail = g.find((x: any) => x.status === "fail" && x.category === "ttlock_senha");
  assert.ok(fail);
  assert.equal(fail.technicalItems.length, 1);
  ok("8 falha seguida de sucesso mantém desfecho e agrupa confirmações");
}

// 9 falha sem sucesso permanece ativa
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
  ok("9 falha sem sucesso posterior continua ativa");
}

// 10 sucessos equivalentes de criação agrupados (intercalados com envio)
{
  const cred = "64705bcb-6736-4329-96ae-f9413f3bb5d8";
  const events = [
    {
      tipo: "envio_manual_senha",
      titulo: "Envio",
      detalhe: JSON.stringify({
        canais: { email: true, whatsapp: true },
        canal_operacional_whatsapp: "digisac",
        ok: true,
      }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 13, 12),
    },
    {
      tipo: "ttlock_provision_ja_concluido",
      titulo: "ok",
      detalhe: JSON.stringify({
        action: "lifecycle_provision",
        credencial_id: cred,
        status_final: "provisionada",
        erro_resumido: null,
      }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 13, 7),
    },
    {
      tipo: "ttlock_provision_sucesso",
      titulo: "ok",
      detalhe: JSON.stringify({
        action: "lifecycle_provision_concluido",
        credencial_id: cred,
        status_final: "provisionada",
        erro_resumido: null,
      }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 13, 0),
    },
  ];
  const g = P.groupHistoricoEvents(events);
  const cria = g.filter((x: any) => x.category === "ttlock_senha");
  const envia = g.filter((x: any) => x.category === "ttlock_senha_envio");
  assert.equal(cria.length, 1);
  assert.equal(cria[0].count, 2);
  assert.match(cria[0].title, /2 confirmações/);
  assert.equal(envia.length, 1);
  assert.equal(cria[0].technicalItems.length, 2);
  ok("10 sucessos equivalentes de criação agrupados apesar do envio intercalado");
}

// 11 envios equivalentes agrupados
{
  const events = [
    {
      tipo: "envio_manual_senha",
      titulo: "Envio",
      detalhe: JSON.stringify({
        canais: { email: false, whatsapp: true },
        canal_operacional_whatsapp: "digisac",
        ok: true,
      }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 10, 30),
    },
    {
      tipo: "ttlock_provision_ja_concluido",
      titulo: "ok",
      detalhe: JSON.stringify({
        credencial_id: "c1",
        status_final: "provisionada",
      }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 10, 20),
    },
    {
      tipo: "envio_manual_senha",
      titulo: "Envio",
      detalhe: JSON.stringify({
        canais: { email: false, whatsapp: true },
        canal_operacional_whatsapp: "digisac",
        ok: true,
      }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 5, 0),
    },
  ];
  const g = P.groupHistoricoEvents(events);
  const envia = g.filter((x: any) => x.category === "ttlock_senha_envio");
  assert.equal(envia.length, 1);
  assert.equal(envia[0].count, 2);
  assert.match(envia[0].title, /2 envios/);
  assert.equal(envia[0].technicalItems.length, 2);
  ok("11 envios equivalentes agrupados (não contiguidade)");
}

// 12 criação e envio continuam separados
{
  const g = P.groupHistoricoEvents([
    {
      tipo: "envio_manual_senha",
      titulo: "Envio",
      detalhe: JSON.stringify({ canais: { whatsapp: true }, ok: true }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 1),
    },
    {
      tipo: "ttlock_provision_sucesso",
      titulo: "ok",
      detalhe: JSON.stringify({ credencial_id: "c1", status_final: "provisionada" }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 0),
    },
  ]);
  assert.equal(g.length, 2);
  assert.equal(g[0].category, "ttlock_senha_envio");
  assert.equal(g[1].category, "ttlock_senha");
  ok("12 criação e envio permanecem separados");
}

// 13 fechaduras diferentes não agrupam
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
  ok("13 fechaduras diferentes não agrupam");
}

// 14 canais diferentes não agrupam
{
  const g = P.groupHistoricoEvents([
    {
      tipo: "envio_manual_senha",
      titulo: "Envio",
      detalhe: JSON.stringify({ canais: { email: true, whatsapp: false }, ok: true }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 2),
    },
    {
      tipo: "envio_manual_senha",
      titulo: "Envio",
      detalhe: JSON.stringify({ canais: { email: false, whatsapp: true }, ok: true }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 1),
    },
  ]);
  assert.equal(g.length, 2);
  ok("14 canais diferentes não agrupam");
}

// 15 senhas/credenciais diferentes não agrupam
{
  const g = P.groupHistoricoEvents([
    {
      tipo: "ttlock_provision_sucesso",
      titulo: "ok",
      detalhe: JSON.stringify({ credencial_id: "cred-A", status_final: "provisionada" }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 2),
    },
    {
      tipo: "ttlock_provision_sucesso",
      titulo: "ok",
      detalhe: JSON.stringify({ credencial_id: "cred-B", status_final: "provisionada" }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 1),
    },
  ]);
  assert.equal(g.length, 2);
  ok("15 credenciais/senhas diferentes não agrupam");
}

// 16 todas as ocorrências nos detalhes técnicos
{
  const g = P.groupHistoricoEvents([
    {
      tipo: "ttlock_provision_ja_concluido",
      titulo: "ok",
      detalhe: JSON.stringify({ credencial_id: "c1", status_final: "provisionada", n: 1 }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 2),
    },
    {
      tipo: "ttlock_provision_sucesso",
      titulo: "ok",
      detalhe: JSON.stringify({ credencial_id: "c1", status_final: "provisionada", n: 2 }),
      criadoEmIso: isoCG(2026, 4, 6, 18, 0),
    },
  ]);
  assert.equal(g[0].technicalItems.length, 2);
  assert.ok(g[0].technicalItems.every((t: any) => t.criadoEmIso && t.detalhe));
  const html = P.renderHistoricoGroupsHtml(g);
  assert.match(html, /Ver detalhes técnicos/);
  assert.match(html, /#1 de 2/);
  assert.match(html, /#2 de 2/);
  ok("16 ocorrências originais preservadas nos detalhes técnicos");
}

// 17 HTML não confiável não interpretado
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
  ok("17 sem HTML não confiável renderizado");
}

// 18 / 19 gestão de hóspedes
{
  const one = P.presentGuestManagementEntry(1);
  assert.equal(one.label, "Adicionar acompanhante");
  assert.equal(one.showHeaderAdd, true);
  assert.equal(one.showPerGuestManage, false);
  const many = P.presentGuestManagementEntry(3);
  assert.match(many.label, /Gerenciar hóspedes \(3\)/);
  assert.equal(many.showHeaderAdd, false);
  assert.equal(many.showPerGuestManage, true);
  ok("18-19 Adicionar acompanhante / Gerenciar hóspedes (N)");
}

// 20 aguardar chegada
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
  ok("20 reserva regular mostra Aguardar chegada");
}

// 21 falha / contato / senha pendente
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
  ok("21 falha / contato / senha pendente com ação corretiva");
}

// 22 contagens
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
  const op2 = P.countAcessosLiberados(reservas, {
    scope: "lista_operacional",
    isVisibleInListaOperacional: (r: any) => !!r.acessoLiberado,
  });
  assert.equal(op2, 3);
  ok("22 contagens com semântica lista vs total");
}

// 23 regressão TTLock Senha pronta
{
  const t = P.presentTtlockPasswordStatus({
    status: "provisionada",
    syncStatus: null,
    resumo: "provisionada | 3 provisionado(s)",
  });
  assert.equal(t.statusLabel, "Senha pronta");
  assert.equal(t.resumoText, "");
  ok("23 regressão TTLock Senha pronta / provisionada");
}

// 24 FNRH confirmada sem ainda não enviado
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
  ok("24 FNRH confirmada não mostra ainda não enviado");
}

// sanitize env
{
  const s = P.sanitizeOperationalText("HITS_FNRH_WEBHOOK_URL não configurado.");
  assert.ok(!/HITS_FNRH_WEBHOOK_URL/.test(s));
  assert.ok(s.length > 0);
  ok("sanitize remove variável de ambiente");
}

console.log("\nPASS test-checkin-panel-presentation (" + passed + " casos)");
