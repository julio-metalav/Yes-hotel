import {
  buildReservationOperationalPlan,
  formatOperationalPlanForConsole,
} from "../src/lib/application/yes-hotel";
import { printJson } from "./_shared";
import { createMockReservation } from "./_yes-hotel-mocks";

async function main(): Promise<void> {
  const context = {
    eventType: "reservation_created" as const,
    currentReservation: createMockReservation({
      reservationId: "ORQ-1001",
      apartmentCode: "07",
    }),
  };
  const plan = buildReservationOperationalPlan(context);

  printJson("Plano operacional bruto", plan);
  console.log("\n=== Resumo formatado ===");
  console.log(formatOperationalPlanForConsole(plan));
}

main().catch((error) => {
  console.error("[yes-orchestrator-created] erro:", error);
  process.exit(1);
});
