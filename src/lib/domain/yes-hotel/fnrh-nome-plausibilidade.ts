/**
 * O OCR nao pode salvar rotulo do documento como nome do hospede.
 *
 * Caso real em PROD: fichas gravadas com "NOME" e "SOBRENOME" no lugar do nome.
 * O extrator do Google usava `[:\s]+` entre rotulo e valor, e `\s` casa quebra
 * de linha. Em documento onde o rotulo fica numa linha e o valor na seguinte,
 * o regex atravessava a quebra e capturava o PROXIMO ROTULO:
 *
 *     NOME
 *     SOBRENOME          <- virava o nome
 *     CARLOS GABRIEL ...
 *
 * A defesa aqui tem duas camadas, de proposito. A lista de rotulos pega o caso
 * conhecido; a analise de forma pega o que a lista nao previu. Uma lista
 * sozinha envelhece mal: basta um documento novo com um cabecalho diferente.
 *
 * Regra de ouro: na duvida, NAO preencher. Campo vazio o hospede corrige em
 * segundos; nome errado ja gravado vira ficha oficial com dado falso.
 *
 * Sem I/O.
 */

/** Compara ignorando acento, caixa, pontuacao e espaco repetido. */
export function normalizarParaComparacao(valor: unknown): string {
  return String(valor ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Rotulos e cabecalhos observados em RG, CNH, passaporte e documentos
 * estrangeiros. Comparados ja normalizados, entao "FILIAÇÃO" casa "FILIACAO".
 */
export const ROTULOS_DOCUMENTO: ReadonlyArray<string> = [
  // identificacao
  "NOME", "SOBRENOME", "NOME COMPLETO", "NOME CIVIL", "NOME SOCIAL",
  "NOME E SOBRENOME", "PRENOME", "APELIDO", "ALCUNHA",
  "NAME", "SURNAME", "GIVEN NAME", "GIVEN NAMES", "FIRST NAME", "LAST NAME",
  "MIDDLE NAME", "FULL NAME", "NOMBRE", "APELLIDO", "APELLIDOS",
  // filiacao e origem
  "FILIACAO", "PAI", "MAE", "NOME DO PAI", "NOME DA MAE",
  "NACIONALIDADE", "NATIONALITY", "NATURALIDADE", "PAIS", "COUNTRY",
  "PAIS EMISSOR", "ISSUING COUNTRY", "LOCAL DE NASCIMENTO", "PLACE OF BIRTH",
  // datas
  "DATA DE NASCIMENTO", "DATA NASCIMENTO", "NASCIMENTO",
  "DATE OF BIRTH", "DOB", "FECHA DE NACIMIENTO",
  "DATA DE EMISSAO", "DATA EMISSAO", "EMISSAO", "DATE OF ISSUE",
  "VALIDADE", "DATA DE VALIDADE", "DATE OF EXPIRY", "EXPIRY",
  // documento
  "DOCUMENTO", "DOCUMENTO DE IDENTIDADE", "DOC IDENTIDADE", "DOCUMENT",
  "CPF", "RG", "REGISTRO GERAL", "IDENTIDADE", "NUMERO", "NUMBER", "NO",
  "PASSAPORTE", "PASSPORT", "CNH", "CARTEIRA NACIONAL DE HABILITACAO",
  "REGISTRO NACIONAL", "RNE", "RNM", "CRNM", "CIE",
  "ORGAO EMISSOR", "ORG EMISSOR", "AUTHORITY", "EXPEDIDOR",
  "CATEGORIA", "CATEGORY", "TIPO", "TYPE", "SERIE",
  // outros campos
  "SEXO", "SEX", "GENERO", "ESTADO CIVIL", "PROFISSAO",
  "ASSINATURA", "SIGNATURE", "OBSERVACOES", "OBSERVACAO",
  "ENDERECO", "ADDRESS", "CEP", "TELEFONE", "EMAIL",
  // cabecalhos de documento
  "REPUBLICA FEDERATIVA DO BRASIL", "MINISTERIO DA JUSTICA",
  "CARTEIRA DE IDENTIDADE", "DOCUMENTO GENERICO",
  "SECRETARIA DE SEGURANCA PUBLICA", "DETRAN", "SSP", "VALIDO EM TODO O TERRITORIO NACIONAL",
];

const ROTULOS = new Set(ROTULOS_DOCUMENTO.map(normalizarParaComparacao));

/** Palavra isolada que so existe como rotulo, nunca como nome de pessoa. */
const PALAVRAS_DE_ROTULO = new Set(
  [
    "NOME", "SOBRENOME", "NAME", "SURNAME", "APELIDO", "FILIACAO",
    "NACIONALIDADE", "NATURALIDADE", "DOCUMENTO", "DOCUMENT", "CPF", "RG",
    "SEXO", "SEX", "GENERO", "NASCIMENTO", "VALIDADE", "EMISSAO",
    "PASSAPORTE", "PASSPORT", "CNH", "IDENTIDADE", "CATEGORIA", "ASSINATURA",
    "NUMERO", "NUMBER", "ENDERECO", "ADDRESS", "PAI", "MAE",
  ].map(normalizarParaComparacao),
);

export function isRotuloDocumento(valor: unknown): boolean {
  const n = normalizarParaComparacao(valor);
  if (!n) return false;
  if (ROTULOS.has(n)) return true;
  // "NOME COMPLETO DO TITULAR" tambem e rotulo: toda palavra e de rotulo.
  const palavras = n.split(" ").filter(Boolean);
  if (palavras.length > 0 && palavras.every((p) => PALAVRAS_DE_ROTULO.has(p))) return true;
  return false;
}

export type MotivoNomeRejeitado =
  | "vazio"
  | "rotulo_do_documento"
  | "curto_demais"
  | "contem_digito"
  | "parece_data"
  | "parece_codigo_documento"
  | "sem_letras"
  | "palavra_unica_curta";

export type AvaliacaoNome =
  | { plausivel: true; nome: string }
  | { plausivel: false; motivo: MotivoNomeRejeitado };

/**
 * Nome proprio plausivel. Conservador por decisao: prefere recusar um nome
 * legitimo esquisito a aceitar um rotulo.
 *
 * Aceita nome de uma palavra so com pelo menos 3 letras, porque existe
 * hospede estrangeiro com nome unico. Mas recusa palavra unica curta, que
 * quase sempre e sigla ou fragmento de rotulo.
 *
 * Acentos e nomes compostos com hifen ou apostrofo sao preservados: a
 * validacao normaliza apenas para COMPARAR, nunca altera o valor devolvido.
 */
export function avaliarNomeHospede(valorBruto: unknown): AvaliacaoNome {
  const nome = String(valorBruto ?? "").replace(/\s+/g, " ").trim();
  if (!nome) return { plausivel: false, motivo: "vazio" };

  if (isRotuloDocumento(nome)) {
    return { plausivel: false, motivo: "rotulo_do_documento" };
  }

  // Data em qualquer formato comum, com ou sem rotulo em volta.
  if (/\d{1,4}[\/\-.]\d{1,2}[\/\-.]\d{1,4}/.test(nome)) {
    return { plausivel: false, motivo: "parece_data" };
  }

  // Numero de documento, MRZ, sigla com digito. Nome de pessoa nao tem digito.
  if (/\d/.test(nome)) {
    return { plausivel: false, motivo: "contem_digito" };
  }

  const semAcento = nome.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const letras = semAcento.replace(/[^A-Za-z]/g, "");
  if (letras.length === 0) return { plausivel: false, motivo: "sem_letras" };
  if (letras.length < 3) return { plausivel: false, motivo: "curto_demais" };

  // Linha MRZ de passaporte: "P<BRASILVA<<CARLOS".
  if (/<{2,}/.test(nome) || /^P<[A-Z]{3}/i.test(semAcento)) {
    return { plausivel: false, motivo: "parece_codigo_documento" };
  }

  const palavras = nome.split(" ").filter(Boolean);
  if (palavras.length === 1 && letras.length < 4) {
    return { plausivel: false, motivo: "palavra_unica_curta" };
  }

  // Rotulo colado no INICIO do valor: e assim que o OCR emenda o cabecalho no
  // nome ("NOME CARLOS SILVA"). Nao se rejeita por palavra em qualquer
  // posicao, porque isso reprovaria nome legitimo por coincidencia.
  if (palavras.length > 1 && PALAVRAS_DE_ROTULO.has(normalizarParaComparacao(palavras[0]))) {
    return { plausivel: false, motivo: "rotulo_do_documento" };
  }

  return { plausivel: true, nome };
}

/** Atalho booleano para os pontos que só precisam aceitar ou recusar. */
export function isNomeHospedePlausivel(valor: unknown): boolean {
  return avaliarNomeHospede(valor).plausivel;
}

/** Devolve o nome quando plausível; string vazia quando não. */
export function sanitizarNomeHospede(valor: unknown): string {
  const r = avaliarNomeHospede(valor);
  return r.plausivel ? r.nome : "";
}
