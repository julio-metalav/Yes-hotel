import {
  buildRoomChangePlan,
  generateOperationalCredentialPreview,
} from "../src/lib/domain/yes-hotel";
import { printJson } from "./_shared";
import { createMockReservation } from "./_yes-hotel-mocks";

async function main(): Promise<void> {
  const previousReservation = createMockReservation({
    reservationId: "RES-2001",
    apartmentCode: "10",
  });
  const nextReservation = createMockReservation({
    reservationId: "RES-2001",
    apartmentCode: "24",
  });
  const plan = buildRoomChangePlan(previousReservation, nextReservation);
  const credentialPreview = generateOperationalCredentialPreview(
    nextReservation.reservationId,
    nextReservation.apartmentCode,
  );

  printJson("Reserva anterior", previousReservation);
  printJson("Reserva nova", nextReservation);
  printJson("Plano de troca de apartamento", plan);
  printJson("Preview da credencial nova", credentialPreview);
}

main().catch((error) => {
  console.error("[yes-access-room-change] erro:", error);
  process.exit(1);
});
