/**
 * Smoke do artefato dist/server.js. Exige `npm run build` antes.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GATEWAY_VERSION } from "../src/version.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distFile = join(root, "dist", "server.js");
const TOKEN = "dist-smoke-gateway-token-not-real-32ch";

function listenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        s.close();
        reject(new Error("porta"));
        return;
      }
      const port = addr.port;
      s.close(() => resolve(port));
    });
  });
}

async function waitHealth(port: number, timeoutMs = 8_000): Promise<Response> {
  const started = Date.now();
  let last: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return res;
      last = res.status;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`health timeout: ${String(last)}`);
}

test("dist/server.js existe e não publica sourcemap", () => {
  assert.equal(existsSync(distFile), true, "rode npm run build antes deste smoke");
  assert.equal(existsSync(join(root, "dist", "server.js.map")), false);
});

test("artefato dist: health público, auth e 503 sem HITS", async () => {
  assert.equal(existsSync(distFile), true, "rode npm run build antes deste smoke");
  const port = await listenPort();
  const child = spawn(process.execPath, [distFile], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      GATEWAY_TOKEN: TOKEN,
      HITS_API_BASE_URL: "",
      HITS_SHARED_ACCESS_SECRET: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (buf: Buffer) => {
    stderr += buf.toString("utf8");
  });

  try {
    const healthRes = await waitHealth(port);
    const health = (await healthRes.json()) as Record<string, unknown>;
    assert.deepEqual(health, {
      status: "ok",
      service: "hits-gateway",
      version: GATEWAY_VERSION,
    });

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/reservations`);
    assert.equal(noAuth.status, 401);
    const noAuthBody = await noAuth.text();
    assert.equal(noAuthBody.includes(TOKEN), false);

    const withAuth = await fetch(`http://127.0.0.1:${port}/v1/reservations`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(withAuth.status, 503);
    const withAuthBody = await withAuth.text();
    assert.equal(withAuthBody.includes(TOKEN), false);
    assert.match(withAuthBody, /hits_not_configured/);

    const authorize = await fetch(`http://127.0.0.1:${port}/Authorize`, { method: "POST" });
    assert.equal(authorize.status, 404);

    const postNoAuth = await fetch(`http://127.0.0.1:${port}/v1/reservations/900001/guests`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guests: [{ name: "Sintetico" }] }),
    });
    assert.equal(postNoAuth.status, 401);

    const postAuth = await fetch(`http://127.0.0.1:${port}/v1/reservations/900001/guests`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ guests: [{ name: "Sintetico" }] }),
    });
    assert.equal(postAuth.status, 403);
    const postAuthBody = await postAuth.text();
    assert.equal(postAuthBody.includes(TOKEN), false);
    assert.match(postAuthBody, /guest_write_disabled/);

    const putAuth = await fetch(`http://127.0.0.1:${port}/v1/guests`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ idEntity: 1, idReservation: 900001, name: "Sintetico" }),
    });
    assert.equal(putAuth.status, 403);
    assert.match(await putAuth.text(), /guest_write_disabled/);

    assert.equal(stderr.includes(TOKEN), false);
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3_000);
      child.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
});

test("artefato dist recusa GATEWAY_TOKEN curto e não o imprime", async () => {
  assert.equal(existsSync(distFile), true, "rode npm run build antes deste smoke");
  const short = "short-token-value-not-32";
  const child = spawn(process.execPath, [distFile], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: "3999",
      GATEWAY_TOKEN: short,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (buf: Buffer) => {
    stderr += buf.toString("utf8");
  });

  const code = await new Promise<number | null>((resolve) => {
    child.on("exit", (c) => resolve(c));
  });
  assert.equal(code, 1);
  assert.match(stderr, /GATEWAY_TOKEN/);
  assert.equal(stderr.includes(short), false);
});
