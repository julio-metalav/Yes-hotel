/**
 * Contato do hóspede vindo do HITS — preferência por CELULAR.
 *
 * O GET de detalhe/hóspede do HITS não expõe tipo de contato (só
 * `contactPhone`/`contactMail`; `contact1`/`contact2` na reserva). Sem tipo
 * explícito, a única forma de preferir o celular quando há MAIS DE UM telefone
 * disponível é o formato brasileiro: DDD + 9 dígitos começando por 9 = celular;
 * DDD + 8 dígitos começando por 2–5 = fixo. Nada além disso é inferido:
 * número que não bate com nenhum dos dois é "desconhecido" e nunca é tratado
 * como celular. Com um único telefone o comportamento é o de sempre (usa o que
 * veio). Sem heurística internacional.
 *
 * Nenhuma rede, nenhum envio: funções puras usadas pelo normalizador e pela
 * materialização.
 */

export type TelefoneTipoBr = "celular" | "fixo" | "desconhecido";

/** Só dígitos, sem +55 (12–13 dígitos) e sem 0 de operadora/tronco (11–12). */
export function digitosTelefoneBr(raw: unknown): string {
  let d = String(raw ?? "").replace(/\D/g, "");
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  if ((d.length === 11 || d.length === 12) && d.startsWith("0")) d = d.slice(1);
  return d;
}

export function classificarTelefoneBr(raw: unknown): TelefoneTipoBr {
  const d = digitosTelefoneBr(raw);
  if (d.length === 11 && /^[1-9][0-9]9[0-9]{8}$/.test(d)) return "celular";
  if (d.length === 10 && /^[1-9][0-9][2-5][0-9]{7}$/.test(d)) return "fixo";
  return "desconhecido";
}

/**
 * Um campo do HITS pode trazer mais de um número ("(67) 3321-0000 / 99999-0000").
 * Separa por / ; | , e "ou", preservando o texto original de cada número.
 */
export function separarTelefones(raw: unknown): string[] {
  return String(raw ?? "")
    .split(/\s*(?:\/|;|\||,|\bou\b)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Escolhe o telefone operacional entre os candidatos (na ordem recebida):
 * 1) primeiro celular; 2) senão, primeiro fixo; 3) senão, primeiro não vazio
 * (formato desconhecido — mantido como veio); 4) senão null.
 * Devolve o texto original do número escolhido, sem reformatar.
 */
export function escolherTelefonePreferido(candidatos: ReadonlyArray<unknown>): string | null {
  const tokens = candidatos.flatMap((c) => separarTelefones(c));
  if (tokens.length === 0) return null;
  const vistos = new Set<string>();
  const unicos = tokens.filter((t) => {
    const k = digitosTelefoneBr(t) || t.toLowerCase();
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
  return (
    unicos.find((t) => classificarTelefoneBr(t) === "celular") ??
    unicos.find((t) => classificarTelefoneBr(t) === "fixo") ??
    unicos[0] ??
    null
  );
}

function mesmoTelefone(a: unknown, b: unknown): boolean {
  const da = digitosTelefoneBr(a);
  const db = digitosTelefoneBr(b);
  return da.length > 0 && da === db;
}

/**
 * WhatsApp de hóspede JÁ materializado: devolve o novo valor ou null (no-op).
 * - local vazio + HITS tem telefone → preenche;
 * - local é fixo + HITS tem celular → troca pelo celular;
 * - local é celular → nunca rebaixa (nem para outro fixo, nem para desconhecido);
 * - mesmo número → no-op;
 * - local de formato desconhecido (não vazio) → não mexe (pode ser edição manual
 *   ou número estrangeiro; sem campo de origem no schema, é conservador).
 */
export function decidirWhatsappExistente(local: unknown, hits: unknown): string | null {
  const atual = String(local ?? "").trim();
  const novo = String(hits ?? "").trim();
  if (!novo) return null;
  if (!atual) return novo;
  if (mesmoTelefone(atual, novo)) return null;
  const tipoAtual = classificarTelefoneBr(atual);
  const tipoNovo = classificarTelefoneBr(novo);
  if (tipoAtual === "fixo" && tipoNovo === "celular") return novo;
  return null;
}

/**
 * E-mail de hóspede JÁ materializado: só preenche quando o local está vazio e o
 * HITS traz um e-mail plausível; e-mail diferente já existente não é trocado.
 */
export function decidirEmailExistente(local: unknown, hits: unknown): string | null {
  const atual = String(local ?? "").trim();
  const novo = String(hits ?? "").trim();
  if (!novo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(novo)) return null;
  if (!atual) return novo;
  return null;
}
