import { createHash } from "node:crypto";
import { OFX_PARSER_VERSION } from "./types.ts";

export function sha256HexOfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function maskSha256(hex: string): string {
  const h = String(hex ?? "").toLowerCase();
  if (h.length < 16) return "(hash-curto)";
  return `${h.slice(0, 8)}…${h.slice(-8)}`;
}

export function normalizeOfxText(raw: string | null | undefined): string {
  return String(raw ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Hash canônico de correlação — NÃO é chave de unicidade.
 * Duas transações bancárias legítimas iguais no mesmo dia podem ter o mesmo hash
 * e devem coexistir via (source_import_id, source_row).
 */
export function ofxNormalizedHash(input: {
  sourceSystem: string;
  accountCode: string;
  settlementDate: string;
  amountCents: number;
  direction: string;
  description: string;
  externalReference: string | null;
}): string {
  const canonical = [
    String(input.sourceSystem).trim().toLowerCase(),
    String(input.accountCode).trim().toLowerCase(),
    String(input.settlementDate).trim(),
    String(input.amountCents),
    String(input.direction).trim().toLowerCase(),
    normalizeOfxText(input.description).toLowerCase(),
    normalizeOfxText(input.externalReference).toLowerCase(),
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

export function ofxParserIdentity(): { parser_name: string; parser_version: string } {
  return { parser_name: "ofx_sicredi", parser_version: OFX_PARSER_VERSION };
}
