import {
  buildProvisionPlan,
  generateOperationalCredentialPreview,
} from "../src/lib/domain/yes-hotel";
import { printJson } from "./_shared";
import { createMockReservation } from "./_yes-hotel-mocks";

async function main(): Promise<void> {
  const reservation = createMockReservation();
  const plan = buildProvisionPlan(reservation);
  const credentialPreview = generateOperationalCredentialPreview(
    reservation.reservationId,
    reservation.apartmentCode,
  );

  printJson("Reserva mockada", reservation);
  printJson("Plano de provisionamento", plan);
  printJson("Preview da credencial", credentialPreview);
}

main().catch((error) => {
  console.error("[yes-access-normal] erro:", error);
  process.exit(1);
});
