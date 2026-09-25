/**
 * Catalogo das mensagens automaticas editaveis.
 *
 * Cada mensagem e um REGISTRO proprio, com editor proprio. Juntar tudo num
 * campo so faria uma edicao de boas-vindas derrubar o aviso de tolerancia.
 *
 * `quando` e texto de leitura, para quem edita entender o gatilho sem poder
 * muda-lo. O gatilho mora no codigo: esta tela edita conteudo, nunca regra.
 *
 * Sem I/O.
 */

import {
  PARAMETROS_SUPORTADOS,
  TEMPLATE_BOAS_VINDAS_PRIMEIRO_ACESSO,
  type ParametroMensagem,
} from "./mensagens-template.ts";

export type StatusMensagem = "ativa" | "preparada";

export type DefinicaoMensagem = {
  chave: string;
  nome: string;
  /** Gatilho, em linguagem de operacao. Somente leitura na tela. */
  quando: string;
  /** Parametros que fazem sentido nesta mensagem. */
  parametros: ReadonlyArray<ParametroMensagem>;
  corpo_padrao: string;
  /**
   * `ativa`  = o codigo ja envia por este template.
   * `preparada` = registro existe e e editavel, mas o disparo ainda usa o
   * texto do codigo. Evita prometer na tela o que o backend ainda nao faz.
   */
  status: StatusMensagem;
};

const P_BASICOS: ReadonlyArray<ParametroMensagem> = [
  "hospede_nome",
  "apartamento",
  "telefone_recepcao",
];

export const CATALOGO_MENSAGENS: ReadonlyArray<DefinicaoMensagem> = [
  {
    chave: "boas_vindas_primeiro_acesso",
    nome: "Boas-vindas no primeiro acesso",
    quando:
      "Na primeira vez que a fechadura do apartamento é aberta com a senha do hóspede.",
    parametros: [
      "hospede_nome",
      "apartamento",
      "wifi_rede",
      "wifi_senha",
      "checkout_horario",
      "telefone_recepcao",
      "data_entrada",
      "data_saida",
    ],
    corpo_padrao: TEMPLATE_BOAS_VINDAS_PRIMEIRO_ACESSO,
    status: "ativa",
  },
  {
    chave: "senha_de_acesso",
    nome: "Senha de acesso",
    quando:
      "Quando a senha é liberada, seja pelos requisitos cumpridos ou pela rotina das 13h.",
    parametros: [...P_BASICOS, "data_entrada", "checkout_horario"],
    corpo_padrao: [
      "Olá, {{hospede_nome}}! Sua senha de acesso ao apartamento {{apartamento}} já está ativa.",
      "",
      "Qualquer dúvida, fale conosco pelo {{telefone_recepcao}}.",
    ].join("\n"),
    status: "preparada",
  },
  {
    chave: "pendencia_fnrh",
    nome: "Pendência de FNRH",
    quando:
      "No primeiro acesso, quando faltam fichas de hóspedes e o pagamento está em dia.",
    parametros: P_BASICOS,
    corpo_padrao: [
      "Bem-vindo ao Yes Hotel, {{hospede_nome}}.",
      "",
      "Ainda existem fichas de hóspedes pendentes nesta reserva.",
      "Regularize em até 1 hora para evitar a suspensão temporária das senhas.",
    ].join("\n"),
    status: "preparada",
  },
  {
    chave: "pendencia_pagamento",
    nome: "Pendência de pagamento",
    quando:
      "No primeiro acesso, quando falta pagamento e as fichas estão em dia.",
    parametros: P_BASICOS,
    corpo_padrao: [
      "Bem-vindo ao Yes Hotel, {{hospede_nome}}.",
      "",
      "O pagamento da sua reserva ainda está pendente.",
      "Regularize em até 1 hora para evitar a suspensão temporária das senhas.",
    ].join("\n"),
    status: "preparada",
  },
  {
    chave: "pendencia_fnrh_e_pagamento",
    nome: "FNRH e pagamento pendentes",
    quando: "No primeiro acesso, quando faltam as fichas e o pagamento.",
    parametros: P_BASICOS,
    corpo_padrao: [
      "Bem-vindo ao Yes Hotel, {{hospede_nome}}.",
      "",
      "O pagamento e o preenchimento das fichas de hóspedes ainda estão pendentes.",
      "Regularize em até 1 hora para evitar a suspensão temporária das senhas.",
    ].join("\n"),
    status: "preparada",
  },
  {
    chave: "aviso_tolerancia_1h",
    nome: "Aviso de tolerância de 1 hora",
    quando:
      "Quando a tolerância vence sem regularização e as senhas são suspensas.",
    parametros: P_BASICOS,
    corpo_padrao: [
      "{{hospede_nome}}, as senhas de acesso do apartamento {{apartamento}} foram",
      "temporariamente suspensas por pendências não regularizadas.",
      "",
      "Fale conosco pelo {{telefone_recepcao}} para liberar novamente.",
    ].join("\n"),
    status: "preparada",
  },
  {
    chave: "pagamento_presencial_diferido",
    nome: "Pagamento presencial diferido",
    quando:
      "No primeiro acesso após o horário limite, quando o pagamento presencial foi autorizado.",
    parametros: [...P_BASICOS, "data_saida"],
    corpo_padrao: [
      "Bem-vindo, {{hospede_nome}}!",
      "",
      "O café da manhã é servido das 06h às 09h.",
      "Aproveite para regularizar o pagamento com a recepção até às 09h de amanhã.",
      "",
      "Qualquer dúvida, fale conosco pelo {{telefone_recepcao}}.",
    ].join("\n"),
    status: "preparada",
  },
  {
    chave: "check_out",
    nome: "Check-out",
    quando: "Na aproximação do horário de saída previsto da reserva.",
    parametros: [...P_BASICOS, "checkout_horario", "data_saida"],
    corpo_padrao: [
      "{{hospede_nome}}, seu check-out está previsto para {{data_saida}}, às {{checkout_horario}}.",
      "",
      "Foi um prazer receber você no Yes Hotel.",
      "Qualquer necessidade, fale conosco pelo {{telefone_recepcao}}.",
    ].join("\n"),
    status: "preparada",
  },
];

export function buscarDefinicaoMensagem(chave: unknown): DefinicaoMensagem | null {
  const c = String(chave ?? "").trim();
  return CATALOGO_MENSAGENS.find((m) => m.chave === c) ?? null;
}

/** Chaves do catálogo, para a migration e a tela lerem da mesma fonte. */
export const CHAVES_MENSAGENS = CATALOGO_MENSAGENS.map((m) => m.chave);

/** Toda definição só pode citar parâmetro que o motor sabe resolver. */
export function validarCatalogo(): string[] {
  const erros: string[] = [];
  const suportados = new Set<string>(PARAMETROS_SUPORTADOS);
  const vistas = new Set<string>();
  for (const m of CATALOGO_MENSAGENS) {
    if (vistas.has(m.chave)) erros.push(`chave duplicada: ${m.chave}`);
    vistas.add(m.chave);
    for (const p of m.parametros) {
      if (!suportados.has(p)) erros.push(`${m.chave}: parâmetro inválido ${p}`);
    }
    for (const m2 of m.corpo_padrao.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) {
      const nome = m2[1]!;
      if (!suportados.has(nome)) erros.push(`${m.chave}: corpo usa ${nome}, que não existe`);
      if (!m.parametros.includes(nome as ParametroMensagem)) {
        erros.push(`${m.chave}: corpo usa ${nome}, fora da lista da mensagem`);
      }
    }
  }
  return erros;
}
