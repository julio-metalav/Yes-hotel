/**
 * Bundle de produção: código do gateway + HitsClient interno.
 * Dependências npm (fastify, helmet, rate-limit) ficam externas (npm ci --omit=dev).
 * Sem sourcemap. Sem secrets.
 */
import * as esbuild from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serviceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const result = await esbuild.build({
  absWorkingDir: serviceRoot,
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/server.js",
  packages: "external",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  logLevel: "info",
  metafile: true,
});

const inputs = Object.keys(result.metafile?.inputs ?? {});
const leakedRepoSrc = inputs.filter(
  (p) => p.includes("src/lib/") && !p.includes("integrations/hits") && !p.includes("constant-time"),
);
if (leakedRepoSrc.length > 0) {
  console.error("[build] bundle puxou módulos inesperados do repo:", leakedRepoSrc);
  process.exit(1);
}

console.log("[build] wrote dist/server.js (sem sourcemap)");
