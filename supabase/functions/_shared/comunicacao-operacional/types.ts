/** Contrato da camada operacional de comunicação (DigiSac / e-mail). */

export type ComunicacaoProposito = "fnrh_links" | "senha_acesso" | "chat_operador" | "generico";

export type ComunicacaoCanalEnvio = "whatsapp" | "email";

export type ComunicacaoProvider = "digisac_stub" | "digisac" | "resend";

/** Registro em operacional_comunicacao_envios */
export type ComunicacaoEnvioStatusRegistro = "simulado" | "enviada" | "falha";

export type OperacionalComunicacaoEnvioInsert = {
  reserva_id?: string | null;
  conversa_id?: string | null;
  hospede_id?: string | null;
  proposito: ComunicacaoProposito;
  canal: ComunicacaoCanalEnvio;
  destinatario_mascara: string | null;
  corpo_preview: string | null;
  status: ComunicacaoEnvioStatusRegistro;
  provider: ComunicacaoProvider;
  provider_message_id?: string | null;
  metadata?: Record<string, unknown> | null;
  erro?: string | null;
};
