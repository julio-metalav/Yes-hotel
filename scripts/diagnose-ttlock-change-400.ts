/**
 * Diagnóstico isolado do HTTP 400 em /v3/keyboardPwd/change.
 * Lock homolog 16274746. NÃO usa Breno. NÃO altera gate global.
 *
 * Uso: npx tsx scripts/diagnose-ttlock-change-400.ts
 */
import { execSync } from "node:child_process";

const PROJECT_REF = "minmmecajnmjqlgacfoz";
const LOCK_ID = 16274746;
const BRENO_PWD_ID = 104041356;
const DIAG_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/ttlock-lock-record-diagnose`;
const SYNC_WAIT_MS = 60_000;

function loadServiceRole(): string {
  const raw = execSync(
    `npx supabase projects api-keys --project-ref ${PROJECT_REF} --reveal -o json`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const keys = JSON.parse(raw) as Array<{ name?: string; api_key?: string }>;
  const service = keys.find((k) => k.name === "service_role");
  if (!service?.api_key) throw new Error("service_role ausente");
  return service.api_key;
}

async function invoke(key: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(DIAG_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
      apikey: key,
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`diagnose HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function redact(value: unknown): unknown {
  const raw = JSON.stringify(value);
  if (/accessToken|clientSecret|keyboardPwd|lockKey|adminPwd|aesKey/i.test(raw) &&
      /"(accessToken|clientSecret|keyboardPwd|lockKey|adminPwd|aesKeyStr)"\s*:/.test(raw)) {
    return { redacted: true };
  }
  return value;
}

async function main() {
  console.log("=== diagnose TTLock change HTTP 400 ===");
  console.log("lockId:", LOCK_ID);
  console.log("gate: YES_HOTEL_TTLOCK_HOMOLOG_LOCK_ID inalterado");
  const key = loadServiceRole();

  console.log("\n--- 1) lock_capacity ---");
  const capacity = await invoke(key, { mode: "lock_capacity", lockId: LOCK_ID });
  console.log(JSON.stringify(redact(capacity), null, 2));

  console.log("\n--- 2) gateway ---");
  const gateway = await invoke(key, { mode: "gateway", lockId: LOCK_ID });
  console.log(JSON.stringify(redact(gateway), null, 2));

  console.log("\n--- 3) change_add (senha sintética, form, hora cheia) ---");
  const added = await invoke(key, { mode: "change_add", lockId: LOCK_ID });
  console.log(JSON.stringify(redact(added), null, 2));
  const keyboardPwdId = Number(added.keyboardPwdId);
  if (!Number.isFinite(keyboardPwdId) || added.ok === false) {
    throw new Error("change_add falhou; abortando probes de change");
  }
  if (keyboardPwdId === BRENO_PWD_ID) {
    throw new Error("recusou: keyboardPwdId do Breno");
  }

  console.log(`aguardando ${SYNC_WAIT_MS / 1000}s para sync gateway`);
  await sleep(SYNC_WAIT_MS);

  const startDateMs = Number((added.startDate as { ms?: number } | undefined)?.ms);
  const smokeEndMs = Date.now();
  console.log("\n--- 4) change_run JSON vs form (endDate=agora, minuto não-zero) ---");
  const run = await invoke(key, {
    mode: "change_run",
    lockId: LOCK_ID,
    keyboardPwdId,
    startDateMs,
    endDateMs: smokeEndMs,
    alsoHourAligned: true,
  });
  console.log(JSON.stringify(redact(run), null, 2));

  console.log("\n--- 5) change_delete ---");
  const deleted = await invoke(key, {
    mode: "change_delete",
    lockId: LOCK_ID,
    keyboardPwdId,
  });
  console.log(JSON.stringify(redact(deleted), null, 2));

  const verdict = run.verdict as Record<string, unknown> | undefined;
  console.log("\n=== VEREDITO ISOLADO ===");
  console.log(JSON.stringify(verdict ?? null, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
