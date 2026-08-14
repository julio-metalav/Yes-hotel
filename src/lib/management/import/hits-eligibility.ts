/** Elegibilidade HITS para métricas de hospedagem. */

export type HitsNightRow = {
  auditDate: string;
  op: string;
  tipo: string;
  diaria: string;
  ab: string;
  diariaAb: string;
  guestRaw: string;
  stayIn: string | null;
  stayOut: string | null;
  accountOrigin: string | null;
};

export function isEligibleLodgingNight(row: Pick<HitsNightRow, "tipo" | "op">): boolean {
  return row.tipo === "Regular" && row.op === "L";
}

export function isExcludedHitsTipo(tipo: string): boolean {
  return tipo === "Early ck-in" || tipo === "Late ck-out" || tipo === "No show" || tipo === "Cortesia";
}
