/**
 * Contrato /v3/keyboardPwd/change: changeType=2, erro TTLock preservado, sem secrets.
 * Sem I/O real.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TtlockApiError } from "../src/lib/integrations/ttlock/types.ts";
import { TtlockClient } from "../src/lib/integrations/ttlock/client.ts";
import { TtlockChangeValidityAdapter } from "../src/lib/integrations/ttlock/access-ingest/ttlock-change-validity-adapter.ts";
import {
  assertTtlockPublicErrorSafe,
  formatTtlockPublicErrorMessage,
  parseTtlockPublicError,
} from "../src/lib/integrations/ttlock/ttlock-api-error.ts";
import {
  TTLOCK_CHANGE_TYPE_GATEWAY,
  TTLOCK_PASSCODE_FORM_CONTENT_TYPE,
  TTLOCK_PASSCODE_JSON_CONTENT_TYPE,
  buildTtlockChangeValidityFields,
  describeTtlockValidityMs,
  encodeTtlockChangeValidityForm,
} from "../src/lib/integrations/ttlock/ttlock-change-request.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function readRepo(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

let passed = 0;
function ok(name: string) {
  passed += 1;
  console.log(`  OK  ${name}`);
}

function testChangeTypeGateway() {
  const fields = buildTtlockChangeValidityFields({
    lockId: 16274746,
    keyboardPwdId: 999001,
    startDateMs: Date.parse("2026-08-13T13:00:00.000Z"),
    endDateMs: Date.parse("2026-08-13T14:00:00.000Z"),
    dateMs: 1_700_000_000_000,
  });
  assert.equal(fields.changeType, 2);
  assert.equal(fields.changeType, TTLOCK_CHANGE_TYPE_GATEWAY);
  const form = encodeTtlockChangeValidityForm(fields, {
    clientId: "cid",
    accessToken: "tok_secret_value",
  });
  assert.equal(form.get("changeType"), "2");
  assert.equal(form.get("lockId"), "16274746");
  assert.equal(form.get("keyboardPwdId"), "999001");
  assert.equal(form.get("startDate"), String(fields.startDate));
  assert.equal(form.get("endDate"), String(fields.endDate));
  assert.ok(!form.has("newKeyboardPwd"));
  assert.ok(!form.has("keyboardPwdName"));
  ok("change via gateway envia changeType=2 e sem newKeyboardPwd");
}

function testClientSourceContract() {
  const src = readRepo("src/lib/integrations/ttlock/client.ts");
  const add = src.slice(src.indexOf("async createKeyboardPassword"), src.indexOf("async deleteKeyboardPassword"));
  const del = src.slice(src.indexOf("async deleteKeyboardPassword"), src.indexOf("async changeKeyboardPassword"));
  const chg = src.slice(src.indexOf("async changeKeyboardPassword"), src.indexOf("async listKeyboardPasswords"));
  assert.match(add, /addType:\s*2/);
  assert.match(add, /application\/json/);
  assert.match(del, /deleteType:\s*"2"/);
  assert.match(del, /application\/x-www-form-urlencoded/);
  assert.match(chg, /TTLOCK_CHANGE_TYPE_GATEWAY|changeType:\s*2/);
  assert.match(chg, /TTLOCK_PASSCODE_FORM_CONTENT_TYPE|application\/x-www-form-urlencoded/);
  assert.doesNotMatch(chg, /application\/json/);
  ok("ADD JSON+addType=2; DELETE form+deleteType=2; CHANGE form+changeType=2");
}

function testLifecycleChangeIsForm() {
  const src = readRepo("supabase/functions/yes-hotel-lifecycle/index.ts");
  const fn = src.slice(
    src.indexOf("async function ttlockChangeKeyboardPasswordValidity"),
    src.indexOf("async function ttlockChangeKeyboardPasswordValidity") + 2500,
  );
  assert.match(fn, /changeType["']?\s*,\s*["']2["']/);
  assert.match(fn, /application\/x-www-form-urlencoded/);
  ok("lifecycle change já envia form-urlencoded + changeType=2");
}

function testErrorBodyPreserved() {
  const html = parseTtlockPublicError(400, "<html>Bad Request</html>");
  assert.equal(html.body_kind, "text");
  assert.equal(html.http_status, 400);
  assert.match(formatTtlockPublicErrorMessage(html), /http=400/);
  assert.match(formatTtlockPublicErrorMessage(html), /body=<html>Bad Request<\/html>/);

  const json = parseTtlockPublicError(200, {
    errcode: -2018,
    errmsg: "Failed to change passcode",
    description: "lock offline or invalid param",
  });
  assert.equal(json.body_kind, "json");
  assert.equal(json.errcode, -2018);
  assert.equal(json.errmsg, "Failed to change passcode");
  const msg = formatTtlockPublicErrorMessage(json);
  assert.match(msg, /errcode=-2018/);
  assert.match(msg, /errmsg=Failed to change passcode/);
  assertTtlockPublicErrorSafe(json);
  ok("corpo de erro TTLock (JSON e texto) é preservado");
}

function testSecretsNeverInError() {
  const leaked = parseTtlockPublicError(400, {
    errcode: -1,
    errmsg: "x",
    accessToken: "SHOULD_NOT_APPEAR",
    clientSecret: "SECRET",
  });
  const msg = formatTtlockPublicErrorMessage(leaked);
  assert.doesNotMatch(msg, /SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(msg, /SECRET/);
  assert.doesNotMatch(JSON.stringify(leaked), /SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(JSON.stringify(leaked), /"accessToken"/);
  assertTtlockPublicErrorSafe(leaked);

  const textLeak = parseTtlockPublicError(
    400,
    '{"accessToken":"tok123","clientSecret":"sec"}',
  );
  assert.equal(textLeak.body_preview, "[redacted_sensitive_keys]");

  const htmlLeak = parseTtlockPublicError(
    400,
    "<html>Bad Request accessToken=tok_SECRET</html>",
  );
  assert.doesNotMatch(htmlLeak.body_preview, /tok_SECRET/);
  assert.match(htmlLeak.body_preview, /accessToken=\[redacted\]/);
  ok("auth/secrets nunca aparecem no erro público");
}

function testDatesContractView() {
  const messy = describeTtlockValidityMs(Date.parse("2026-08-14T00:56:37.961Z"));
  assert.equal(messy.utc_iso, "2026-08-14T00:56:37.961Z");
  assert.match(messy.campo_grande, /2026-08-13 20:56:37/);
  assert.equal(messy.minute, 56);
  assert.equal(messy.second, 37);
  assert.equal(messy.hour_aligned, false);

  const hour = describeTtlockValidityMs(Date.parse("2026-08-14T13:00:00.000Z"));
  assert.equal(hour.hour_aligned, true);
  assert.equal(hour.minute, 0);
  assert.equal(hour.second, 0);
  ok("datas descritas em UTC + America/Campo_Grande com hour_aligned");
}

async function testAdapterPreservesError() {
  const client = {
    async changeKeyboardPassword() {
      throw new TtlockApiError(
        "ignored raw",
        400,
        { errcode: -3006, errmsg: "Change passcode failed", description: "invalid date" },
      );
    },
  };
  const adapter = new TtlockChangeValidityAdapter(client as never);
  const result = await adapter.changeValidityOnly({
    lockId: 16274746,
    keyboardPwdId: 1,
    startDateMs: 1,
    endDateMs: 2,
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected fail");
  assert.match(result.error, /errcode=-3006/);
  assert.match(result.error, /errmsg=Change passcode failed/);
  assert.doesNotMatch(result.error, /accessToken|clientSecret|keyboardPwd/i);
  ok("adapter preserva errcode/errmsg sem secrets");
}

async function testAdapterDoesNotSendNewPwd() {
  const calls: unknown[] = [];
  const client = {
    async changeKeyboardPassword(params: Record<string, unknown>) {
      calls.push(params);
    },
  };
  const adapter = new TtlockChangeValidityAdapter(client as never);
  const result = await adapter.changeValidityOnly({
    lockId: 16274746,
    keyboardPwdId: 42,
    startDateMs: 1000,
    endDateMs: 2000,
  });
  assert.equal(result.ok, true);
  const sent = calls[0] as Record<string, unknown>;
  assert.equal(sent.lockId, 16274746);
  assert.equal(sent.keyboardPwdId, 42);
  assert.equal(sent.startDate, 1000);
  assert.equal(sent.endDate, 2000);
  assert.equal("newKeyboardPwd" in sent, false);
  assert.equal("keyboardPwdName" in sent, false);
  ok("adapter changeValidityOnly não envia newKeyboardPwd nem name");
}

function testFormContentTypeConstant() {
  assert.equal(TTLOCK_PASSCODE_FORM_CONTENT_TYPE, "application/x-www-form-urlencoded");
  assert.equal(TTLOCK_PASSCODE_JSON_CONTENT_TYPE, "application/json");
  ok("constantes de content-type do contrato");
}

async function testClientChangeSendsFormAndPreservesHtml400() {
  const calls: Array<{ url: string; contentType: string; body: string }> = [];
  const fetchImpl: typeof fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const headers = new Headers(init?.headers);
    calls.push({
      url: u,
      contentType: headers.get("content-type") ?? "",
      body: String(init?.body ?? ""),
    });
    if (u.includes("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 9999 }), {
        status: 200,
      });
    }
    return new Response("<html>HTTP Status 400 – Bad Request</html>", { status: 400 });
  }) as typeof fetch;

  const client = new TtlockClient({
    config: {
      clientId: "cid",
      clientSecret: "csec_secret",
      username: "u",
      password: "p",
      tokenUrl: "https://example.test/oauth2/token",
      apiBaseUrl: "https://example.test",
      enabled: true,
      hasCredentials: true,
    },
    fetchImpl,
  });

  await assert.rejects(
    () =>
      client.changeKeyboardPassword({
        lockId: 16274746,
        keyboardPwdId: 99,
        startDate: 1000,
        endDate: 2000,
      }),
    (e: unknown) => {
      assert.ok(e instanceof TtlockApiError);
      assert.match(e.message, /http=400/);
      assert.match(e.message, /HTTP Status 400/);
      assert.doesNotMatch(e.message, /csec_secret/);
      assert.doesNotMatch(e.message, /accessToken=tok/);
      return true;
    },
  );

  const change = calls.find((c) => c.url.includes("/keyboardPwd/change"));
  assert.ok(change);
  assert.equal(change.contentType, "application/x-www-form-urlencoded");
  assert.match(change.body, /changeType=2/);
  assert.match(change.body, /lockId=16274746/);
  assert.match(change.body, /keyboardPwdId=99/);
  assert.doesNotMatch(change.body, /csec_secret/);
  ok("client change envia form-urlencoded+changeType=2 e preserva HTML 400 sem secrets");
}

async function main() {
  console.log("test-ttlock-change-400-observability");
  testChangeTypeGateway();
  testClientSourceContract();
  testLifecycleChangeIsForm();
  testErrorBodyPreserved();
  testSecretsNeverInError();
  testDatesContractView();
  await testAdapterPreservesError();
  await testAdapterDoesNotSendNewPwd();
  testFormContentTypeConstant();
  await testClientChangeSendsFormAndPreservesHtml400();
  console.log(`\n${passed} testes OK`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
