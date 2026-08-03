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
