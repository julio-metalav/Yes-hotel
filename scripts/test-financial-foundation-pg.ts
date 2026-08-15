/**
 * Prova estrutural da foundation financeira em Postgres efêmero (Docker).
 * Sem remoto, sem secrets, sem PII real, sem aplicar em HOMO/PROD.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

const CONTAINER = `yes-hotel-fin-pg-${Date.now()}`;
const ROOT = resolve(process.cwd());
const SHA1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ADMIN_AUTH = "11111111-1111-1111-1111-111111111111";
const RECEPCAO_AUTH = "22222222-2222-2222-2222-222222222222";
const CAFE_AUTH = "33333333-3333-3333-3333-333333333333";

function docker(args: string[], opts?: { input?: string }) {
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    input: opts?.input,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`docker ${args.join(" ")} failed: ${r.stderr || r.stdout || r.status}`);
  }
  return r.stdout;
}

function psql(sql: string): string {
  return docker(
    [
      "exec",
      "-i",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-t",
      "-A",
      "-c",
      sql,
    ],
  ).trim();
}

function psqlExpectFail(sql: string): string {
  const r = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-t",
      "-A",
      "-c",
      sql,
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  if (r.status === 0) {
    throw new Error(`esperado falha SQL, mas passou: ${sql}\n${r.stdout}`);
  }
  return `${r.stderr || ""}\n${r.stdout || ""}`;
}

function psqlFile(path: string) {
  const sql = readFileSync(path, "utf8");
  return docker(
    [
      "exec",
      "-i",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { input: sql },
  );
}

function lastCount(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const nums = lines.filter((l) => /^\d+$/.test(l));
  return nums[nums.length - 1] ?? "";
}

function asRole(role: string, jwtSub: string | null, sql: string): string {
  const setJwt = jwtSub
    ? `select set_config('request.jwt.claim.sub', '${jwtSub}', false);`
    : `select set_config('request.jwt.claim.sub', '', false);`;
  return lastCount(psql(`begin; ${setJwt} set local role ${role}; ${sql} commit;`));
}

function asRoleExpectFail(role: string, jwtSub: string | null, sql: string): string {
  const setJwt = jwtSub
    ? `select set_config('request.jwt.claim.sub', '${jwtSub}', false);`
    : `select set_config('request.jwt.claim.sub', '', false);`;
  return psqlExpectFail(`begin; ${setJwt} set local role ${role}; ${sql} commit;`);
}

console.log("\n=== Fundação financeira V1 (Postgres efêmero) ===\n");

try {
  docker([
    "run",
    "-d",
    "--name",
    CONTAINER,
    "-e",
    "POSTGRES_PASSWORD=postgres",
    "postgres:15-alpine",
  ]);

  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      psql("select 1");
      ready = true;
      break;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  if (!ready) throw new Error("postgres nao ficou pronto");
  ok("postgres efêmero pronto");

  psqlFile(resolve(ROOT, "scripts/fixtures/financial-foundation-pg-bootstrap.sql"));
  psqlFile(resolve(ROOT, "supabase/migrations/20260814220000_financial_foundation_v1.sql"));
  ok("migration aplicada no Postgres efêmero");

  const tables = psql(`
    select string_agg(tablename, ',' order by tablename)
    from pg_tables
    where schemaname = 'public' and tablename like 'financial_%'
  `);
  assert.equal(
    tables,
    [
      "financial_accounts",
      "financial_ai_analyses",
      "financial_audit_findings",
      "financial_entries",
      "financial_import_row_errors",
      "financial_imports",
      "financial_reconciliation_groups",
      "financial_reconciliation_legs",
    ].join(","),
  );
  ok("8 tabelas financial_* criadas");

  const operationalTouched = psql(`
    select count(*) from pg_tables
    where schemaname = 'public'
      and tablename in (
        'operacional_reservas',
        'management_reservations',
        'management_receivables',
        'operacional_cobrancas_pagarme'
      )
  `);
  assert.equal(operationalTouched, "0");
  ok("nenhuma tabela operacional/management/Pagar.me criada ou alterada");

  const seedCount = psql("select count(*) from public.financial_accounts");
  assert.equal(seedCount, "2");
  const masks = psql(`
    select code || ':' || coalesce(account_mask, 'null')
    from public.financial_accounts
    order by code
  `);
  assert.equal(masks, "sicredi_0911:0911\nsicredi_principal:null");
  ok("seed Sicredi idempotente na primeira carga");

  psqlFile(resolve(ROOT, "supabase/migrations/20260814220000_financial_foundation_v1.sql"));
  assert.equal(psql("select count(*) from public.financial_accounts"), "2");
  ok("reaplicar migration/seed não duplica contas");

  psqlExpectFail(`
    insert into public.financial_accounts (code, kind, account_mask)
    values ('bad_mask', 'bank', '12345678')
  `);
  ok("constraint rejeita máscara com número longo");

  psql(`
    insert into public.financial_imports (
      source_type, file_sha256, parser_version, original_filename
    ) values ('ofx_bank', '${SHA1}', 'ofx@1.0.0', 'sicredi-principal.ofx')
  `);
  const dup = psqlExpectFail(`
    insert into public.financial_imports (
      source_type, file_sha256, parser_version, original_filename
    ) values ('ofx_bank', '${SHA1}', 'ofx@1.0.0', 'sicredi-principal-copy.ofx')
  `);
  assert.match(dup, /financial_imports_file_parser_uidx|duplicate key|unique/i);
  ok("mesmo SHA + mesma parser_version é rejeitado");

  psql(`
    insert into public.financial_imports (
      source_type, file_sha256, parser_version, original_filename
    ) values ('ofx_bank', '${SHA1}', 'ofx@1.1.0', 'sicredi-principal.ofx')
  `);
  assert.equal(psql(`select count(*) from public.financial_imports where file_sha256 = '${SHA1}'`), "2");
  ok("mesmo SHA + parser_version nova é permitido");

  const importId = psql(`
    select id from public.financial_imports
    where file_sha256 = '${SHA1}' and parser_version = 'ofx@1.1.0'
  `);
  const accountId = psql(`select id from public.financial_accounts where code = 'sicredi_principal'`);

  psqlExpectFail(`
    insert into public.financial_entries (
      account_id, source_system, source_kind, source_import_id,
      direction, entry_type, gross_amount_cents
    ) values (
      '${accountId}', 'sicredi', 'bank_credit', '${importId}',
      'credit', 'bank_tx', -10
    )
  `);
  ok("constraint rejeita valor negativo");

  psqlExpectFail(`
    insert into public.financial_entries (
      source_system, source_kind, source_import_id, direction, entry_type, raw_payload
    ) values (
      'omie', 'omie_receivable', '${importId}', 'credit', 'receivable',
      '{"cpf":"52998224725"}'::jsonb
    )
  `);
  ok("constraint rejeita raw_payload com chave de PII");

  psql(`
    insert into public.financial_entries (
      account_id, source_system, source_kind, source_import_id,
      source_record_id, direction, entry_type, gross_amount_cents, raw_payload
    ) values (
      '${accountId}', 'sicredi', 'bank_credit', '${importId}',
      'FITID-1', 'credit', 'bank_tx', 150050,
      '{"fitid":"FITID-1","gross_amount_cents":150050}'::jsonb
    )
  `);
  const entryId = psql(`select id from public.financial_entries where source_record_id = 'FITID-1'`);

  psql(`
    insert into public.financial_reconciliation_groups (
      status, match_method, rule_version, confidence, matched_amount_cents, score_evidence
    ) values (
      'suggested', 'exact', 'rec@1.0.0', 95, 150050,
      '{"amount_exact":true,"document_match":true,"date_distance_days":1,"name_match":"normalized_exact"}'::jsonb
    )
  `);
  const groupId = psql("select id from public.financial_reconciliation_groups limit 1");
  psql(`
    insert into public.financial_reconciliation_legs (group_id, entry_id, role, allocated_amount_cents)
    values ('${groupId}', '${entryId}', 'source', 150050)
  `);
  ok("grupo + perna + score_evidence persistidos");

  psqlExpectFail(`
    insert into public.financial_audit_findings (
      finding_type, signal_class, severity, status
    ) values (
      'unidentified_credit', 'divergence', 'low', 'fraude_confirmada'
    )
  `);
  ok("status fraude_confirmada rejeitado");

  psql(`
    insert into public.financial_audit_findings (
      finding_type, signal_class, severity, amount_cents, evidence
    ) values (
      'unidentified_credit', 'requires_review', 'medium', 150050,
      '{"entry_ids":["${entryId}"]}'::jsonb
    )
  `);
  const findingId = psql("select id from public.financial_audit_findings limit 1");
  psql(`
    insert into public.financial_ai_analyses (
      finding_id, provider, model, prompt_version, status, response_structured
    ) values (
      '${findingId}', null, null, 'audit@0.0.0', 'refused',
      '{"summary":"contrato apenas","needs_human_review":true}'::jsonb
    )
  `);
  ok("finding + análise IA contratual (sem provider Anthropic)");

  const fkLegs = psql(`
    select count(*) from information_schema.table_constraints
    where table_schema = 'public'
      and table_name = 'financial_reconciliation_legs'
      and constraint_type = 'FOREIGN KEY'
  `);
  assert.equal(fkLegs, "2");
  ok("FKs internas do grupo/perna presentes");

  psql(`
    insert into public.usuarios_internos (auth_user_id, nome, email_login, perfil_usuario, ativo)
    values
      ('${ADMIN_AUTH}', 'Admin Test', 'admin@example.test', 'admin', true),
      ('${RECEPCAO_AUTH}', 'Recepcao Test', 'recepcao@example.test', 'recepcao', true),
      ('${CAFE_AUTH}', 'Cafe Test', 'cafe@example.test', 'cafe', true)
  `);

  const adminRead = asRole(
    "authenticated",
    ADMIN_AUTH,
    "select count(*)::text from public.financial_entries;",
  );
  assert.equal(adminRead, "1");
  ok("admin autentica e lê financial_entries");

  const recepcaoRead = asRole(
    "authenticated",
    RECEPCAO_AUTH,
    "select count(*)::text from public.financial_entries;",
  );
  assert.equal(recepcaoRead, "0");
  ok("recepção não lê financial_entries");

  const cafeRead = asRole(
    "authenticated",
    CAFE_AUTH,
    "select count(*)::text from public.financial_accounts;",
  );
  assert.equal(cafeRead, "0");
  ok("café não lê financial_accounts");

  const writeFail = asRoleExpectFail(
    "authenticated",
    ADMIN_AUTH,
    `insert into public.financial_imports (source_type, file_sha256, parser_version)
     values ('ofx_bank', '${SHA2}', 'ofx@1.0.0');`,
  );
  assert.match(writeFail, /permission denied|42501|new row violates|policy/i);
  ok("authenticated (mesmo admin) não escreve direto");

  asRole(
    "service_role",
    null,
    `insert into public.financial_imports (source_type, file_sha256, parser_version)
     values ('ofx_bank', '${SHA2}', 'ofx@1.0.0');`,
  );
  assert.equal(psql(`select count(*) from public.financial_imports where file_sha256 = '${SHA2}'`), "1");
  ok("service_role escreve (writes futuros via backend)");

  psql("grant insert, update, delete on public.financial_entries to authenticated");
  assert.equal(psql("select has_table_privilege('authenticated', 'public.financial_entries', 'INSERT')"), "t");
  psqlFile(resolve(ROOT, "supabase/migrations/20260814233000_financial_grants_revoke_authenticated.sql"));
  assert.equal(psql("select has_table_privilege('authenticated', 'public.financial_entries', 'INSERT')"), "f");
  assert.equal(psql("select has_table_privilege('authenticated', 'public.financial_entries', 'UPDATE')"), "f");
  assert.equal(psql("select has_table_privilege('authenticated', 'public.financial_entries', 'DELETE')"), "f");
  assert.equal(psql("select has_table_privilege('authenticated', 'public.financial_entries', 'SELECT')"), "t");
  assert.equal(psql("select has_table_privilege('service_role', 'public.financial_entries', 'INSERT')"), "t");
  assert.equal(psql("select has_table_privilege('service_role', 'public.financial_accounts', 'DELETE')"), "t");
  const adminReadAfterRevoke = asRole(
    "authenticated",
    ADMIN_AUTH,
    "select count(*)::text from public.financial_entries;",
  );
  assert.equal(adminReadAfterRevoke, "1");
  const recepcaoAfterRevoke = asRole(
    "authenticated",
    RECEPCAO_AUTH,
    "select count(*)::text from public.financial_entries;",
  );
  assert.equal(recepcaoAfterRevoke, "0");
  ok("grants: REVOKE authenticated write; SELECT admin-only; service_role intacto");

  psqlFile(resolve(ROOT, "supabase/migrations/20260815010000_financial_entries_settled_amount_cents.sql"));
  psqlExpectFail(`
    update public.financial_entries
    set settled_amount_cents = -1
    where source_record_id = 'FITID-1'
  `);
  psql(`
    update public.financial_entries
    set settled_amount_cents = 150050
    where source_record_id = 'FITID-1'
  `);
  assert.equal(psql("select settled_amount_cents from public.financial_entries where source_record_id = 'FITID-1'"), "150050");
  ok("settled_amount_cents aceita >=0 e rejeita negativo");

  const uniqueIdx = psql(`
    select indexname from pg_indexes
    where schemaname = 'public'
      and indexname = 'financial_imports_file_parser_uidx'
  `);
  assert.equal(uniqueIdx, "financial_imports_file_parser_uidx");
  ok("unique (file_sha256, parser_version) existe");

  psqlFile(resolve(ROOT, "supabase/migrations/20260815001829_financial_reconciliation_key.sql"));
  assert.equal(
    psql(`
      select indexname from pg_indexes
      where schemaname = 'public'
        and indexname = 'financial_reconciliation_groups_reconciliation_key_uidx'
    `),
    "financial_reconciliation_groups_reconciliation_key_uidx",
  );
  ok("reconciliation_key unique existe");

  psql(`
    insert into public.financial_imports (source_type, file_sha256, parser_version)
    values ('ofx_bank', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 'ofx@1.0.0')
  `);
  const persistImport = psql(`select id from public.financial_imports where parser_version = 'ofx@1.0.0' and file_sha256 like 'cc%'`);
  const persistAccount = psql(`select id from public.financial_accounts where code = 'sicredi_principal'`);
  psql(`
    insert into public.financial_entries (
      account_id, source_system, source_kind, source_import_id, direction, entry_type,
      settled_amount_cents, gross_amount_cents, source_record_id
    ) values (
      null, 'omie', 'omie_receivable', '${persistImport}', 'credit', 'receivable', 50000, 50000, 'PERSIST-OMIE-1'
    )
  `);
  psql(`
    insert into public.financial_entries (
      account_id, source_system, source_kind, source_import_id, direction, entry_type, gross_amount_cents, source_record_id
    ) values (
      '${persistAccount}', 'sicredi', 'bank_credit', '${persistImport}', 'credit', 'bank_tx', 50000, 'PERSIST-BANK-1'
    )
  `);
  const persistOmie = psql(`select id from public.financial_entries where source_record_id = 'PERSIST-OMIE-1'`);
  const persistBank = psql(`select id from public.financial_entries where source_record_id = 'PERSIST-BANK-1'`);
  const persistSql = `
begin;
insert into public.financial_reconciliation_groups (
  status, match_method, rule_version, confidence, matched_amount_cents, score_evidence, reconciliation_key
)
select 'auto_matched', 'one_to_one', 'omie_sicredi_v1.2', 93, 50000,
  '{"amount_exact":true,"party_match":"token_exact"}'::jsonb,
  'persist-high-key-1'
where not exists (
  select 1 from public.financial_reconciliation_groups g
  where g.reconciliation_key = 'persist-high-key-1'
);
insert into public.financial_reconciliation_legs (group_id, entry_id, role, allocated_amount_cents)
select g.id, '${persistOmie}'::uuid, 'source', 50000
from public.financial_reconciliation_groups g
where g.reconciliation_key = 'persist-high-key-1'
  and not exists (
    select 1 from public.financial_reconciliation_legs l
    where l.group_id = g.id and l.entry_id = '${persistOmie}'::uuid
  );
insert into public.financial_reconciliation_legs (group_id, entry_id, role, allocated_amount_cents)
select g.id, '${persistBank}'::uuid, 'target', 50000
from public.financial_reconciliation_groups g
where g.reconciliation_key = 'persist-high-key-1'
  and not exists (
    select 1 from public.financial_reconciliation_legs l
    where l.group_id = g.id and l.entry_id = '${persistBank}'::uuid
  );
commit;
`;
  psql(persistSql);
  psql(persistSql);
  assert.equal(psql(`select count(*) from public.financial_reconciliation_groups where reconciliation_key = 'persist-high-key-1'`), "1");
  assert.equal(psql(`select count(*) from public.financial_reconciliation_legs l join public.financial_reconciliation_groups g on g.id = l.group_id where g.reconciliation_key = 'persist-high-key-1'`), "2");
  assert.equal(psql(`select count(*) from public.financial_reconciliation_groups g where not exists (select 1 from public.financial_reconciliation_legs l where l.group_id = g.id)`), "0");
  ok("persist high idempotente e atômico no Postgres efêmero");

  console.log(`\n${passed} testes ok\n`);
} finally {
  spawnSync("docker", ["rm", "-f", CONTAINER], { encoding: "utf8" });
}
