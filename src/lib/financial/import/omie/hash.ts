import { createHash } from "node:crypto";
import { OMIE_AR_AP_PARSER_VERSION } from "./ar-ap-types.ts";

export function sha256HexOfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function maskSha256(hex: string): string {
  const h = String(hex ?? "").toLowerCase();
  if (h.length < 16) return "(hash-curto)";
  return `${h.slice(0, 8)}…${h.slice(-8)}`;
}

export function normalizeOmieText(raw: string | null | undefined): string {
  return String(raw ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Hash canônico de correlação. NÃO é chave de unicidade.
 * Dois títulos/agregados iguais no mesmo dia convivem via (source_import_id, source_row).
 */
export function omieArApNormalizedHash(input: {
  side: string;
  personName: string;
  settlementDate: string;
  grossCents: number;
  settledCents: number;
  openCents: number;
  taxCents: number;
}): string {
  const canonical = [
    "omie",
    input.side,
    normalizeOmieText(input.personName).toLowerCase(),
    input.settlementDate,
    String(input.grossCents),
    String(input.settledCents),
    String(input.openCents),
    String(input.taxCents),
    OMIE_AR_AP_PARSER_VERSION,
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}
