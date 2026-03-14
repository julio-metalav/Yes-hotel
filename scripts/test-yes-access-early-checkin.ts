import {
  buildProvisionPlan,
  generateOperationalCredentialPreview,
} from "../src/lib/domain/yes-hotel";
import { printJson } from "./_shared";
import { createMockAdjustment, createMockReservation } from "./_yes-hotel-mocks";

async function main(): Promise<void> {
  const reservation = createMockReservation({
    apartmentCode: "08",
  });
  const adjustment = createMockAdjustment({
    earlyCheckInAt: "2026-03-20T09:00:00-03:00",
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
  console.error("[yes-access-early-checkin] erro:", error);
  process.exit(1);
});
