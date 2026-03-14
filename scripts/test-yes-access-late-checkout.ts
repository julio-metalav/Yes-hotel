import {
  buildProvisionPlan,
  generateOperationalCredentialPreview,
} from "../src/lib/domain/yes-hotel";
import { printJson } from "./_shared";
import { createMockAdjustment, createMockReservation } from "./_yes-hotel-mocks";

async function main(): Promise<void> {
  const reservation = createMockReservation({
    apartmentCode: "24",
  });
  const adjustment = createMockAdjustment({
    lateCheckOutAt: "2026-03-23T16:30:00-03:00",
  });
  const plan = buildProvisionPlan(reservation, adjustment);
  const credentialPreview = generateOperationalCredentialPreview(
    reservation.reservationId,
    reservation.apartmentCode,
  );

  printJson("Reserva mockada", reservation);
  printJson("Ajuste aplicado", adjustment);
  printJson("Plano de provisionamento", plan);
  printJson("Preview da credencial", credentialPreview);
}

main().catch((error) => {
  console.error("[yes-access-late-checkout] erro:", error);
  process.exit(1);
});
