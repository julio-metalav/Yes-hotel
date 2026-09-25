/**
 * Homologação de `rooms[].mealPlanDesc` do HITS → plano de café.
 *
 * A lista abaixo é FECHADA e vem de observação real no HITS de produção
 * (leitura somente GET, 83 reservas amostradas em janela de ±45 dias,
 * 25/09/2026): apenas dois valores existem hoje —
 *
 *   "Café da Manhã"  → 79 ocorrências  → café incluído
 *   "Nenhum"         →  4 ocorrências  → sem café (declaração explícita)
 *
 * Nenhum nulo e nenhuma string vazia foram observados.
 *
 * Regras deliberadas:
 * - NÃO existe heurística por substring ("contém cafe" → incluído). Um plano
 *   novo como "Meia pensão" ou "Café + almoço" cairia nela por engano.
 * - Valor desconhecido, nulo ou vazio → `nao_mapeado`, que a tela mostra como
 *   NÃO IDENTIFICADO. Ausência de informação nunca vira "sem café".
 * - A comparação normaliza só o que é seguro: espaços, caixa e acento. O texto
 *   bruto continua preservado em `meal_plan_desc` para auditoria.
 *
 * Espelhos desta tabela (precisam andar juntos): `ui/yes-cafe-policy.js` e a
 * função SQL `public.operacional_cafe_resolve_entitlement`.
 */

export type CafeMealPlanKind = "incluido" | "sem_cafe" | "nao_mapeado";

/** trim + minúsculas + sem acento + espaços colapsados. Só para COMPARAR. */
export function normalizeMealPlanDesc(raw: unknown): string {
  return String(raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Lista fechada, por valor normalizado. Só entra aqui o que foi observado. */
export const CAFE_MEAL_PLAN_HOMOLOGADO: ReadonlyArray<{
  normalizado: string;
  exemploBruto: string;
  kind: Exclude<CafeMealPlanKind, "nao_mapeado">;
}> = [
  { normalizado: "cafe da manha", exemploBruto: "Café da Manhã", kind: "incluido" },
  { normalizado: "nenhum", exemploBruto: "Nenhum", kind: "sem_cafe" },
];

const POR_NORMALIZADO = new Map(
  CAFE_MEAL_PLAN_HOMOLOGADO.map((v) => [v.normalizado, v.kind] as const),
);

/**
 * Classifica o texto bruto do HITS. Fora da lista homologada (inclusive nulo e
 * vazio) o resultado é `nao_mapeado` — nunca `sem_cafe` por omissão.
 */
export function classifyMealPlanDesc(raw: unknown): CafeMealPlanKind {
  const chave = normalizeMealPlanDesc(raw);
  if (!chave) return "nao_mapeado";
  return POR_NORMALIZADO.get(chave) ?? "nao_mapeado";
}
