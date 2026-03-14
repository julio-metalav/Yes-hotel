import {
  buildReservationOperationalPlan,
  formatOperationalPlanForConsole,
} from "../src/lib/application/yes-hotel";
import { printJson } from "./_shared";
import { createMockAdjustment, createMockReservation } from "./_yes-hotel-mocks";

async function main(): Promise<void> {
  const context = {
    eventType: "manual_adjustment" as const,
    currentReservation: createMockReservation({
      reservationId: "ORQ-4001",
      apartmentCode: "18",
    }),
    adjustment: createMockAdjustment({
      earlyCheckInAt: "2026-03-20T09:00:00-03:00",
      lateCheckOutAt: "2026-03-23T16:00:00-03:00",
    }),
  };
  const plan = buildReservationOperationalPlan(context);

  printJson("Plano operacional bruto", plan);
  console.log("\n=== Resumo formatado ===");
  console.log(formatOperationalPlanForConsole(plan));
}

main().catch((error) => {
  console.error("[yes-orchestrator-manual-adjustment] erro:", error);
  process.exit(1);
});
