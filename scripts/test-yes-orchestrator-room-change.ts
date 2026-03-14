import {
  buildReservationOperationalPlan,
  formatOperationalPlanForConsole,
} from "../src/lib/application/yes-hotel";
import { printJson } from "./_shared";
import { createMockReservation } from "./_yes-hotel-mocks";

async function main(): Promise<void> {
  const context = {
    eventType: "room_changed" as const,
    previousReservation: createMockReservation({
      reservationId: "ORQ-2001",
      apartmentCode: "09",
    }),
    currentReservation: createMockReservation({
      reservationId: "ORQ-2001",
      apartmentCode: "24",
    }),
  };
  const plan = buildReservationOperationalPlan(context);

  printJson("Plano operacional bruto", plan);
  console.log("\n=== Resumo formatado ===");
  console.log(formatOperationalPlanForConsole(plan));
}

main().catch((error) => {
  console.error("[yes-orchestrator-room-change] erro:", error);
  process.exit(1);
});
