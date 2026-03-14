import {
  buildReservationOperationalPlan,
  formatOperationalPlanForConsole,
} from "../src/lib/application/yes-hotel";
import { printJson } from "./_shared";
import { createMockReservation } from "./_yes-hotel-mocks";

async function main(): Promise<void> {
  const context = {
    eventType: "reservation_canceled" as const,
    currentReservation: createMockReservation({
      reservationId: "ORQ-3001",
      apartmentCode: "31",
      status: "canceled",
    }),
  };
  const plan = buildReservationOperationalPlan(context);

  printJson("Plano operacional bruto", plan);
  console.log("\n=== Resumo formatado ===");
  console.log(formatOperationalPlanForConsole(plan));
}

main().catch((error) => {
  console.error("[yes-orchestrator-cancel] erro:", error);
  process.exit(1);
});
