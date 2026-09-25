/**
 * Mensagens automaticas com texto editavel.
 *
 * Principio que nao se negocia: o TEXTO e configuravel, a REGRA de disparo
 * continua no codigo. Editar o texto em Configuracoes nao pode mudar quando a
 * mensagem sai, para quem sai, nem quantas vezes sai.
 *
 * Um template unico por mensagem. O WhatsApp recebe o texto renderizado; o
 * e-mail recebe HTML gerado desse MESMO texto. Dois templates separados
 * divergiriam com o tempo, e o hospede receberia versoes diferentes da mesma
 * informacao pelos dois canais.
 *
 * Parametro ausente nao vira buraco no texto. Substituir por vazio produziria
 * o resultado abaixo, que e pior que nao mandar o bloco:
 *
 *     Wi-Fi:
 *     Rede:
 *     Senha:
 *
 * Por isso a linha que depende de um parametro ausente e REMOVIDA, e um
 * cabecalho que perde todas as linhas dele some junto. Sem sintaxe de
 * condicional, sem linguagem de template: a regra e "linha sem o dado sai".
 *
 * Sem I/O.
 */

/** Parametros aceitos. Lista fechada: o que nao esta aqui nao e resolvido. */
export const PARAMETROS_SUPORTADOS = [
  "hospede_nome",
  "apartamento",
  "wifi_rede",
  "wifi_senha",
  "checkout_horario",
  "telefone_recepcao",
  "data_entrada",
  "data_saida",
] as const;

export type ParametroMensagem = (typeof PARAMETROS_SUPORTADOS)[number];

export type ValoresParametros = Partial<Record<ParametroMensagem, string | null | undefined>>;

/** Chave do template. Lista fechada: gatilho novo exige codigo novo. */
export const TEMPLATES_CONHECIDOS = ["boas_vindas_primeiro_acesso"] as const;
export type ChaveTemplate = (typeof TEMPLATES_CONHECIDOS)[number];

export const TEMPLATE_BOAS_VINDAS_PRIMEIRO_ACESSO = [
  "Olá, {{hospede_nome}}! Seja bem-vindo ao Yes Hotel.",
  "",
  "Apartamento: {{apartamento}}",
  "",
  "Wi-Fi:",
  "Rede: {{wifi_rede}}",
  "Senha: {{wifi_senha}}",
  "",
  "Check-out: {{checkout_horario}}",
  "",
  "Em caso de necessidade, fale conosco pelo {{telefone_recepcao}}.",
].join("\n");

const PARAM_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;
const SUPORTADOS = new Set<string>(PARAMETROS_SUPORTADOS);

function valorDe(valores: ValoresParametros, nome: string): string {
  const v = (valores as Record<string, unknown>)[nome];
  return String(v ?? "").trim();
}

/**
 * Linha que so existe para carregar um parametro: se o parametro nao veio, a
 * linha inteira sai. "Rede: {{wifi_rede}}" sem rede nao vira "Rede:".
 *
 * Linha com texto proprio alem do parametro tambem sai quando o dado falta,
 * porque o texto sozinho normalmente e rotulo ("Check-out: ").
 */
function linhaDeveSair(linha: string, valores: ValoresParametros): boolean {
  const usados = [...linha.matchAll(PARAM_RE)].map((m) => m[1]!);
  if (usados.length === 0) return false;
  return usados.some((p) => !valorDe(valores, p));
}

/** Cabecalho e a linha que termina em ":" e nao carrega parametro. */
function ehCabecalho(linha: string): boolean {
  const t = linha.trim();
  return t.endsWith(":") && !PARAM_RE.test(t);
}

/**
 * Remove cabecalho que ficou sem nenhuma linha de conteudo abaixo dele.
 * E o que impede sobrar um "Wi-Fi:" solto depois de remover rede e senha.
 */
function removerCabecalhosOrfaos(linhas: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < linhas.length; i += 1) {
    const atual = linhas[i]!;
    if (!ehCabecalho(atual)) {
      out.push(atual);
      continue;
    }
    // Olha adiante até a próxima linha em branco: sobrou conteúdo?
    let temConteudo = false;
    for (let j = i + 1; j < linhas.length; j += 1) {
      const prox = linhas[j]!;
      if (prox.trim() === "") break;
      temConteudo = true;
      break;
    }
    if (temConteudo) out.push(atual);
  }
  return out;
}

