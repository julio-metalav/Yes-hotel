/**
 * Regras de exibição do passcode TTLock e do nome na fechadura.
 * Desacopladas de PMS: usa `external_reservation_id` (texto vindo de integração externa)
 * e fallback para dígitos do UUID interno da reserva.
 */

/** Mantém apenas dígitos 0-9. */
export function extractDigits(input: string): string {
  return String(input ?? "").replace(/\D/g, "");
}

/**
 * Últimos 4 dígitos da sequência numérica; se houver menos de 4, preenche com zero à esquerda.
 */
export function lastFourDigitsPaddedFromDigitRun(digits: string): string {
  const d = extractDigits(digits);
  if (d.length >= 4) return d.slice(-4);
  return d.padStart(4, "0");
}

/**
 * Senha TTLock: 4 dígitos.
 * 1) Dígitos de `external_reservation_id` (qualquer PMS), últimos 4, pad se necessário.
 * 2) Se vazio, dígitos do `internalReservaId` (UUID interno), mesma regra.
 */
export function deriveTtlockPasscodeFromReservation(
  externalReservationId: string | null | undefined,
  internalReservaId: string,
): string {
  const ext = String(externalReservationId ?? "").trim();
  if (ext) {
    const dig = extractDigits(ext);
    if (dig.length > 0) return lastFourDigitsPaddedFromDigitRun(dig);
  }
  const uuidDig = extractDigits(internalReservaId);
  return lastFourDigitsPaddedFromDigitRun(uuidDig.length > 0 ? uuidDig : "0");
}

/**
 * Gera senha TTLock aleatória de 4 dígitos, distinta de `exclude` quando informado.
 * Usada em "Gerar nova senha" (não reutiliza a derivação determinística da reserva).
 */
export function generateRandomTtlockPasscode(exclude?: string | null): string {
  const blocked = exclude != null && String(exclude).trim() ? String(exclude).trim() : null;
  for (let i = 0; i < 32; i++) {
    const code = String(1000 + Math.floor(Math.random() * 9000));
    if (!blocked || code !== blocked) return code;
  }
  return blocked === "9999" ? "1000" : "9999";
}

/**
 * Primeiro + segundo nome para exibição; null se não houver nome utilizável.
 */
function guestFirstAndSecondOrNull(fullName: string | null | undefined): string | null {
  const s = String(fullName ?? "").trim().replace(/\s+/g, " ");
  if (!s) return null;
  const parts = s.split(" ");
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1]}`;
}

/**
 * Normaliza o PIN técnico TTLock (somente dígitos).
 * Nunca inclui "#" — o hash é só instrução de uso no teclado físico.
 */
export function normalizeTechnicalTtlockPasscode(passcode: string | null | undefined): string {
  return extractDigits(String(passcode ?? ""));
}

export type TtlockPasscodeGuestPresentation = {
  /** PIN técnico (ex.: 1134) — banco / API TTLock. */
  technical: string;
  /** Apresentação com tecla de confirmação (ex.: 1134#). */
  displayWithHash: string;
  /** Linha explicativa (ex.: (digite 1134 + #)). */
  instructionLine: string;
  /**
   * Bloco para WhatsApp/e-mail/hóspede.
   * Mesma senha no apartamento e portões do bloco (teclados TTLock confirmam com #).
   */
  guestBlock: string;
  /** Fragmento HTML do mesmo bloco (texto escapado pelo caller se necessário). */
  guestBlockHtml: string;
};

/**
 * Apresentação da senha ao hóspede.
 * PIN técnico permanece sem "#"; "#" é instrução da fechadura física (apto e portões TTLock).
 */
export function formatTtlockPasscodeForGuest(
  passcode: string | null | undefined,
): TtlockPasscodeGuestPresentation {
  const technical = normalizeTechnicalTtlockPasscode(passcode);
  const displayWithHash = technical ? `${technical}#` : "";
  const instructionLine = technical ? `(digite ${technical} + #)` : "";
  const guestBlock = technical
    ? `Senha do apartamento: ${displayWithHash}\n${instructionLine}\n\nEssa mesma senha vale para o apartamento e para os portões do bloco. Em todas as fechaduras, digite os números e confirme com #.`
    : "Senha do apartamento: (indisponível)";
  const guestBlockHtml = technical
    ? `<p><strong>Senha do apartamento: ${displayWithHash}</strong></p>` +
      `<p>${instructionLine}</p>` +
      `<p>Essa mesma senha vale para o apartamento e para os portões do bloco. Em todas as fechaduras, digite os números e confirme com #.</p>`
    : `<p><strong>Senha do apartamento: (indisponível)</strong></p>`;
  return { technical, displayWithHash, instructionLine, guestBlock, guestBlockHtml };
}

/**
 * Nome do passcode na TTLock: "{apartamento} {primeiro segundo}" ou "{apartamento} Hóspede" sem nome.
 * Apartamento vazio no banco usa "?" como placeholder do prefixo.
 */
export function formatTtlockKeyboardPwdName(
  apartamento: string | null | undefined,
  fullName: string | null | undefined,
): string {
  const apt = String(apartamento ?? "").trim();
  const aptPart = apt.length > 0 ? apt : "?";
  const guest = guestFirstAndSecondOrNull(fullName);
  const namePart = guest ?? "Hóspede";
  return `${aptPart} ${namePart}`;
}
