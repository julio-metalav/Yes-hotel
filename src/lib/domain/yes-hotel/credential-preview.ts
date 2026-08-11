import { normalizeApartmentCode } from "./hotel-layout.ts";
import type { OperationalCredentialPreview } from "./types.ts";

function hashText(input: string): number {
  let hash = 0;

  for (const char of input) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1000000;
  }

  return hash;
}

export function generateOperationalCredentialPreview(
  reservationId: string,
  apartmentCode: string,
): OperationalCredentialPreview {
  const normalizedApartmentCode = normalizeApartmentCode(apartmentCode);
  const safeReservationId = reservationId.trim();

  if (!safeReservationId) {
    throw new Error("reservationId obrigatorio para gerar preview de credencial.");
  }

  const hashBase = hashText(`${safeReservationId}:${normalizedApartmentCode}`);
  const pinPreview = String(hashBase).padStart(6, "0");

  return {
    credentialId: `cred-${safeReservationId}-${normalizedApartmentCode}`,
    pinPreview,
    notes:
      "Preview mockado apenas para simulacao interna. Nao representa a regra final de producao.",
  };
}
