/**
 * Calendário operacional Yes Hotel — feriados aplicáveis a Corumbá/MS.
 * Sem I/O. Usado pela regra de pagamento presencial diferido.
 *
 * Fontes:
 * - Nacionais (fixos + móveis via Páscoa): calendário civil brasileiro.
 * - Estadual MS: Criação do Estado = 11/OUT (Governo de MS) — NÃO 11/jul.
 * - Municipais Corumbá: Lei Municipal nº 2.986/2025
 *   (02/02, Sexta da Paixão, Corpus Christi, 13/06, 24/06, 21/09).
 *
 * Pontos facultativos (ex.: Carnaval seg/ter) NÃO são tratados como feriado
 * nesta feature — limiar permanece 19:00 em dia útil.
 */

/** Algoritmo anônimo gregoriano → domingo de Páscoa (YMD civil). */
export function easterSundayYmd(year: number): string {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 1900 || y > 2200) {
    throw new Error(`Ano inválido para Páscoa: ${year}`);
  }
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDaysYmd(ymd: string, deltaDays: number): string {
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`YMD inválido: ${ymd}`);
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + deltaDays);
  const d = new Date(utc);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export type HolidayKind = "nacional" | "estadual_ms" | "municipal_corumba";

export type HolidayEntry = {
  ymd: string;
  name: string;
  kind: HolidayKind;
};

/** Feriados fixos (MM-DD) aplicáveis a Corumbá/MS. */
const FIXED: Array<{ md: string; name: string; kind: HolidayKind }> = [
  { md: "01-01", name: "Confraternização Universal", kind: "nacional" },
  { md: "02-02", name: "Nossa Senhora da Candelária", kind: "municipal_corumba" },
  { md: "04-21", name: "Tiradentes", kind: "nacional" },
  { md: "05-01", name: "Dia do Trabalho", kind: "nacional" },
  { md: "06-13", name: "Retomada de Corumbá", kind: "municipal_corumba" },
  { md: "06-24", name: "São João", kind: "municipal_corumba" },
  { md: "09-07", name: "Independência do Brasil", kind: "nacional" },
  { md: "09-21", name: "Fundação de Corumbá", kind: "municipal_corumba" },
  { md: "10-11", name: "Criação do Estado de Mato Grosso do Sul", kind: "estadual_ms" },
  { md: "10-12", name: "Nossa Senhora Aparecida", kind: "nacional" },
  { md: "11-02", name: "Finados", kind: "nacional" },
  { md: "11-15", name: "Proclamação da República", kind: "nacional" },
  { md: "11-20", name: "Consciência Negra", kind: "nacional" },
  { md: "12-25", name: "Natal", kind: "nacional" },
];

export function listHolidaysForYear(year: number): HolidayEntry[] {
  const y = Number(year);
  const out: HolidayEntry[] = FIXED.map((f) => ({
    ymd: `${y}-${f.md}`,
    name: f.name,
    kind: f.kind,
  }));
  const easter = easterSundayYmd(y);
  // Móveis: Sexta-feira da Paixão e Corpus Christi (nacionais e Lei 2.986/2025 Corumbá).
  // Carnaval (seg/ter) = ponto facultativo — NÃO incluir como feriado nesta regra.
  out.push(
    {
      ymd: addDaysYmd(easter, -2),
      name: "Sexta-feira da Paixão",
      kind: "nacional",
    },
    {
      ymd: addDaysYmd(easter, 60),
      name: "Corpus Christi",
      kind: "nacional",
    },
  );
  out.sort((a, b) => a.ymd.localeCompare(b.ymd));
  return out;
}

export function isCorumbaApplicableHoliday(ymd: string): boolean {
  const m = String(ymd).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const year = Number(m[1]);
  return listHolidaysForYear(year).some((h) => h.ymd === `${m[1]}-${m[2]}-${m[3]}`);
}

/** YMD de Carnaval segunda/terça (ponto facultativo — não feriado nesta feature). */
export function carnivalMondayTuesdayYmd(year: number): { monday: string; tuesday: string } {
  const easter = easterSundayYmd(year);
  return {
    monday: addDaysYmd(easter, -48),
    tuesday: addDaysYmd(easter, -47),
  };
}
