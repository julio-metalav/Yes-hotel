/**
 * Espelho de src/lib/domain/yes-hotel/ttlock-credential-format.ts para a Edge (Deno).
 * Ao alterar regras, mantenha os dois arquivos alinhados.
 */

export const TTLOCK_PASSCODE_COLLISION_RETRY_MAX = 3;

export function extractDigits(input: string): string {
  return String(input ?? "").replace(/\D/g, "");
}

export function lastFourDigitsPaddedFromDigitRun(digits: string): string {
  const d = extractDigits(digits);
  if (d.length >= 4) return d.slice(-4);
  return d.padStart(4, "0");
}

/**
 * @deprecated Não usar para provisionar novas credenciais.
 * Preferir allocateNewTtlockPasscode / generateRandomTtlockPasscode.
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

/** Senha aleatória de 4 dígitos distinta de `exclude` (provisionamento / Gerar nova senha). */
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

export function allocateNewTtlockPasscode(
  exclude?: string | null | Iterable<string>,
): string {
  return generateRandomTtlockPasscode(exclude);
}

export function isTtlockSamePasscodeError(message: string | null | undefined): boolean {
  const m = String(message ?? "");
  return m.includes("-3007") || /same passcode already exists/i.test(m);
}

function guestFirstAndSecondOrNull(fullName: string | null | undefined): string | null {
  const s = String(fullName ?? "").trim().replace(/\s+/g, " ");
  if (!s) return null;
  const parts = s.split(" ");
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1]}`;
}

/** Normaliza PIN técnico (somente dígitos). Nunca inclui "#". */
export function normalizeTechnicalTtlockPasscode(passcode: string | null | undefined): string {
  return extractDigits(String(passcode ?? ""));
}

export type TtlockPasscodeGuestPresentation = {
  technical: string;
  displayWithHash: string;
  instructionLine: string;
  guestBlock: string;
  guestBlockHtml: string;
};

/**
 * Apresentação ao hóspede: PIN técnico sem "#"; "#" é instrução do teclado físico
 * (apartamento e portões TTLock do bloco usam a mesma senha + #).
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