/** Colapsa 3+ quebras em no máximo uma linha em branco e apara as pontas. */
function normalizarEspacos(texto: string): string {
  return texto
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

export type ResultadoRender = {
  texto: string;
  html: string;
  /** Parâmetros citados no template que não têm valor. Para diagnóstico. */
  parametros_ausentes: string[];
  /** Parâmetros citados que não existem na lista fechada. */
  parametros_desconhecidos: string[];
};

function escaparHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** HTML a partir do MESMO texto: bloco em branco vira parágrafo. */
function textoParaHtml(texto: string): string {
  const blocos = texto.split(/\n{2,}/).filter((b) => b.trim() !== "");
  return blocos
    .map((b) => `<p>${b.split("\n").map(escaparHtml).join("<br/>")}</p>`)
    .join("\n");
}

/**
 * Renderiza o template.
 *
 * Parâmetro desconhecido NÃO é substituído e a linha é removida: deixar
 * `{{foo}}` visível no WhatsApp do hóspede seria pior, e inventar um valor
 * seria enganoso. O nome desconhecido volta em `parametros_desconhecidos`
 * para a tela de Configurações avisar quem editou.
 */
export function renderizarTemplate(
  corpo: string,
  valores: ValoresParametros,
): ResultadoRender {
  const bruto = String(corpo ?? "");
  const ausentes = new Set<string>();
  const desconhecidos = new Set<string>();

  for (const m of bruto.matchAll(PARAM_RE)) {
    const nome = m[1]!;
    if (!SUPORTADOS.has(nome)) desconhecidos.add(nome);
    else if (!valorDe(valores, nome)) ausentes.add(nome);
  }

  const mantidas = bruto
    .split(/\r?\n/)
    .filter((linha) => {
      const usados = [...linha.matchAll(PARAM_RE)].map((p) => p[1]!);
      if (usados.some((p) => !SUPORTADOS.has(p))) return false;
      return !linhaDeveSair(linha, valores);
    });

  const semOrfaos = removerCabecalhosOrfaos(mantidas);

  const substituidas = semOrfaos.map((linha) =>
    linha.replace(PARAM_RE, (_all, nome: string) => valorDe(valores, nome)),
  );

  const texto = normalizarEspacos(substituidas.join("\n"));
  return {
    texto,
    html: textoParaHtml(texto),
    parametros_ausentes: [...ausentes].sort(),
    parametros_desconhecidos: [...desconhecidos].sort(),
  };
}

export type ValidacaoTemplate = {
  valido: boolean;
  erros: string[];
  avisos: string[];
  parametros_usados: string[];
};

/**
 * Valida o corpo antes de salvar. Recusa o que quebraria o envio; avisa sobre
 * o que é apenas suspeito.
 */
export function validarTemplate(corpo: unknown): ValidacaoTemplate {
  const texto = String(corpo ?? "");
  const erros: string[] = [];
  const avisos: string[] = [];
  const usados = [...texto.matchAll(PARAM_RE)].map((m) => m[1]!);

  if (!texto.trim()) erros.push("O texto da mensagem não pode ficar vazio.");
  if (texto.length > 4000) erros.push("O texto passou de 4000 caracteres.");

  const desconhecidos = [...new Set(usados.filter((p) => !SUPORTADOS.has(p)))];
  for (const d of desconhecidos) {
    erros.push(`Parâmetro não reconhecido: {{${d}}}.`);
  }

  // Chave aberta e não fechada, ou o contrário.
  const abre = (texto.match(/\{\{/g) || []).length;
  const fecha = (texto.match(/\}\}/g) || []).length;
  if (abre !== fecha) erros.push("Há chaves {{ }} abertas e não fechadas.");

  if (usados.length === 0) {
    avisos.push("O texto não usa nenhum parâmetro: será igual para todos os hóspedes.");
  }

  return {
    valido: erros.length === 0,
    erros,
    avisos,
    parametros_usados: [...new Set(usados)].sort(),
  };
}
