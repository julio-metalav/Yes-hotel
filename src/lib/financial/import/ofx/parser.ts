/**
 * Parser OFX 1.x SGML / OFX 2 XML — somente leitura estrutural.
 * Não interpreta valores/datas aqui.
 */

import { accountIdLast4 } from "./account.ts";
import type { OfxBalance, OfxBankAccount, OfxDocument, OfxStmtTrn } from "./types.ts";

function stripHeader(text: string): string {
  const start = text.search(/<OFX[\s>]/i);
  if (start >= 0) return text.slice(start);
  const alt = text.search(/<OFX>/i);
  return alt >= 0 ? text.slice(alt) : text;
}

export function extractOfxTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([^\\n<]*)`, "i");
  const match = block.match(re);
  if (!match) return null;
  const value = match[1]!.replace(/<\/[^>]+>$/, "").replace(/\r/g, "").trim();
  return value.length ? value : null;
}

export function extractOfxBlocks(text: string, tag: string): string[] {
  const upper = text;
  const open = new RegExp(`<${tag}>`, "gi");
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = open.exec(upper))) starts.push(m.index);
  if (starts.length === 0) return [];

  const closeRe = new RegExp(`</${tag}>`, "i");
  const blocks: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!;
    const rest = upper.slice(from);
    const close = rest.search(closeRe);
    const next = starts[i + 1] != null ? starts[i + 1]! - from : rest.length;
    const end = close >= 0 && close < next ? close : next;
    blocks.push(rest.slice(0, end));
  }
  return blocks;
}

function parseBalance(block: string | null): OfxBalance | null {
  if (!block) return null;
  return {
    amountCents: null,
    asOfDate: extractOfxTag(block, "DTASOF"),
    rawAmount: extractOfxTag(block, "BALAMT"),
  };
}

function parseAccount(block: string): OfxBankAccount {
  const acctId = extractOfxTag(block, "ACCTID");
  return {
    bankId: extractOfxTag(block, "BANKID"),
    branchId: extractOfxTag(block, "BRANCHID"),
    acctId,
    acctType: extractOfxTag(block, "ACCTTYPE"),
    acctIdLast4: accountIdLast4(acctId),
  };
}

function parseStmtTrn(block: string, sourceRow: number): OfxStmtTrn {
  return {
    sourceRow,
    trntype: extractOfxTag(block, "TRNTYPE"),
    dtposted: extractOfxTag(block, "DTPOSTED"),
    dtuser: extractOfxTag(block, "DTUSER"),
    trnamt: extractOfxTag(block, "TRNAMT"),
    fitid: extractOfxTag(block, "FITID"),
    checknum: extractOfxTag(block, "CHECKNUM"),
    refnum: extractOfxTag(block, "REFNUM"),
    name: extractOfxTag(block, "NAME"),
    memo: extractOfxTag(block, "MEMO"),
  };
}

export function decodeOfxBytes(bytes: Uint8Array): string {
  const header = new TextDecoder("ascii", { fatal: false }).decode(bytes.slice(0, 800));
  const charset = header.match(/CHARSET\s*:\s*(\d+)/i)?.[1] ?? "";
  const encoding = header.match(/ENCODING\s*:\s*([A-Za-z0-9-]+)/i)?.[1] ?? "";
  if (charset === "1252" || /1252|WINDOWS-1252/i.test(encoding)) {
    return new TextDecoder("windows-1252").decode(bytes);
  }
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const replacementCount = (utf8.match(/\uFFFD/g) ?? []).length;
  if (replacementCount > 0 && replacementCount / Math.max(bytes.length, 1) > 0.01) {
    return new TextDecoder("windows-1252").decode(bytes);
  }
  return utf8;
}

export function parseOfxDocument(text: string):
  | { ok: true; document: OfxDocument }
  | { ok: false; reason: "malformed_ofx" | "empty_banktranlist"; message: string } {
  const body = stripHeader(String(text ?? "").replace(/^\uFEFF/, ""));
  if (!/<OFX[\s>]/i.test(body) && !/<OFX>/i.test(body)) {
    return { ok: false, reason: "malformed_ofx", message: "arquivo sem raiz OFX" };
  }

  const acctBlock = extractOfxBlocks(body, "BANKACCTFROM")[0] ?? body;
  const listBlock = extractOfxBlocks(body, "BANKTRANLIST")[0];
  if (!listBlock) {
    return { ok: false, reason: "empty_banktranlist", message: "BANKTRANLIST ausente" };
  }

  const trnBlocks = extractOfxBlocks(listBlock, "STMTTRN");
  if (trnBlocks.length === 0) {
    return { ok: false, reason: "empty_banktranlist", message: "BANKTRANLIST sem STMTTRN" };
  }

  const ledgerBlock = extractOfxBlocks(body, "LEDGERBAL")[0] ?? null;
  const availBlock = extractOfxBlocks(body, "AVAILBAL")[0] ?? null;

  return {
    ok: true,
    document: {
      currency: extractOfxTag(body, "CURDEF"),
      periodStartRaw: extractOfxTag(listBlock, "DTSTART"),
      periodEndRaw: extractOfxTag(listBlock, "DTEND"),
      account: parseAccount(acctBlock),
      transactions: trnBlocks.map((block, i) => parseStmtTrn(block, i + 1)),
      ledgerBal: parseBalance(ledgerBlock),
      availBal: parseBalance(availBlock),
    },
  };
}
