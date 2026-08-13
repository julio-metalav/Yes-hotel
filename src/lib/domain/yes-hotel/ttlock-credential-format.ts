/**
 * Regras de exibição do passcode TTLock e do nome na fechadura.
 * Desacopladas de PMS: usa `external_reservation_id` (texto vindo de integração externa)
 * e fallback para dígitos do UUID interno da reserva.
 *
 * Política de PIN (provisionamento):
 * - gerar PIN aleatório de 4 dígitos UMA VEZ e persistir em `codigo_credencial`;
 * - replay da mesma credencial reutiliza o PIN persistido;
 * - NÃO derivar de marker/data para novas credenciais (evita colisão entre reservas).
 */

/** Máximo de tentativas com PIN novo após TTLock -3007 (mesma credencial nunca provisionada). */
export const TTLOCK_PASSCODE_COLLISION_RETRY_MAX = 3;

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
 * @deprecated Não usar para provisionar novas credenciais.
 * Preferir `allocateNewTtlockPasscode` / `generateRandomTtlockPasscode` + persistência.
 * Mantido apenas para compatibilidade de testes/legado.
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

function randomFourDigitCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(1000 + (buf[0] % 9000));
}

/**
 * Senha TTLock aleatória de 4 dígitos, distinta dos valores em `exclude`.
 * Usada em provisionamento inicial e em "Gerar nova senha".
 */
export function generateRandomTtlockPasscode(
  exclude?: string | null | Iterable<string>,
): string {
  const blocked = new Set<string>();
  if (typeof exclude === "string") {
    const s = exclude.trim();
    if (s) blocked.add(s);
  } else if (exclude) {
    for (const x of exclude) {
      const s = String(x ?? "").trim();
      if (s) blocked.add(s);
    }
  }
  for (let i = 0; i < 64; i++) {
    const code = randomFourDigitCode();
    if (!blocked.has(code)) return code;
  }
  for (let n = 1000; n <= 9999; n++) {
    const code = String(n);
    if (!blocked.has(code)) return code;
  }
  return "1000";
}

/** Alias semântico: alocar PIN aleatório para persistir em `codigo_credencial`. */
export function allocateNewTtlockPasscode(
  exclude?: string | null | Iterable<string>,
): string {
  return generateRandomTtlockPasscode(exclude);
}

/** Detecta colisão de passcode na TTLock (errcode -3007). */
export function isTtlockSamePasscodeError(message: string | null | undefined): boolean {
  const m = String(message ?? "");
  return m.includes("-3007") || /same passcode already exists/i.test(m);
}

/**
 * Normaliza o PIN técnico TTLock (somente dígitos).
 * Nunca inclui "#" — o hash é só instrução de uso no teclado físico.
 */
export function normalizeTechnicalTtlockPasscode(passcode: string | null | undefined): string {
  return extractDigits(String(passcode ?? ""));
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
