/**
 * Regressão do scheduler HITS (5 jobs pg_cron -> GET hits-reservations-preview).
 * Sem rede / sem banco: só lê o SQL da migration e o texto da Edge.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = "supabase/migrations";
const EDGE = "supabase/functions/hits-reservations-preview/index.ts";
const ENDPOINT = "/functions/v1/hits-reservations-preview";

const JOBS: Record<string, string> = {
  "yes-hotel-hits-preview-0700-1950": "*/10 11-23 * * *",
  "yes-hotel-hits-preview-2000-2150": "*/10 0-1 * * *",
  "yes-hotel-hits-preview-2200": "0 2 * * *",
  "yes-hotel-hits-preview-2259": "59 2 * * *",
  "yes-hotel-hits-preview-0100": "0 5 * * *",
};

const EXISTING_JOB_NAMES = [
  "yes-hotel-access-outbox-dispatch",
  "yes-hotel-ttlock-access-poll",
  "yes-hotel-access-tolerance-process",
];

function readRepo(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function ok(label: string) {
  console.log(`  ok ${label}`);
}

function findSchedulerMigration(): string {
  const dir = join(root, MIGRATIONS_DIR);
  const files = readdirSync(dir).filter((f) =>
    f.endsWith("hits_reservations_preview_scheduler_cron.sql")
  );
  assert.equal(files.length, 1, `esperava 1 migration do scheduler HITS, achei ${files.length}`);
  return join(MIGRATIONS_DIR, files[0]);
}

/**
 * Simula cron simples: expande "*\/N range" e "M H * * *" em pares (hora,minuto),
 * suficiente para detectar colisão entre os 5 jobs deste scheduler (não é um
 * parser cron genérico).
 */
function expandSlots(expr: string): Array<[number, number]> {
  const [minutePart, hourPart] = expr.split(" ");
  const hours: number[] = [];
  if (hourPart === "*") {
    for (let h = 0; h < 24; h++) hours.push(h);
  } else if (hourPart.includes("-")) {
    const [a, b] = hourPart.split("-").map(Number);
    for (let h = a; h <= b; h++) hours.push(h);
  } else {
    hours.push(Number(hourPart));
  }

  const minutes: number[] = [];
  if (minutePart === "*") {
    for (let m = 0; m < 60; m++) minutes.push(m);
  } else if (minutePart.startsWith("*/")) {
    const step = Number(minutePart.slice(2));
    for (let m = 0; m < 60; m += step) minutes.push(m);
  } else {
    minutes.push(Number(minutePart));
  }

  const slots: Array<[number, number]> = [];
  for (const h of hours) for (const m of minutes) slots.push([h, m]);
  return slots;
}

async function main() {
  const migrationRel = findSchedulerMigration();
  assert.ok(existsSync(join(root, migrationRel)), "migration do scheduler HITS deve existir");
  const sql = readRepo(migrationRel);
  ok(`migration existe: ${migrationRel}`);

  // 2) exatamente os 5 jobs esperados, nenhum a mais/menos
  const jobNamesInSql = Object.keys(JOBS).filter((name) => sql.includes(`'${name}'`));
  assert.deepEqual(
    new Set(jobNamesInSql),
    new Set(Object.keys(JOBS)),
    "devem existir exatamente os 5 jobs HITS esperados",
  );
  for (const name of Object.keys(JOBS)) {
    const occurrences = sql.split(`'${name}'`).length - 1;
    assert.ok(occurrences >= 2, `job ${name} deve aparecer no unschedule e no schedule`);
  }
  ok("exatamente os 5 jobs HITS esperados, cada um com unschedule + schedule");

  // 3) cron expressions exatas, associadas ao respectivo jobname
  for (const [name, expr] of Object.entries(JOBS)) {
    const scheduleBlock = sql.slice(sql.indexOf(`cron.schedule(\n  '${name}'`));
    assert.ok(
      scheduleBlock.startsWith(`cron.schedule(\n  '${name}',\n  '${expr}'`),
      `job ${name} deve usar exatamente a expressão '${expr}'`,
    );
  }
  ok("cron expressions exatas para os 5 jobs");

  // 4) todos usam net.http_get / 5) nenhum net.http_post para o scheduler HITS
  assert.equal(
    sql.split("net.http_get(").length - 1,
    5,
    "devem existir exatamente 5 chamadas net.http_get (uma por job)",
  );
  assert.ok(
    !sql.includes("net.http_post("),
    "migration do scheduler HITS NÃO pode chamar net.http_post (comentários citando a proibição são permitidos)",
  );
  ok("todos os jobs usam net.http_get; nenhum net.http_post");

  // 6) endpoint exato
  const endpointOccurrences = sql.split(`https://minmmecajnmjqlgacfoz.supabase.co${ENDPOINT}`).length - 1;
  assert.equal(endpointOccurrences, 5, "os 5 jobs devem chamar exatamente o endpoint da preview");
  ok(`endpoint exato: ${ENDPOINT}`);

  // 7) headers vêm do Vault / 8) secret certo, sem valor literal
  assert.ok(sql.includes("vault.decrypted_secrets"), "headers devem vir de vault.decrypted_secrets");
  assert.ok(
    sql.includes("name = 'yes_hotel_edge_anon_key'"),
    "secret usado deve ser yes_hotel_edge_anon_key",
  );
  assert.ok(!/Bearer [A-Za-z0-9_\-.]{10,}/.test(sql), "não pode haver token literal no SQL");
  assert.ok(!sql.includes("service_role"), "não pode usar service_role no cron");
  ok("headers via Vault (yes_hotel_edge_anon_key), sem valor literal");

  // 9) timeout explícito
  const timeoutOccurrences = sql.split("timeout_milliseconds := 55000").length - 1;
  assert.equal(timeoutOccurrences, 5, "os 5 jobs devem declarar timeout_milliseconds explícito");
  ok("timeout explícito (55000ms) nos 5 jobs");

  // 10) não referencia materialização/sync como destino de chamada (menções em
  // comentário explicando o que o scheduler NÃO faz são permitidas)
  assert.ok(
    !sql.includes("functions/v1/hits-reserva-materializar"),
    "não pode chamar hits-reserva-materializar",
  );
  assert.ok(
    !sql.includes("functions/v1/hits-reservation-sync"),
    "não pode chamar hits-reservation-sync",
  );
  ok("não chama hits-reserva-materializar nem hits-reservation-sync");

  // 11) sem escrita de reservas
  assert.ok(
    !/\b(insert|update|delete)\s+into\b/i.test(sql) && !/\bupdate\s+\w/i.test(sql),
    "migration não pode conter INSERT/UPDATE/DELETE de reservas",
  );
  ok("nenhum INSERT/UPDATE/DELETE de reservas");

  // 12) idempotência: unschedule por jobname antes de schedule
  assert.ok(sql.includes("cron.unschedule"), "deve haver cron.unschedule por jobname");
  for (const name of Object.keys(JOBS)) {
    const unscheduleIdx = sql.indexOf("do $$");
    const scheduleIdx = sql.indexOf(`cron.schedule(\n  '${name}'`);
    assert.ok(unscheduleIdx >= 0 && unscheduleIdx < scheduleIdx, `unschedule de ${name} deve vir antes do schedule`);
  }
  ok("jobs idempotentes: unschedule por jobname antes de cron.schedule");

  // ambiguidade PL/pgSQL: variável do loop não pode se chamar "jobname" (colide
  // com a coluna cron.job.jobname); deve ser v_jobname
  assert.ok(!/\bjobname\s+text\s*;/.test(sql), "não pode declarar variável ambígua `jobname text`");
  assert.ok(sql.includes("v_jobname"), "loop de unschedule deve usar variável distinta v_jobname");
  assert.ok(sql.includes("foreach v_jobname in array"), "foreach deve iterar em v_jobname");
  assert.ok(
    sql.includes("where cron.job.jobname = v_jobname"),
    "comparação deve usar cron.job.jobname = v_jobname (sem ambiguidade)",
  );
  ok("sem ambiguidade PL/pgSQL: variável de loop é v_jobname, não jobname");

  // preflight de timezone deve validar cron.timezone (não só TimeZone/SHOW timezone)
  assert.ok(
    sql.includes("cron.timezone"),
    "documentação/preflight deve mencionar explicitamente cron.timezone",
  );
  assert.ok(
    sql.includes("current_setting('cron.timezone'"),
    "preflight deve incluir current_setting('cron.timezone', true)",
  );
  const sqlWithoutComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.ok(
    !/alter\s+system/i.test(sqlWithoutComments),
    "migration não pode executar ALTER SYSTEM (fora de comentários)",
  );
  assert.ok(
    !/alter\s+database/i.test(sqlWithoutComments),
    "migration não pode executar ALTER DATABASE (fora de comentários)",
  );
  ok("preflight de timezone valida cron.timezone; sem ALTER SYSTEM/ALTER DATABASE");

  // 13) jobs existentes (TTLock/outbox/tolerância) não são tocados
  for (const existing of EXISTING_JOB_NAMES) {
    assert.ok(
      !sql.includes(`'${existing}'`),
      `migration do scheduler HITS não pode referenciar o job existente ${existing}`,
    );
  }
  ok("nenhum job TTLock/outbox/tolerância existente é alterado");

  // 14) os 5 horários não colidem no mesmo minuto (UTC)
  const allSlots = new Map<string, string>();
  for (const [name, expr] of Object.entries(JOBS)) {
    for (const [h, m] of expandSlots(expr)) {
      const key = `${h}:${m}`;
      const prev = allSlots.get(key);
      assert.ok(!prev, `colisão de horário entre ${prev} e ${name} em ${key} UTC`);
      allSlots.set(key, name);
    }
  }
  ok("os 5 horários não colidem no mesmo minuto (UTC)");

  // 15-18) conversões locais -> UTC específicas
  assert.equal(JOBS["yes-hotel-hits-preview-0700-1950"], "*/10 11-23 * * *");
  assert.ok(expandSlots(JOBS["yes-hotel-hits-preview-0700-1950"]).some(([h, m]) => h === 11 && m === 0));
  ok("07:00 local -> 11:00 UTC");

  assert.ok(expandSlots(JOBS["yes-hotel-hits-preview-2200"]).some(([h, m]) => h === 2 && m === 0));
  assert.equal(JOBS["yes-hotel-hits-preview-2200"], "0 2 * * *");
  ok("22:00 local -> 02:00 UTC");

  assert.ok(expandSlots(JOBS["yes-hotel-hits-preview-2259"]).some(([h, m]) => h === 2 && m === 59));
  assert.equal(JOBS["yes-hotel-hits-preview-2259"], "59 2 * * *");
  ok("22:59 local -> 02:59 UTC");

  assert.ok(expandSlots(JOBS["yes-hotel-hits-preview-0100"]).some(([h, m]) => h === 5 && m === 0));
  assert.equal(JOBS["yes-hotel-hits-preview-0100"], "0 5 * * *");
  ok("01:00 local -> 05:00 UTC");

  // Edge: contrato GET permanece intacto; log de sucesso é seguro (sem dados sensíveis)
  const edgeSrc = readRepo(EDGE);
  assert.match(edgeSrc, /req\.method !== "GET"/);
  assert.match(edgeSrc, /405/);
  assert.match(edgeSrc, /\[HITS_RESERVATIONS_PREVIEW\] ok/);
  assert.match(edgeSrc, /duration_ms/);
  assert.doesNotMatch(edgeSrc.match(/console\.log\("\[HITS_RESERVATIONS_PREVIEW\] ok"[\s\S]*?\)\);/)?.[0] ?? "", /guest|apartamento|document|phone|email|token|reservation_id/i);
  ok("Edge continua GET-only (405 nos demais métodos); log de sucesso sem dados sensíveis");

  console.log("OK test-hits-reservations-preview-scheduler-cron");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
