/**
 * Cron das 13h: contrato da migration que finalmente aciona `senha-auto-envio`.
 *
 * Até esta migration, a Edge existia, funcionava e era testada, mas ninguém a
 * chamava: o agendamento vivia comentado em supabase/pending/, fora de
 * migrations. A regra das 13h nunca rodava sozinha em produção.
 *
 * Sem rede, sem banco: valida o SQL e o contrato da Edge.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const CRON_SQL = "supabase/migrations/20261002090000_senha_auto_envio_13h_cron.sql";
const PENDING = "supabase/pending/senha-auto-envio-cron.sql";
const EDGE = "supabase/functions/senha-auto-envio/index.ts";
const CONFIG = "supabase/config.toml";

const ler = (rel: string) =>
  readFileSync(resolve(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const semComentarios = (sql: string) =>
  sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

function ok(label: string) {
  console.log("  OK  " + label);
}

const sql = ler(CRON_SQL);
const codigo = semComentarios(sql);
const edge = ler(EDGE);

console.log("\n== Horário: 13h em Campo Grande ==");
{
  // America/Campo_Grande = UTC-4 o ano todo. 13:05 local = 17:05 UTC.
  assert.match(codigo, /'yes-hotel-senha-auto-envio-13h',\s*'5 17 \* \* \*'/);
  // A Edge revalida a hora local, então o horário do cron e o dela têm de bater.
  assert.match(edge, /const AUTO_HOUR = 13;/);
  assert.match(edge, /YES_HOTEL_TIMEZONE"\) \?\? "America\/Campo_Grande"/);
  assert.match(edge, /if \(zoned\.hour < AUTO_HOUR\)/, "Edge recusa antes das 13h locais");
  ok("13:05 local (5 17 * * * em UTC-4) e a Edge revalida a hora");
}

console.log("\n== Chama a Edge certa, do jeito que ela autentica ==");
{
  assert.match(codigo, /functions\/v1\/senha-auto-envio/);
  assert.equal(
    (codigo.match(/functions\/v1\/([a-z-]+)/g) || []).every((u) => u.endsWith("senha-auto-envio")),
    true,
    "nenhuma outra Edge é acionada por esta migration",
  );
  assert.match(codigo, /'\{"mode":"13h"\}'::jsonb/);
  assert.match(codigo, /'\{"mode":"retry","limit":20\}'::jsonb/);
  // A Edge aceita service_role no Authorization OU o token dedicado. Usamos o
  // token, que é menos privilegiado, e ele vem do Vault — nunca do Git.
  assert.match(edge, /x-senha-scheduler-token/);
  assert.match(codigo, /'x-senha-scheduler-token'/);
  assert.match(codigo, /from vault\.decrypted_secrets\s*\n\s*where name = 'senha_scheduler_token'/);
  assert.doesNotMatch(codigo, /Bearer [A-Za-z0-9._-]{10,}/, "nenhum token literal no SQL");
  assert.doesNotMatch(codigo, /service_role/i, "não usa service_role no cron");
  ok("aciona senha-auto-envio com token do Vault, sem segredo no Git");
}

console.log("\n== Sem duplicidade e idempotente ==");
{
  // Reaplicar a migration não pode gerar dois jobs: sem o unschedule prévio,
  // o hóspede receberia a senha duas vezes.
  assert.match(codigo, /select jobid from cron\.job/);
  assert.match(codigo, /perform cron\.unschedule\(jid\)/);
  assert.match(codigo, /'yes-hotel-senha-auto-envio-13h',\s*\n\s*'yes-hotel-senha-auto-envio-retry'/);
  // E a própria migration confere o resultado.
  assert.match(codigo, /raise exception 'agendamento duplicado ou ausente/);
  assert.match(codigo, /raise exception 'horario das 13h incorreto/);
  // Extensões declaradas, como nas outras migrations de cron.
  assert.match(codigo, /create extension if not exists pg_net/);
  assert.match(codigo, /create extension if not exists pg_cron/);
  ok("unschedule prévio, dois jobs esperados e autoverificação do horário");
}

console.log("\n== Pré-requisito explícito: sem token, a migration falha ==");
{
  // Agendar um cron que toma 401 todo dia, em silêncio, é pior que não agendar.
  assert.match(codigo, /if not exists \(\s*\n\s*select 1 from vault\.decrypted_secrets where name = 'senha_scheduler_token'/);
  assert.match(codigo, /raise exception using/);
  assert.match(sql, /SENHA_SCHEDULER_TOKEN/);
  ok("falha com instrução clara se a secret do Vault não existir");
}

console.log("\n== Uma fonte de verdade ==");
{
  const pending = ler(PENDING);
  const pendingCodigo = semComentarios(pending);
  // O arquivo pendente não pode mais conter agendamento: duas fontes para o
  // mesmo job foi a causa de a regra nunca ter sido ativada.
  assert.doesNotMatch(pendingCodigo, /cron\.schedule/);
  assert.match(pending, /20261002090000_senha_auto_envio_13h_cron\.sql/);
  ok("supabase/pending deixou de agendar e aponta para a migration");
}

console.log("\n== Regra das 13h preservada: libera sem FNRH e sem pagamento ==");
{
  // O cron só aciona; a decisão é da Edge. Ela não pode ter ganhado gate
  // financeiro nem de ficha nesta mudança.
  const ini = edge.indexOf("async function processOne13h(");
  assert.ok(ini > 0);
  const corpo = edge.slice(ini, edge.indexOf("\n}\n", ini));
  assert.match(corpo, /if \(reserva\.senha_enviada_em\)/);
  assert.match(corpo, /if \(reserva\.entrou_no_apto\)/);
  for (const proibido of ["pagamento_status", "fnrh_status_agregado", "comission", "classificacao"]) {
    assert.equal(
      corpo.includes(proibido),
      false,
      "a rotina das 13h não pode exigir " + proibido,
    );
  }
  ok("13h segue liberando mesmo sem FNRH e sem pagamento");
}

console.log("\n== Escopo: só o agendamento ==");
{
  // O `comment on extension pg_cron` é o inventário de TODOS os jobs do
  // scheduler, então cita nomes de outras rotinas de propósito. O escopo se
  // mede no que a migration executa, não nesse inventário.
  const executavel = codigo.slice(0, codigo.indexOf("comment on extension"));
  for (const padrao of [
    /alter table/i,
    /create table/i,
    /drop table/i,
    /operacional_reservas/,
    /acessos_senhas/,
    /fnrh/i,
    /ttlock/i,
    /toleranc/i,
    /access-tolerance-processor/,
  ]) {
    assert.doesNotMatch(executavel, padrao, "migration saiu do escopo: " + padrao);
  }
  // O job de tolerância não é tocado.
  assert.doesNotMatch(executavel, /yes-hotel-access-tolerance-process/);
  ok("nenhuma tabela, nenhuma outra rotina, nenhum outro job");
}

console.log("\nCron das 13h: todos os testes passaram.\n");
