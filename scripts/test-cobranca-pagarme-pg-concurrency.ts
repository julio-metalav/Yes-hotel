/**
 * Teste REAL de concorrência contra Postgres efêmero (Docker).
 * Sem remoto / sem Pagar.me real / sem secrets.
 *
 * Prova:
 * A) índice único parcial bloqueante (inclui paid/refunded/chargeback)
 * B) conflito 23505 no insert
 * C) formato real do erro Postgres code=23505
 * D) serviço não chama Pagar.me após conflito
 * E) transição concurrent pending→paid vs criar() não gera 2ª cobrança
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { CobrancaPagarmeService } from "../src/lib/application/yes-hotel/cobranca-pagarme-service";
import type {
  CobrancaPagarmeRepository,
  CobrancaPagarmeRow,
} from "../src/lib/application/yes-hotel/cobranca-pagarme-service";
import {
  PAGARME_CHECKOUT_TEST_API_BASE_URL,
  PAGARME_CORE_API_BASE_URL,
  PAGARME_FIXTURE_SECRET,
  PagarmeClient,
  createMockPagarmeFetch,
  fixturePaymentLinkResponse,
  getPagarmeConfig,
  isCobrancaStatusBloqueante,
} from "../src/lib/integrations/pagarme";

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

const CONTAINER = `yes-hotel-cp2-pg-${Date.now()}`;
const PORT = String(55432 + Math.floor(Math.random() * 200));
const ROOT = resolve(process.cwd());

function docker(args: string[], opts?: { input?: string }) {
  const r = spawnSync("docker", args, {
    encoding: "utf8",
    input: opts?.input,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(
      `docker ${args.join(" ")} failed: ${r.stderr || r.stdout || r.status}`,
    );
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

function loadPg(): typeof import("pg") {
  const req = createRequire(resolve(ROOT, "package.json"));
  return req("pg") as typeof import("pg");
}

function ensurePg(): typeof import("pg") {
  try {
    return loadPg();
  } catch {
    console.log("  .. instalando pg (--no-save) para o teste local");
    execFileSync("npm", ["install", "--no-save", "pg"], {
      stdio: "inherit",
      cwd: ROOT,
      shell: true,
    });
    return loadPg();
  }
}

function mapRow(row: Record<string, unknown>): CobrancaPagarmeRow {
  return {
    id: String(row.id),
    reserva_id: String(row.reserva_id),
    external_reservation_id:
      row.external_reservation_id == null ? null : String(row.external_reservation_id),
    metodo: row.metodo as CobrancaPagarmeRow["metodo"],
    valor_centavos: Number(row.valor_centavos),
    moeda: String(row.moeda ?? "BRL"),
    idempotency_key: String(row.idempotency_key),
    status: row.status as CobrancaPagarmeRow["status"],
    pagarme_payment_link_id:
      row.pagarme_payment_link_id == null ? null : String(row.pagarme_payment_link_id),
    pagarme_payment_link_url:
      row.pagarme_payment_link_url == null ? null : String(row.pagarme_payment_link_url),
    pagarme_order_id: row.pagarme_order_id == null ? null : String(row.pagarme_order_id),
    pagarme_charge_id: row.pagarme_charge_id == null ? null : String(row.pagarme_charge_id),
    pix_qr_code: row.pix_qr_code == null ? null : String(row.pix_qr_code),
    pix_qr_code_url: row.pix_qr_code_url == null ? null : String(row.pix_qr_code_url),
    expira_em: row.expira_em == null ? null : String(row.expira_em),
    pagarme_status_raw:
      row.pagarme_status_raw == null ? null : String(row.pagarme_status_raw),
    requer_revisao_operacional: Boolean(row.requer_revisao_operacional),
    requer_revisao_motivo:
      (row.requer_revisao_motivo as CobrancaPagarmeRow["requer_revisao_motivo"]) ?? null,
    requer_revisao_detectado_em:
      row.requer_revisao_detectado_em == null
        ? null
        : String(row.requer_revisao_detectado_em),
    criado_por_user_id: String(row.criado_por_user_id),
  };
}

function createPgRepo(client: import("pg").Client): CobrancaPagarmeRepository {
  return {
    async getReservaById(reservaId) {
      const { rows } = await client.query(
        `select id, external_reservation_id, classificacao_comissionamento, pagamento_status, hospede_principal
         from operacional_reservas where id = $1`,
        [reservaId],
      );
      return (rows[0] as never) ?? null;
    },
    async updateClassificacaoComissionamento(input) {
      const { rows } = await client.query(
        `update operacional_reservas
         set classificacao_comissionamento = $2,
             classificacao_comissionamento_origem = $3,
             classificacao_comissionamento_atualizado_em = $4
         where id = $1
         returning id, external_reservation_id, classificacao_comissionamento, pagamento_status, hospede_principal`,
        [input.reservaId, input.classificacao, input.origem, input.atualizadoEm],
      );
      return rows[0] as never;
    },
    async insertCobranca(row) {
      try {
        const { rows } = await client.query(
          `insert into operacional_cobrancas_pagarme
             (id, reserva_id, external_reservation_id, metodo, valor_centavos, moeda,
              idempotency_key, status, criado_por_user_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           returning *`,
          [
            row.id,
            row.reserva_id,
            row.external_reservation_id,
            row.metodo,
            row.valor_centavos,
            row.moeda,
            row.idempotency_key,
            row.status,
            row.criado_por_user_id,
          ],
        );
        return { ok: true, cobranca: mapRow(rows[0] as Record<string, unknown>) };
      } catch (e: unknown) {
        const err = e as { code?: string };
        if (err.code === "23505") return { ok: false, conflict: true, code: "23505" };
        throw e;
      }
    },
    async findActiveCobrancaByReserva(reservaId) {
      const { rows } = await client.query(
        `select * from operacional_cobrancas_pagarme
         where reserva_id = $1 and status in ('created','pending','processing')
         order by created_at desc limit 1`,
        [reservaId],
      );
      return rows[0] ? mapRow(rows[0] as Record<string, unknown>) : null;
    },
    async findBlockingCobrancaByReserva(reservaId) {
      const { rows } = await client.query(
        `select * from operacional_cobrancas_pagarme
         where reserva_id = $1
           and status in ('created','pending','processing','paid','refunded','chargeback')
         order by created_at desc limit 1`,
        [reservaId],
      );
      return rows[0] ? mapRow(rows[0] as Record<string, unknown>) : null;
    },
    async getCobrancaById(id) {
      const { rows } = await client.query(
        `select * from operacional_cobrancas_pagarme where id = $1`,
        [id],
      );
      return rows[0] ? mapRow(rows[0] as Record<string, unknown>) : null;
    },
    async findCobrancaByOrderCode(orderCode) {
      const byId = await this.getCobrancaById(orderCode);
      if (byId) return byId;
      const { rows } = await client.query(
        `select * from operacional_cobrancas_pagarme where pagarme_order_id = $1`,
        [orderCode],
      );
      return rows[0] ? mapRow(rows[0] as Record<string, unknown>) : null;
    },
    async findCobrancaByChargeId(chargeId) {
      const { rows } = await client.query(
        `select * from operacional_cobrancas_pagarme where pagarme_charge_id = $1`,
        [chargeId],
      );
      return rows[0] ? mapRow(rows[0] as Record<string, unknown>) : null;
    },
    async findCobrancaByPaymentLinkId(paymentLinkId) {
      const { rows } = await client.query(
        `select * from operacional_cobrancas_pagarme where pagarme_payment_link_id = $1`,
        [paymentLinkId],
      );
      return rows[0] ? mapRow(rows[0] as Record<string, unknown>) : null;
    },
    async updateCobranca(cobrancaId, patch) {
      const keys = Object.keys(patch);
      if (keys.length === 0) {
        const cur = await this.getCobrancaById(cobrancaId);
        if (!cur) throw new Error("missing");
        return cur;
      }
      const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
      const vals = keys.map((k) => (patch as Record<string, unknown>)[k]);
      const { rows } = await client.query(
        `update operacional_cobrancas_pagarme set ${sets} where id = $1 returning *`,
        [cobrancaId, ...vals],
      );
      return mapRow(rows[0] as Record<string, unknown>);
    },
    async insertWebhookEvent() {
      return { inserted: true, id: crypto.randomUUID() };
    },
    async markWebhookProcessed() {},
    async insertPagamento() {
      return { ok: false, conflict: true };
    },
  };
}

async function main() {
  console.log("\n[test-cobranca-pagarme-pg-concurrency]");
  console.log(`  container=${CONTAINER} port=${PORT}`);

  let client: import("pg").Client | null = null;
  try {
    docker([
      "run",
      "-d",
      "--rm",
      "--name",
      CONTAINER,
      "-e",
      "POSTGRES_PASSWORD=postgres",
      "-p",
      `${PORT}:5432`,
      "postgres:15-alpine",
    ]);

    // wait ready
    for (let i = 0; i < 40; i += 1) {
      try {
        psql("select 1");
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
        if (i === 39) throw new Error("postgres nao ficou pronto");
      }
    }
    ok("postgres efemero pronto");

    psqlFile(resolve(ROOT, "scripts/fixtures/cobranca-pagarme-pg-bootstrap.sql"));
    psqlFile(
      resolve(ROOT, "supabase/migrations/20260809233000_operacional_cobrancas_pagarme.sql"),
    );
    ok("bootstrap + migration aplicados");

    // índice inclui paid
    const idx = psql(`
      select indexdef from pg_indexes
      where indexname = 'operacional_cobrancas_pagarme_reserva_ativa_uidx'
    `);
    assert.match(idx, /paid/);
    assert.match(idx, /refunded/);
    assert.match(idx, /chargeback/);
    ok("indice parcial inclui paid/refunded/chargeback");

    const pgMod = ensurePg();
    const PgClient = pgMod.Client;
    client = new PgClient({
      host: "127.0.0.1",
      port: Number(PORT),
      user: "postgres",
      password: "postgres",
      database: "postgres",
    });
    await client.connect();

    const operadorId = crypto.randomUUID();
    await client.query(
      `insert into usuarios_internos (id, nome, email_login, perfil_usuario, ativo)
       values ($1, 'Op', 'op@example.invalid', 'admin', true)`,
      [operadorId],
    );
    const reservaId = crypto.randomUUID();
    await client.query(
      `insert into operacional_reservas
         (id, pagamento_status, classificacao_comissionamento, classificacao_comissionamento_origem)
       values ($1, 'pendente', 'nao_comissionada', 'manual_operador')`,
      [reservaId],
    );

    // A) duas inserts concurrent created → uma 23505
    const idA = crypto.randomUUID();
    const idB = crypto.randomUUID();
    const insertSql = `
      insert into operacional_cobrancas_pagarme
        (id, reserva_id, metodo, valor_centavos, idempotency_key, status, criado_por_user_id)
      values ($1, $2, 'cartao', 120000, $3, 'created', $4)
    `;
    const r1 = client.query(insertSql, [idA, reservaId, `k-${idA}`, operadorId]);
    const r2 = client.query(insertSql, [idB, reservaId, `k-${idB}`, operadorId]);
    const settled = await Promise.allSettled([r1, r2]);
    const oks = settled.filter((s) => s.status === "fulfilled").length;
    const fails = settled.filter((s) => s.status === "rejected");
    assert.equal(oks, 1);
    assert.equal(fails.length, 1);
    const rej = fails[0] as PromiseRejectedResult;
    const code = (rej.reason as { code?: string }).code;
    assert.equal(code, "23505");
    ok("concorrencia created×created: uma ok, uma 23505 real");

    // B/C) paid bloqueia nova created (SQL)
    await client.query(
      `update operacional_cobrancas_pagarme set status = 'paid' where reserva_id = $1`,
      [reservaId],
    );
    let paidBlockCode: string | null = null;
    try {
      await client.query(insertSql, [
        crypto.randomUUID(),
        reservaId,
        `k-after-paid`,
        operadorId,
      ]);
    } catch (e: unknown) {
      paidBlockCode = (e as { code?: string }).code ?? null;
    }
    assert.equal(paidBlockCode, "23505");
    ok("paid no banco bloqueia insert created via 23505");

    // D/E) serviço: race update paid vs criar — via duas conexões
    await client.query(`delete from operacional_cobrancas_pagarme where reserva_id = $1`, [
      reservaId,
    ]);
    const pendingId = crypto.randomUUID();
    await client.query(insertSql, [
      pendingId,
      reservaId,
      `k-${pendingId}`,
      operadorId,
    ]);
    await client.query(
      `update operacional_cobrancas_pagarme set status = 'pending' where id = $1`,
      [pendingId],
    );

    const client2 = new PgClient({
      host: "127.0.0.1",
      port: Number(PORT),
      user: "postgres",
      password: "postgres",
      database: "postgres",
    });
    await client2.connect();

    let pagarmeCalls = 0;
    const repo = createPgRepo(client2);
    const svc = new CobrancaPagarmeService({
      repo,
      client: new PagarmeClient({
        config: getPagarmeConfig({
          PAGARME_ENV: "test",
          PAGARME_INTEGRATION_ENABLED: "true",
          PAGARME_SECRET_KEY: PAGARME_FIXTURE_SECRET,
          PAGARME_CORE_API_BASE_URL: PAGARME_CORE_API_BASE_URL,
          PAGARME_CHECKOUT_API_BASE_URL: PAGARME_CHECKOUT_TEST_API_BASE_URL,
        }),
        fetchImpl: createMockPagarmeFetch([
          {
            match: (u, m) => {
              if (m === "POST" && u.includes("/paymentlinks")) {
                pagarmeCalls += 1;
                return true;
              }
              return false;
            },
            body: fixturePaymentLinkResponse,
          },
        ]) as never,
      }),
    });

    // Dispara em paralelo: confirma paid + tenta criar nova
    const markPaid = client.query(
      `update operacional_cobrancas_pagarme set status = 'paid' where id = $1`,
      [pendingId],
    );
    const createAttempt = svc.criar({
      reservaId,
      metodo: "cartao",
      valorCentavos: 150_000,
      operadorUserId: operadorId,
    });
    const [paidRes, createRes] = await Promise.all([markPaid, createAttempt]);
    assert.ok(paidRes.rowCount === 1);

    const count = await client.query(
      `select count(*)::int as n from operacional_cobrancas_pagarme where reserva_id = $1`,
      [reservaId],
    );
    assert.equal(Number(count.rows[0].n), 1);

    if (createRes.ok && createRes.data.reused_existing) {
      // reusou a existente (ainda pending no momento do pre-check) — ok se não criou segunda
      assert.equal(pagarmeCalls, 0);
    } else if (!createRes.ok) {
      assert.equal(createRes.error.code, "obrigacao_ja_paga");
      assert.equal(pagarmeCalls, 0);
    } else {
      // se create "ok" sem reuse, seria bug — não deve haver 2 linhas
      assert.fail("criar() nao deveria inserir segunda cobranca");
    }

    const statuses = await client.query(
      `select status from operacional_cobrancas_pagarme where reserva_id = $1`,
      [reservaId],
    );
    assert.equal(statuses.rows.length, 1);
    assert.equal(statuses.rows[0].status, "paid");
    assert.equal(isCobrancaStatusBloqueante("paid"), true);
    ok("race paid×criar: permanece 1 cobranca; zero chamada Pagar.me extra");

    // failed permite nova
    await client.query(
      `update operacional_cobrancas_pagarme set status = 'failed' where id = $1`,
      [pendingId],
    );
    const afterFailed = await svc.criar({
      reservaId,
      metodo: "cartao",
      valorCentavos: 130_000,
      operadorUserId: operadorId,
    });
    assert.equal(afterFailed.ok, true);
    assert.equal(pagarmeCalls, 1);
    const n2 = await client.query(
      `select count(*)::int as n from operacional_cobrancas_pagarme where reserva_id = $1`,
      [reservaId],
    );
    assert.equal(Number(n2.rows[0].n), 2);
    ok("failed permite nova cobranca (indice libera)");

    await client2.end();
    console.log(`\n[test-cobranca-pagarme-pg-concurrency] ${passed} assertions OK\n`);
  } finally {
    if (client) {
      try {
        await client.end();
      } catch {
        /* ignore */
      }
    }
    try {
      docker(["rm", "-f", CONTAINER]);
    } catch {
      /* ignore */
    }
  }
}

main().catch((error) => {
  console.error("[test-cobranca-pagarme-pg-concurrency] FALHOU:", error);
  try {
    docker(["rm", "-f", CONTAINER]);
  } catch {
    /* ignore */
  }
  process.exit(1);
});
