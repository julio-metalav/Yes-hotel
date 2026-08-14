import ExcelJS from "exceljs";

export async function buildSyntheticOmieArApXlsx(input?: {
  rows?: Array<{
    name?: string;
    date: string;
    ar?: { gross: number; tax?: number; settled?: number; open?: number };
    ap?: { gross: number; tax?: number; settled?: number; open?: number };
  }>;
  omitHeaders?: boolean;
  extraTotal?: boolean;
}): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Contas por Cliente ou Forne");
  if (!input?.omitHeaders) {
    ws.mergeCells("A1:J1");
    ws.getCell("A1").value = "Contas por Cliente ou Fornecedor";
    ws.getCell("C2").value = "Tipo";
    ws.getCell("C3").value = "1. Contas a Receber";
    ws.getCell("G3").value = "2. Contas a Pagar";
    ws.getCell("K3").value = "Totais";
    const headers = [
      "Cliente ou Fornecedor (Nome Fantasia)",
      "Data de Pagto ou Recbto (completa)",
      "Soma de Valor da Conta",
      "Soma de Impostos Retidos",
      "Soma de Pago ou Recebido",
      "Soma de A Pagar ou Receber",
      "Soma de Valor da Conta",
      "Soma de Impostos Retidos",
      "Soma de Pago ou Recebido",
      "Soma de A Pagar ou Receber",
      "Valor da Conta",
      "Impostos Retidos",
      "Pago ou Recebido",
      "A Pagar ou Receber",
    ];
    headers.forEach((h, i) => {
      ws.getCell(4, i + 1).value = h;
    });
  }

  const rows = input?.rows ?? [
    { name: "CLIENTE SINTETICO", date: "15/01/2026", ar: { gross: 100.5, tax: 0, settled: 100.5, open: 0 } },
    { name: "FORNECEDOR SINTETICO", date: "16/01/2026", ap: { gross: -40, tax: 0, settled: -40, open: 0 } },
  ];

  let r = 5;
  let arG = 0;
  let arT = 0;
  let arS = 0;
  let arO = 0;
  let apG = 0;
  let apT = 0;
  let apS = 0;
  let apO = 0;
  for (const row of rows) {
    if (row.name) ws.getCell(r, 1).value = row.name;
    ws.getCell(r, 2).value = row.date;
    if (row.ar) {
      ws.getCell(r, 3).value = row.ar.gross;
      ws.getCell(r, 4).value = row.ar.tax ?? 0;
      ws.getCell(r, 5).value = row.ar.settled ?? 0;
      ws.getCell(r, 6).value = row.ar.open ?? 0;
      arG += row.ar.gross;
      arT += row.ar.tax ?? 0;
      arS += row.ar.settled ?? 0;
      arO += row.ar.open ?? 0;
    }
    if (row.ap) {
      ws.getCell(r, 7).value = row.ap.gross;
      ws.getCell(r, 8).value = row.ap.tax ?? 0;
      ws.getCell(r, 9).value = row.ap.settled ?? 0;
      ws.getCell(r, 10).value = row.ap.open ?? 0;
      apG += row.ap.gross;
      apT += row.ap.tax ?? 0;
      apS += row.ap.settled ?? 0;
      apO += row.ap.open ?? 0;
    }
    ws.getCell(r, 11).value = (row.ar?.gross ?? 0) + (row.ap?.gross ?? 0);
    r += 1;
  }
  ws.getCell(r, 1).value = "Total geral";
  ws.getCell(r, 3).value = arG;
  ws.getCell(r, 4).value = arT;
  ws.getCell(r, 5).value = arS;
  ws.getCell(r, 6).value = arO;
  ws.getCell(r, 7).value = apG;
  ws.getCell(r, 8).value = apT;
  ws.getCell(r, 9).value = apS;
  ws.getCell(r, 10).value = apO;
  if (input?.extraTotal) {
    r += 1;
    ws.getCell(r, 1).value = "Total geral";
    ws.getCell(r, 3).value = 1;
  }

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf);
}
