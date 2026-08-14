/** Parser de moeda brasileira dos relatórios HITS/Omnibees. */

export function parseBrlToCents(raw: string): number {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("valor BRL vazio");
  const negative = text.includes("-");
  const cleaned = text
    .replace(/BRL/gi, "")
    .replace(/[R$\s]/g, "")
    .replace(/-/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) {
    throw new Error(`valor BRL inválido: ${raw}`);
  }
  const cents = Math.round(Number(cleaned) * 100);
  if (!Number.isFinite(cents)) throw new Error(`valor BRL inválido: ${raw}`);
  return negative ? -cents : cents;
}
