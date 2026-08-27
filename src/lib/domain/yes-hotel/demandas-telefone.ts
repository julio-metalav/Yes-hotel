/**
 * Telefone/WhatsApp de usuários internos (Demandas).
 * Normaliza para E.164 brasileiro (+55…) sem gravar máscara livre.
 */

export const DEMANDAS_TELEFONE_E164_RE = /^\+55\d{10,11}$/;

export function digitsOnlyPhone(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

export function normalizeTelefoneWhatsapp(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }

  let digits = digitsOnlyPhone(raw);
  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }

  if (digits.length === 10 || digits.length === 11) {
    digits = `55${digits}`;
  }

  if (digits.length !== 12 && digits.length !== 13) {
    throw new Error("demandas_telefone_invalido");
  }

  if (!digits.startsWith("55")) {
    throw new Error("demandas_telefone_invalido");
  }

  const local = digits.slice(2);
  if (local.length === 11 && local[2] !== "9") {
    throw new Error("demandas_telefone_invalido");
  }

  return `+${digits}`;
}

export function telefoneWhatsappIsAssignable(value: unknown): boolean {
  try {
    return Boolean(normalizeTelefoneWhatsapp(value));
  } catch {
    return false;
  }
}

export const DEMANDAS_DIGISAC_STATUS = [
  "disponivel",
  "pendente_sem_telefone",
] as const;
export type DemandasDigisacNotificacaoStatus =
  (typeof DEMANDAS_DIGISAC_STATUS)[number];

/** Status de notificação DigiSac. Nunca devolve o número. */
export function demandasDigisacNotificacaoStatus(
  telefoneWhatsapp: unknown,
): DemandasDigisacNotificacaoStatus {
  return telefoneWhatsappIsAssignable(telefoneWhatsapp)
    ? "disponivel"
    : "pendente_sem_telefone";
}

export function isDemandasStatusAberto(status: string): boolean {
  return status !== "concluida" && status !== "cancelada";
}

/**
 * WhatsApp é opcional no cadastro. Remover o número não bloqueia demanda
 * aberta: o envio DigiSac fica `pendente_sem_telefone`.
 */
export function assertPodeRemoverTelefoneWhatsapp(_input: {
  userId: string;
  telefoneAtual: string | null | undefined;
  telefoneNovo: string | null;
  atribuicoes: Array<{ supervisor_id: string; executor_id: string; status: string }>;
}): void {
  return;
}
