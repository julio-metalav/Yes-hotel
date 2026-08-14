export { OFX_PARSER_NAME, OFX_PARSER_VERSION, SICREDI_BANK_IDS } from "./types.ts";
export type {
  AccountResolutionMethod,
  OfxAccountHint,
  OfxBankAccount,
  OfxDocument,
  OfxDryRunStats,
  OfxFatalCode,
  OfxImportFatal,
  OfxImportOk,
  OfxImportResult,
  OfxNormalizedEntry,
  OfxRowError,
  OfxRowErrorCode,
  OfxStmtTrn,
} from "./types.ts";

export { accountIdLast4, maskAccountId, resolveOfxAccount } from "./account.ts";
export { OFX_DEFAULT_TIMEZONE, parseOfxDateTime } from "./dates.ts";
export {
  maskSha256,
  normalizeOfxText,
  ofxNormalizedHash,
  ofxParserIdentity,
  sha256HexOfBytes,
} from "./hash.ts";
export { parseOfxAmountToSignedCents, signedCentsToDirection } from "./money.ts";
export { DEFAULT_SICREDI_ACCOUNT_HINTS, normalizeOfxImport } from "./normalize.ts";
export { decodeOfxBytes, extractOfxBlocks, extractOfxTag, parseOfxDocument } from "./parser.ts";
export {
  buildDryRunReport,
  dryRunReportLeaksPii,
  formatCents,
  formatDryRunReport,
  type OfxDryRunReport,
} from "./report.ts";
