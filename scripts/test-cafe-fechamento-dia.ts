/**
 * Fechamento operacional do café por DATA.
 *
 * O ponto que estes testes protegem: conclusão é FATO REGISTRADO, nunca
 * inferência. Nenhuma asserção aqui aceita "atendidos = previstos" como
 * conclusão, e nenhuma aceita ausência de registro como dia fechado.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join } from "node:path";

import {
  buildOpenCafeDay,
  canCloseCafeDay,
  canReopenCafeDay,
  cafeClosureSummaryLine,
  cafeDayStatusLabel,
  formatCafeClosureTime,
  isCafeDayClosed,
  parseCafeDayClosure,
  type CafeDayClosure,
} from "../src/lib/domain/yes-hotel/cafe-day-closure.ts";
import { assertCanWriteCafeAttendance } from "../src/lib/domain/yes-hotel/cafe-attendance-policy.ts";
import { applyCafeAttendanceWrite } from "../src/lib/domain/yes-hotel/cafe-attendance-write.ts";
import { buildCafeBreakfastEntitlement } from "../src/lib/domain/yes-hotel/cafe-breakfast-entitlement.ts";

function ok(label: string) {
  console.log(`  OK  ${label}`);
}

const DATA = "2026-08-08";
const AGORA = new Date("2026-08-08T13:32:00Z"); // 09:32 em America/Campo_Grande
const RESERVA = {
  statusReserva: "ativa",
  totalHospedesHits: 2,
  mealPlanDesc: "Café da Manhã",
  cafeAvulsoPagoQtd: 0,
};

const ABERTO = buildOpenCafeDay(DATA);
const CONCLUIDO: CafeDayClosure = {
  dateYmd: DATA,
  status: "concluido",
  closedAt: "2026-08-08T14:32:00Z", // 10:32 local
  closedByName: "Julio Cesar Oliveira",
  reopenedAt: null,
};

function escrever(acao: "increment" | "decrement" | "marcar_todos", closure: CafeDayClosure, previousQty = 1) {
  return applyCafeAttendanceWrite({
    role: "cafe",
    reservation: RESERVA,
    previousQty,
    now: AGORA,
    dayStatus: closure.status,
    request: { cafeDateYmd: DATA, operacionalReservaId: "res-1", acao },
  });
}

console.log("\n== 1. Dia aberto permite + / − ==");
{
  const mais = escrever("increment", ABERTO, 1);
  assert.equal(mais.ok, true);
  if (mais.ok) assert.equal(mais.nextQty, 2);

  const menos = escrever("decrement", ABERTO, 1);
  assert.equal(menos.ok, true);
  if (menos.ok) assert.equal(menos.nextQty, 0);

  const todos = escrever("marcar_todos", ABERTO, 0);
  assert.equal(todos.ok, true);
  if (todos.ok) assert.equal(todos.nextQty, 2);

  const gate = assertCanWriteCafeAttendance({
    role: "cafe",
    cafeDateYmd: DATA,
    entitlement: buildCafeBreakfastEntitlement({ kind: "incluido", guestCount: 2 }),
    now: AGORA,
    dayStatus: "aberto",
  });
  assert.equal(gate.ok, true);
  ok("+ / − / marcar todos funcionam com o dia aberto");

  // Dia sem registro nenhum é aberto. Ausência não fecha nada.
  assert.equal(isCafeDayClosed(parseCafeDayClosure(DATA, null)), false);
  assert.equal(isCafeDayClosed(parseCafeDayClosure(DATA, undefined)), false);
  assert.equal(isCafeDayClosed(parseCafeDayClosure(DATA, { status: null })), false);
  assert.equal(isCafeDayClosed(parseCafeDayClosure(DATA, { status: "lixo" })), false);
  ok("ausência de registro, status nulo ou desconhecido = dia aberto");
}

console.log("\n== 2. Concluir o dia é explícito e permitido a quem opera ==");
{
  for (const role of ["cafe", "recepcao", "admin"]) {
    assert.equal(
      canCloseCafeDay({ role, cafeDateYmd: DATA, closure: ABERTO, now: AGORA }),
      true,
      `${role} deve poder concluir`,
    );
  }
  for (const role of ["financeiro", "governanca", "", null, undefined]) {
    assert.equal(
      canCloseCafeDay({ role, cafeDateYmd: DATA, closure: ABERTO, now: AGORA }),
      false,
      `${String(role)} não deve poder concluir`,
    );
  }
  // Data futura não fecha: mesmo critério que já bloqueia o lançamento.
  assert.equal(
    canCloseCafeDay({ role: "cafe", cafeDateYmd: "2026-08-09", closure: ABERTO, now: AGORA }),
    false,
    "dia futuro não pode ser concluído",
  );
  // Já concluído não oferece o botão de novo.
  assert.equal(
    canCloseCafeDay({ role: "cafe", cafeDateYmd: DATA, closure: CONCLUIDO, now: AGORA }),
    false,
  );
  ok("cafe/recepcao/admin concluem; outros perfis, data futura e dia já fechado, não");
}

console.log("\n== 3. Reload mantém o dia concluído ==");
{
  // Exatamente a linha que operacional_cafe_status_dia devolve.
  const doBanco = parseCafeDayClosure(DATA, {
    status: "concluido",
    concluido_em: "2026-08-08T14:32:00Z",
    concluido_por_nome: "Julio Cesar Oliveira",
    reaberto_em: null,
  });
  assert.equal(doBanco.status, "concluido");
  assert.equal(isCafeDayClosed(doBanco), true);
  assert.equal(cafeDayStatusLabel(doBanco), "Concluído");
  assert.equal(formatCafeClosureTime(doBanco.closedAt), "10:32");
  assert.equal(
    cafeClosureSummaryLine(doBanco),
    "Concluído às 10:32 por Julio Cesar Oliveira",
  );
  assert.equal(cafeDayStatusLabel(ABERTO), "Em andamento");
  assert.equal(cafeClosureSummaryLine(ABERTO), "", "dia aberto não exibe assinatura");
  // Sem nome ou sem hora ainda informa a conclusão, sem inventar dado.
  assert.equal(
    cafeClosureSummaryLine({ ...CONCLUIDO, closedByName: null }),
    "Concluído às 10:32",
  );
  assert.equal(
    cafeClosureSummaryLine({ ...CONCLUIDO, closedAt: null }),
    "Concluído por Julio Cesar Oliveira",
  );
  assert.equal(
    cafeClosureSummaryLine({ ...CONCLUIDO, closedAt: null, closedByName: null }),
    "Serviço concluído",
  );
  assert.equal(formatCafeClosureTime("nao-e-data"), "");
  ok("estado e assinatura sobrevivem ao reload; campos ausentes não viram invenção");
}

console.log("\n== 4. Concluído bloqueia + / − e marcar todos ==");
{
  for (const acao of ["increment", "decrement", "marcar_todos"] as const) {
    const r = escrever(acao, CONCLUIDO, 1);
    assert.equal(r.ok, false, `${acao} deve ser recusado`);
    if (!r.ok) assert.equal(r.error, "cafe_write_forbidden_dia_concluido");
  }
  const gate = assertCanWriteCafeAttendance({
    role: "cafe",
    cafeDateYmd: DATA,
    entitlement: buildCafeBreakfastEntitlement({ kind: "incluido", guestCount: 2 }),
    now: AGORA,
    dayStatus: "concluido",
  });
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.equal(gate.error, "cafe_write_forbidden_dia_concluido");
  // Nem admin escapa: reabrir é uma RPC própria, não efeito de gravar.
  const comoAdmin = applyCafeAttendanceWrite({
    role: "admin",
    reservation: RESERVA,
    previousQty: 1,
    now: AGORA,
    dayStatus: "concluido",
    request: { cafeDateYmd: DATA, operacionalReservaId: "res-1", acao: "increment" },
  });
  assert.equal(comoAdmin.ok, false);
  ok("dia concluído recusa toda gravação, inclusive de admin");
}

console.log("\n== 5. Fechamento NÃO depende de 100% atendidos ==");
{
  // 18 previstos, 3 atendidos: o botão continua disponível.
  assert.equal(
    canCloseCafeDay({ role: "cafe", cafeDateYmd: DATA, closure: ABERTO, now: AGORA }),
    true,
  );
  // E nada no domínio do fechamento olha para quantidade.
  const fonte = readFileSync(
    join(process.cwd(), "src/lib/domain/yes-hotel/cafe-day-closure.ts"),
    "utf8",
  );
  for (const proibido of ["attendedQty", "entitledQty", "summarizeCafeKpis", "cafeMissingQty"]) {
    assert.doesNotMatch(
      fonte,
      new RegExp(proibido),
      `o fechamento não pode depender de ${proibido}`,
    );
  }
  ok("conclusão não exige meta atingida; o domínio sequer enxerga os contadores");
}

console.log("\n== 6 e 7. Reabertura é de admin e devolve a escrita ==");
{
  assert.equal(canReopenCafeDay({ role: "admin", closure: CONCLUIDO }), true);
  for (const role of ["cafe", "recepcao", "financeiro", "", null, undefined]) {
    assert.equal(
      canReopenCafeDay({ role, closure: CONCLUIDO }),
      false,
      `${String(role)} não reabre`,
    );
  }
  // Dia aberto não oferece reabertura a ninguém.
  assert.equal(canReopenCafeDay({ role: "admin", closure: ABERTO }), false);

  // Depois de reaberto, o + volta a valer.
  const reaberto = parseCafeDayClosure(DATA, {
    status: "aberto",
    concluido_em: "2026-08-08T14:32:00Z",
    concluido_por_nome: "Julio Cesar Oliveira",
    reaberto_em: "2026-08-08T15:00:00Z",
  });
  assert.equal(isCafeDayClosed(reaberto), false);
  const r = escrever("increment", reaberto, 1);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.nextQty, 2);
  ok("só admin reabre; reabertura devolve + / − e marcar todos");
}

console.log("\n== 8. Cada data é independente ==");
{
  const ontem = parseCafeDayClosure("2026-08-07", {
    status: "concluido",
    concluido_em: "2026-08-07T14:00:00Z",
    concluido_por_nome: "Outra Pessoa",
    reaberto_em: null,
  });
  const hoje = parseCafeDayClosure(DATA, null);
  assert.equal(ontem.dateYmd, "2026-08-07");
  assert.equal(isCafeDayClosed(ontem), true);
  assert.equal(hoje.dateYmd, DATA);
  assert.equal(isCafeDayClosed(hoje), false, "fechar ontem não fecha hoje");
  const r = escrever("increment", hoje, 0);
  assert.equal(r.ok, true);
  ok("fechamento de uma data não contamina a outra");

  // E a chave do banco é por data, garantindo uma linha por dia.
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/20261001090000_cafe_fechamento_dia.sql"),
    "utf8",
  );
  assert.match(
    sql,
    /constraint operacional_cafe_fechamentos_unique_data unique \(data_cafe\)/,
    "chave única por data_cafe",
  );
}

console.log("\n== Migration: guardas, auditoria e RLS ==");
{
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/20261001090000_cafe_fechamento_dia.sql"),
    "utf8",
  );
  const semComentarios = sql
    .split("\n")
    .filter((linha) => !linha.trimStart().startsWith("--"))
    .join("\n");

  // Estado + auditoria de quem/quando.
  assert.match(semComentarios, /create table if not exists public\.operacional_cafe_fechamentos/);
  assert.match(semComentarios, /status text not null default 'aberto'/);
  assert.match(semComentarios, /check \(status in \('aberto', 'concluido'\)\)/);
  for (const coluna of [
    "concluido_em timestamptz",
    "concluido_por_usuario_interno_id uuid",
    "concluido_por_auth_user_id uuid",
    "concluido_por_nome text",
    "reaberto_em timestamptz",
  ]) {
    assert.ok(semComentarios.includes(coluna), `falta a coluna ${coluna}`);
  }
  // Concluído sem carimbo seria fechamento sem prova.
  assert.match(
    semComentarios,
    /check \(status <> 'concluido' or concluido_em is not null\)/,
  );
  assert.match(
    semComentarios,
    /create table if not exists public\.operacional_cafe_fechamento_auditoria/,
  );
  assert.match(semComentarios, /acao text not null check \(acao in \('concluir', 'reabrir'\)\)/);

  // RLS no mesmo padrão das tabelas de atendimento: lê quem pode, ninguém escreve direto.
  for (const tabela of [
    "operacional_cafe_fechamentos",
    "operacional_cafe_fechamento_auditoria",
  ]) {
    assert.match(
      semComentarios,
      new RegExp(`alter table public\\.${tabela} enable row level security`),
    );
    assert.match(
      semComentarios,
      new RegExp(`revoke insert, update, delete on public\\.${tabela} from authenticated, anon`),
    );
    assert.match(
      semComentarios,
      new RegExp(`grant select on public\\.${tabela} to authenticated`),
    );
  }
  assert.match(semComentarios, /using \(public\.is_yes_hotel_cafe_reader\(\)\)/);
  assert.match(semComentarios, /using \(false\)\s*\n\s*with check \(false\)/);

  // Autenticação, perfil e data em TODAS as RPCs de escrita.
  for (const fn of ["operacional_cafe_fechar_dia", "operacional_cafe_reabrir_dia"]) {
    const corpo = semComentarios.slice(
      semComentarios.indexOf(`create or replace function public.${fn}`),
    );
    assert.match(corpo.slice(0, 3000), /security definer/, `${fn} security definer`);
    assert.match(corpo.slice(0, 3000), /set search_path = public/, `${fn} search_path fixo`);
    assert.match(corpo.slice(0, 3000), /cafe_unauthenticated/, `${fn} exige autenticação`);
    assert.match(corpo.slice(0, 3000), /for update/, `${fn} trava a linha`);
    assert.match(
      semComentarios,
      new RegExp(`revoke all on function public\\.${fn}\\(date\\) from public, anon`),
    );
    assert.match(
      semComentarios,
      new RegExp(`grant execute on function public\\.${fn}\\(date\\) to authenticated`),
    );
  }

  // Fechar: perfis do café, sem data futura.
  const fechar = semComentarios.slice(
    semComentarios.indexOf("create or replace function public.operacional_cafe_fechar_dia"),
    semComentarios.indexOf("create or replace function public.operacional_cafe_reabrir_dia"),
  );
  assert.match(fechar, /not in \('cafe', 'recepcao', 'admin'\)/);
  assert.match(fechar, /cafe_write_forbidden_future_date/);
  assert.match(fechar, /acao, usuario_interno_id, auth_user_id, usuario_nome/);
  // Nada de exigir meta atingida para fechar.
  assert.doesNotMatch(fechar, /quantidade_atendida/);
  assert.doesNotMatch(fechar, /quantidade_direito/);

  // Reabrir: exclusivo de admin.
  const reabrir = semComentarios.slice(
    semComentarios.indexOf("create or replace function public.operacional_cafe_reabrir_dia"),
    semComentarios.indexOf("create or replace function public.operacional_cafe_set_atendimento"),
  );
  assert.match(reabrir, /lower\(v_user\.perfil_usuario\) <> 'admin'/);
  assert.match(reabrir, /cafe_reopen_forbidden_role/);
  assert.doesNotMatch(reabrir, /'recepcao'/, "recepção não reabre");

  // A guarda que dá efeito ao fechamento, dentro da RPC de atendimento.
  const set = semComentarios.slice(
    semComentarios.indexOf("create or replace function public.operacional_cafe_set_atendimento"),
  );
  assert.match(
    set,
    /select f\.status into v_dia_status[\s\S]{0,200}cafe_write_forbidden_dia_concluido/,
  );
  // E tudo o que já protegia continua de pé.
  for (const guarda of [
    "cafe_unauthenticated",
    "not in ('cafe', 'recepcao', 'admin')",
    "cafe_write_forbidden_future_date",
    "cafe_reservation_cancelled",
    "for update",
    "on conflict (operacional_reserva_id, data_cafe)",
    "operacional_cafe_atendimento_auditoria",
    "cafe_write_forbidden_no_entitlement",
  ]) {
    assert.ok(set.includes(guarda), `a RPC de atendimento perdeu: ${guarda}`);
  }
  // O teto pelo direito não pode voltar, nunca.
  assert.doesNotMatch(set, /quantidade_atendida <= quantidade_direito/);
  assert.doesNotMatch(set, /least\(v_prev \+ 1, v_entitled\)/);
  assert.match(set, /v_next := v_prev \+ 1;/, "+ segue livre do direito");
  ok("migration: chave por data, auditoria, RLS, perfis, guarda de escrita e piso 0 preservado");
}

console.log("\n== 9. Escopo: nada de HITS/FNRH/financeiro/senha/TAG ==");
{
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/20261001090000_cafe_fechamento_dia.sql"),
    "utf8",
  );
  const dominio = readFileSync(
    join(process.cwd(), "src/lib/domain/yes-hotel/cafe-day-closure.ts"),
    "utf8",
  );
  // Comentários citam esses domínios justamente para declarar que NÃO são
  // tocados. A prova tem que olhar o código, não a prosa.
  const semComentariosSql = sql
    .split("\n")
    .filter((linha) => !linha.trimStart().startsWith("--"))
    .join("\n");
  const semComentariosTs = dominio
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((linha) => !linha.trimStart().startsWith("//"))
    .join("\n");
  const proibidos = [
    /hits_reservas_snapshot/i,
    /hits_snapshot_sync/i,
    /\bfnrh\b/i,
    /acessos_senhas/i,
    /senha_operacional/i,
    /\bttlock\b/i,
    /pagarme/i,
    /financeiro/i,
    /cron\.schedule/i,
  ];
  for (const padrao of proibidos) {
    assert.doesNotMatch(semComentariosSql, padrao, `migration toca ${padrao}`);
    assert.doesNotMatch(semComentariosTs, padrao, `domínio toca ${padrao}`);
  }
  // meal_plan_desc continua só sendo lido pelo entitlement, não reescrito aqui.
  assert.doesNotMatch(semComentariosSql, /update public\.operacional_reservas/);
  assert.doesNotMatch(semComentariosSql, /alter table public\.operacional_reservas/);
  ok("fechamento não encosta em HITS, FNRH, financeiro, senha, TAG nem scheduler");
}

console.log("\n== UI: card global no lugar do botão por apartamento ==");
{
  const html = readFileSync(join(process.cwd(), "ui/cafe-da-manha-mvp.html"), "utf8");
  const js = readFileSync(join(process.cwd(), "ui/cafe-da-manha-mvp.js"), "utf8");
  const css = readFileSync(join(process.cwd(), "ui/cafe-da-manha-mvp.css"), "utf8");
  const policySrc = readFileSync(join(process.cwd(), "ui/yes-cafe-policy.js"), "utf8");

  // O botão por apartamento saiu de vez.
  for (const fonte of [js, css]) {
    assert.doesNotMatch(fonte, /cafe-concluir/, "resquício do botão individual");
  }
  assert.doesNotMatch(js, /action === "concluir"/);
  assert.doesNotMatch(js, /podeConcluir/);

  // O card global existe e fica logo depois dos KPIs.
  assert.ok(
    html.indexOf('id="cafe-day-closure"') > html.indexOf('id="kpi-apartments-total"'),
    "card do dia vem depois dos KPIs",
  );
  assert.ok(
    html.indexOf('id="cafe-day-closure"') < html.indexOf('id="breakfast-toolbar"'),
    "card do dia vem antes da lista",
  );
  assert.match(html, /Concluir café da manhã do dia/);
  assert.match(html, /id="cafe-day-reopen-button"/);
  assert.match(html, /Reabrir atendimento/);
  assert.match(css, /\.cafe-view \.cafe-day-closure \{/);

  // O card mostra situação + os três números, e a assinatura de quem concluiu.
  assert.match(
    js,
    /\$\{kpis\.expectedGuests\} cafés previstos · \$\{kpis\.attendedGuests\} atendidos · \$\{kpis\.missingGuests\} faltantes/,
    "o card do dia mostra previstos, atendidos e faltantes",
  );
  assert.match(js, /policy\.cafeDayStatusLabel\(dayClosure\)/);
  assert.match(js, /policy\.cafeClosureSummaryLine\(dayClosure\)/);

  // Estado vem da RPC, nunca dos contadores.
  assert.match(js, /supabase\.rpc\("operacional_cafe_status_dia"/);
  assert.match(js, /policy\.parseCafeDayClosure\(selectedYmd, row\)/);
  assert.match(js, /"operacional_cafe_reabrir_dia"\s*:\s*"operacional_cafe_fechar_dia"/);
  assert.doesNotMatch(
    js,
    /dayClosure\s*=\s*\{[^}]*status:\s*"concluido"/,
    "a tela não decide sozinha que o dia fechou",
  );

  // Dia concluído derruba a escrita na própria tela.
  assert.match(js, /if \(policy\.isCafeDayClosed\(dayClosure\)\) return false;/);
  assert.match(js, /dayStatus: dayClosure\?\.status/);

  // + / −, marcar todos e filtros seguem intactos.
  assert.match(js, /increase\.disabled = !writable;/);
  assert.match(js, /decrease\.disabled = !writable \|\| card\.attendedQty <= 0;/);
  assert.match(js, /const plans = policy\.planMarkAllCafeAttended\(cafeCards\);/);
  for (const filtro of ["pending", "complete", "paid", "no_breakfast", "unknown"]) {
    assert.ok(html.includes(`data-filter="${filtro}"`), `filtro ${filtro} sumiu`);
  }

  // Cache-bust: sem isso o navegador serve a tela antiga.
  assert.match(html, /cafe-da-manha-mvp\.js\?v=15/);
  assert.match(html, /cafe-da-manha-mvp\.css\?v=12/);
  assert.match(html, /yes-cafe-policy\.js\?v=8/);
  ok("card global presente, botão individual removido, contadores e filtros preservados");

  // Espelho do navegador alinhado com o domínio TS.
  const ctx = createContext({ globalThis: {} as never });
  (ctx as never as { globalThis: unknown }).globalThis = ctx;
  runInContext(policySrc, ctx);
  const p = (ctx as never as { YesHotelCafePolicy: Record<string, Function> })
    .YesHotelCafePolicy;

  const linha = {
    status: "concluido",
    concluido_em: "2026-08-08T14:32:00Z",
    concluido_por_nome: "Julio Cesar Oliveira",
    reaberto_em: null,
  };
  // Objetos vindos do contexto VM têm outro prototype: compara-se o conteúdo.
  const mesmoConteudo = (a: unknown, b: unknown, rotulo: string) =>
    assert.equal(JSON.stringify(a), JSON.stringify(b), rotulo);
  mesmoConteudo(
    p.parseCafeDayClosure(DATA, linha),
    parseCafeDayClosure(DATA, linha),
    "parseCafeDayClosure divergiu",
  );
  mesmoConteudo(p.buildOpenCafeDay(DATA), buildOpenCafeDay(DATA), "buildOpenCafeDay divergiu");
  assert.equal(p.isCafeDayClosed(CONCLUIDO), isCafeDayClosed(CONCLUIDO));
  assert.equal(p.cafeDayStatusLabel(CONCLUIDO), cafeDayStatusLabel(CONCLUIDO));
  assert.equal(p.cafeDayStatusLabel(ABERTO), cafeDayStatusLabel(ABERTO));
  assert.equal(p.cafeClosureSummaryLine(CONCLUIDO), cafeClosureSummaryLine(CONCLUIDO));
  assert.equal(p.formatCafeClosureTime(CONCLUIDO.closedAt), "10:32");
  for (const role of ["cafe", "recepcao", "admin", "financeiro", ""]) {
    assert.equal(
      p.canCloseCafeDay({ role, cafeDateYmd: DATA, closure: ABERTO, now: AGORA }),
      canCloseCafeDay({ role, cafeDateYmd: DATA, closure: ABERTO, now: AGORA }),
      `canCloseCafeDay divergiu para ${role}`,
    );
    assert.equal(
      p.canReopenCafeDay({ role, closure: CONCLUIDO }),
      canReopenCafeDay({ role, closure: CONCLUIDO }),
      `canReopenCafeDay divergiu para ${role}`,
    );
  }
  assert.equal(
    p.assertCanWriteCafeAttendance({
      role: "cafe",
      cafeDateYmd: DATA,
      entitlement: buildCafeBreakfastEntitlement({ kind: "incluido", guestCount: 2 }),
      now: AGORA,
      dayStatus: "concluido",
    }).error,
    "cafe_write_forbidden_dia_concluido",
  );
  ok("yes-cafe-policy.js espelha cafe-day-closure.ts sem divergência");
}

console.log("\nFechamento diário do café: todos os testes passaram.\n");
