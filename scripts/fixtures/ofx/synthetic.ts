/**
 * Fixtures OFX 100% sintéticas. Sem PII real, sem contas reais.
 */

export type SyntheticTrn = {
  trntype?: string;
  dtposted: string;
  dtuser?: string;
  trnamt: string;
  fitid?: string;
  checknum?: string;
  refnum?: string;
  name?: string;
  memo?: string;
};

export function buildSyntheticOfx(input: {
  bankId?: string;
  branchId?: string;
  acctId?: string;
  acctType?: string;
  currency?: string;
  dtStart?: string;
  dtEnd?: string;
  ledgerAmt?: string;
  ledgerAsOf?: string;
  transactions: SyntheticTrn[];
  omitBankTranList?: boolean;
  omitOfxRoot?: boolean;
}): string {
  const header = [
    "OFXHEADER:100",
    "DATA:OFXSGML",
    "VERSION:102",
    "SECURITY:NONE",
    "ENCODING:USASCII",
    "CHARSET:1252",
    "COMPRESSION:NONE",
    "OLDFILEUID:NONE",
    "NEWFILEUID:NONE",
    "",
  ].join("\n");

  if (input.omitOfxRoot) return `${header}<NOTOFX>\n`;

  const trns = input.transactions
    .map((t) => {
      const lines = ["<STMTTRN>", `<TRNTYPE>${t.trntype ?? "OTHER"}`, `<DTPOSTED>${t.dtposted}`, `<TRNAMT>${t.trnamt}`];
      if (t.dtuser) lines.push(`<DTUSER>${t.dtuser}`);
      if (t.fitid) lines.push(`<FITID>${t.fitid}`);
      if (t.checknum) lines.push(`<CHECKNUM>${t.checknum}`);
      if (t.refnum) lines.push(`<REFNUM>${t.refnum}`);
      if (t.name) lines.push(`<NAME>${t.name}`);
      if (t.memo) lines.push(`<MEMO>${t.memo}`);
      lines.push("</STMTTRN>");
      return lines.join("\n");
    })
    .join("\n");

  const list = input.omitBankTranList
    ? ""
    : `<BANKTRANLIST>
<DTSTART>${input.dtStart ?? "20260101"}
<DTEND>${input.dtEnd ?? "20260131"}
${trns}
</BANKTRANLIST>`;

  return `${header}<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<CURDEF>${input.currency ?? "BRL"}
<BANKACCTFROM>
<BANKID>${input.bankId ?? "748"}
<BRANCHID>${input.branchId ?? "0001"}
<ACCTID>${input.acctId ?? "00004321"}
<ACCTTYPE>${input.acctType ?? "CHECKING"}
</BANKACCTFROM>
${list}
<LEDGERBAL>
<BALAMT>${input.ledgerAmt ?? "1000.00"}
<DTASOF>${input.ledgerAsOf ?? "20260131120000"}
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;
}

export const SYNTHETIC_PRINCIPAL_OK = buildSyntheticOfx({
  acctId: "00004321",
  transactions: [
    {
      trntype: "CREDIT",
      dtposted: "20260115123000[-3:BRT]",
      trnamt: "1234.56",
      fitid: "FIT-CRED-1",
      name: "FORNECEDOR SINTETICO",
      memo: "CREDITO TESTE",
      refnum: "REF-1",
    },
    {
      trntype: "DEBIT",
      dtposted: "20260116",
      trnamt: "-10.00",
      fitid: "FIT-DEB-1",
      name: "TARIFA SINTETICA",
      memo: "DEBITO TESTE",
    },
  ],
});

export const SYNTHETIC_0911_OK = buildSyntheticOfx({
  acctId: "00000911",
  transactions: [
    {
      trntype: "CREDIT",
      dtposted: "20260201120000",
      trnamt: "50.00",
      fitid: "FIT-0911-1",
      name: "TRANSFERENCIA SINTETICA",
    },
  ],
});
