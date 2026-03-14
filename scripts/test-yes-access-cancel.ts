import { buildCancellationPlan } from "../src/lib/domain/yes-hotel";
import { printJson } from "./_shared";
import { createMockReservation } from "./_yes-hotel-mocks";

async function main(): Promise<void> {
  const reservation = createMockReservation({
    reservationId: "RES-3001",
    apartmentCode: "31",
    status: "canceled",
  });
  const plan = buildCancellationPlan(reservation);

  printJson("Reserva cancelada", reservation);
  printJson("Plano de revogacao", plan);
}

main().catch((error) => {
  console.error("[yes-access-cancel] erro:", error);
  process.exit(1);
});
