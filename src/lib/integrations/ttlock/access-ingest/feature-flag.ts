import { ENV_TTLOCK_ACCESS_INGEST_ENABLED } from "./constants";

/** Ativo somente quando o valor é exatamente "true" (case-sensitive). */
export function isTtlockAccessIngestEnabled(
  env: Record<string, string | undefined> = typeof process !== "undefined"
    ? (process.env as Record<string, string | undefined>)
    : {},
): boolean {
  return env[ENV_TTLOCK_ACCESS_INGEST_ENABLED] === "true";
}
