/**
 * Política de envio do Payment Link ao hóspede.
 * Envio NÃO cria cobrança nem Payment Link novo — só reutiliza o existente.
 * Multicanal (e-mail + WhatsApp) fica em guest-multichannel.ts.
 */

export type PaymentLinkCobrancaCandidate = {
  id: string;
  status: string;
  pagarme_payment_link_url?: string | null;
  payment_link_url?: string | null;
};

export type ResolvePaymentLinkForSendResult =
  | {
      ok: true;
      cobrancaId: string;
      paymentLinkUrl: string;
      status: string;
    }
  | {
      ok: false;
      error:
        | "cobranca_nao_encontrada"
        | "payment_link_ausente"
        | "status_nao_permite_envio"
        | "url_insegura";
      message: string;
    };

const SENDABLE = new Set(["created", "pending", "processing"]);

export function extractPaymentLinkUrl(
  row: PaymentLinkCobrancaCandidate | null | undefined,
): string | null {
  if (!row) return null;
  const raw = String(row.pagarme_payment_link_url || row.payment_link_url || "").trim();
  return raw || null;
}

/** HTTPS público obrigatório — espelha isSafeHttpsPaymentLinkUrl da UI. */
export function isSafeHttpsPaymentLinkUrl(url: string): boolean {
  try {
    const u = new URL(String(url || "").trim());
    if (u.protocol !== "https:") return false;
    if (!u.hostname || u.hostname === "localhost") return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Escolhe a cobrança/link para envio.
 * Nunca cria recurso. Preferência: cobrancaId explícito, senão 1ª candidata sendable com URL.
 */
export function resolvePaymentLinkForSend(input: {
  cobrancas: PaymentLinkCobrancaCandidate[];
  cobrancaId?: string | null;
}): ResolvePaymentLinkForSendResult {
  const list = Array.isArray(input.cobrancas) ? input.cobrancas : [];
  const wantedId = String(input.cobrancaId ?? "").trim();

  let row: PaymentLinkCobrancaCandidate | undefined;
  if (wantedId) {
    row = list.find((c) => c.id === wantedId);
    if (!row) {
      return {
        ok: false,
        error: "cobranca_nao_encontrada",
        message: "Cobrança informada não encontrada nesta reserva.",
      };
    }
  } else {
    row = list.find((c) => {
      const st = String(c.status || "").trim().toLowerCase();
      return SENDABLE.has(st) && !!extractPaymentLinkUrl(c);
    });
    if (!row) {
      return {
        ok: false,
        error: "cobranca_nao_encontrada",
        message: "Nenhuma cobrança com Payment Link ativo para envio.",
      };
    }
  }

  const status = String(row.status || "").trim().toLowerCase();
  if (!SENDABLE.has(status)) {
    return {
      ok: false,
      error: "status_nao_permite_envio",
      message: `Status "${status}" não permite envio do Payment Link.`,
    };
  }

  const url = extractPaymentLinkUrl(row);
  if (!url) {
    return {
      ok: false,
      error: "payment_link_ausente",
      message: "Cobrança sem Payment Link. Gere o link antes de enviar.",
    };
  }
  if (!isSafeHttpsPaymentLinkUrl(url)) {
    return {
      ok: false,
      error: "url_insegura",
      message: "Payment Link inválido (exige HTTPS público).",
    };
  }

  return {
    ok: true,
    cobrancaId: row.id,
    paymentLinkUrl: url,
    status,
  };
}

/** Envio / reenvio / falha parcial NÃO devem criar cobrança nova. */
export function sendMustNotCreateCobranca(): true {
  return true;
}

/**
 * paid (e estados finais pagos) nunca geram novo link via fluxo de envio.
 * Criação permanece no service de cobrança (anti-dup).
 */
export function paidMustNotCreateNewPaymentLink(status: string): boolean {
  return String(status || "").trim().toLowerCase() === "paid";
}

export function maskPaymentLinkForLog(url: string): string {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    const path = u.pathname.length > 12 ? `${u.pathname.slice(0, 8)}…` : u.pathname;
    return `${u.origin}${path}`;
  } catch {
    return raw.slice(0, 24) + "…";
  }
}
