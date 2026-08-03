/**
 * Espelho de src/lib/domain/yes-hotel/ttlock-credential-format.ts para a Edge (Deno).
 * Ao alterar regras, mantenha os dois arquivos alinhados.
 */

export function extractDigits(input: string): string {
  return String(input ?? "").replace(/\D/g, "");
}

export function lastFourDigitsPaddedFromDigitRun(digits: string): string {
  const d = extractDigits(digits);
  if (d.length >= 4) return d.slice(-4);
  return d.padStart(4, "0");
}

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

/** Senha aleatória de 4 dígitos distinta de `exclude` (Gerar nova senha). */
export function generateRandomTtlockPasscode(exclude?: string | null): string {
  const blocked = exclude != null && String(exclude).trim() ? String(exclude).trim() : null;
  for (let i = 0; i < 32; i++) {
    const code = String(1000 + Math.floor(Math.random() * 9000));
    if (!blocked || code !== blocked) return code;
  }
  return blocked === "9999" ? "1000" : "9999";
}

function guestFirstAndSecondOrNull(fullName: string | null | undefined): string | null {
  const s = String(fullName ?? "").trim().replace(/\s+/g, " ");
  if (!s) return null;
  const parts = s.split(" ");
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[1]}`;
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
