/**
 * Gera ui/yes-supabase-config.js a partir do ambiente de build.
 *
 * Preview (VERCEL_ENV=preview) exige YES_HOTEL_SUPABASE_URL + YES_HOTEL_SUPABASE_ANON_KEY
 * de um project_ref diferente de produção e falha fechado se faltar ou apontar ao main.
 * Production usa o ref de produção; local reutiliza o default de produção.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCTION_REF = "minmmecajnmjqlgacfoz";
export const PRODUCTION_HOST = "yes-hotel.vercel.app";
export const PRODUCTION_URL = `https://${PRODUCTION_REF}.supabase.co`;
export const PRODUCTION_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1pbm1tZWNham5tanFsZ2FjZm96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxOTc1OTUsImV4cCI6MjA4ODc3MzU5NX0.zyrDRTlU-yUKINegXDDsTlww4pPcAGIDn6hLq-FFA84";

export function extractProjectRef(url) {
  const match = String(url || "").trim().match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i);
  return match ? match[1].toLowerCase() : "";
}

export function jwtRole(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) {
    return "";
  }
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(json);
    return typeof payload.role === "string" ? payload.role : "";
  } catch {
    return "";
  }
}

export function assertHostnameIsolation({ hostname, projectRef }) {
  const host = String(hostname || "");
  const ref = String(projectRef || "").toLowerCase();
  const isProdHost = host === PRODUCTION_HOST;
  const isVercelPreview = /\.vercel\.app$/i.test(host) && !isProdHost;
  if (isVercelPreview && ref === PRODUCTION_REF) {
    throw new Error("Preview isolado recusou o project_ref de producao.");
  }
  if (isProdHost && ref && ref !== PRODUCTION_REF) {
    throw new Error("Producao recusou o project_ref de homologacao.");
  }
}

export function resolveYesHotelSupabaseEnv(env = process.env) {
  const vercelEnv = String(env.VERCEL_ENV || env.YES_HOTEL_DEPLOY_TARGET || "local").toLowerCase();
  const url = String(env.YES_HOTEL_SUPABASE_URL || "").trim();
  const anonKey = String(env.YES_HOTEL_SUPABASE_ANON_KEY || "").trim();

  if (vercelEnv === "preview") {
    if (!url || !anonKey) {
      throw new Error(
        "Preview isolado exige YES_HOTEL_SUPABASE_URL e YES_HOTEL_SUPABASE_ANON_KEY.",
      );
    }
    const ref = extractProjectRef(url);
    if (!ref) {
      throw new Error("YES_HOTEL_SUPABASE_URL do Preview e invalida.");
    }
    if (ref === PRODUCTION_REF) {
      throw new Error("Preview isolado recusou o project_ref de producao.");
    }
    if (jwtRole(anonKey) === "service_role") {
      throw new Error("service_role nao pode ir para o frontend.");
    }
    return { url, anonKey, target: "preview", ref };
  }

  if (vercelEnv === "production") {
    const finalUrl = url || PRODUCTION_URL;
    const finalKey = anonKey || PRODUCTION_ANON_KEY;
    const ref = extractProjectRef(finalUrl);
    if (ref !== PRODUCTION_REF) {
      throw new Error("Producao recusou o project_ref de homologacao.");
    }
    if (jwtRole(finalKey) === "service_role") {
      throw new Error("service_role nao pode ir para o frontend.");
    }
    return { url: finalUrl, anonKey: finalKey, target: "production", ref };
  }

  return {
    url: PRODUCTION_URL,
    anonKey: PRODUCTION_ANON_KEY,
    target: "local",
    ref: PRODUCTION_REF,
  };
}

export function renderYesHotelSupabaseConfig(resolved) {
  return `// Gerado por scripts/generate-yes-supabase-config.mjs.
// Nao colocar service_role neste arquivo. Preview x Production e definido no build.
window.YES_HOTEL_SUPABASE_CONFIG = {
  url: ${JSON.stringify(resolved.url)},
  anonKey: ${JSON.stringify(resolved.anonKey)},
  appSessionHours: 4,
  pagarmeUiEnabled: true,
  pagamentoPresencialDiferidoUiEnabled: true,
};
window.YES_HOTEL_SUPABASE_TARGET = ${JSON.stringify(resolved.target)};
(function isolateYesHotelSupabase(global) {
  var PRODUCTION_REF = ${JSON.stringify(PRODUCTION_REF)};
  var PRODUCTION_HOST = ${JSON.stringify(PRODUCTION_HOST)};
  var cfg = global.YES_HOTEL_SUPABASE_CONFIG;
  if (!cfg || !cfg.url) {
    return;
  }
  function projectRef(url) {
    var match = String(url).match(/^https:\\/\\/([a-z0-9]+)\\.supabase\\.co/i);
    return match ? match[1].toLowerCase() : "";
  }
  function fail(message) {
    cfg.url = "";
    cfg.anonKey = "";
    throw new Error(message);
  }
  var ref = projectRef(cfg.url);
  var host = (global.location && global.location.hostname) || "";
  var isProdHost = host === PRODUCTION_HOST;
  var isVercelPreview = /\\.vercel\\.app$/i.test(host) && !isProdHost;
  if (isVercelPreview && ref === PRODUCTION_REF) {
    fail("Preview isolado recusou o project_ref de producao.");
  }
  if (isProdHost && ref && ref !== PRODUCTION_REF) {
    fail("Producao recusou o project_ref de homologacao.");
  }
  if (String(cfg.anonKey || "").indexOf("service_role") !== -1) {
    fail("service_role nao e permitida no frontend.");
  }
})(window);
`;
}

export function writeYesHotelSupabaseConfig(env = process.env) {
  const resolved = resolveYesHotelSupabaseEnv(env);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const out = path.join(root, "ui", "yes-supabase-config.js");
  fs.writeFileSync(out, renderYesHotelSupabaseConfig(resolved), "utf8");
  return { out, ...resolved };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (!process.argv.includes("--write")) {
    resolveYesHotelSupabaseEnv(process.env);
    process.stdout.write("ok\n");
  } else {
    const result = writeYesHotelSupabaseConfig(process.env);
    process.stdout.write(`${result.target}:${result.ref}\n`);
  }
}
