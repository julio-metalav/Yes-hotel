import {
  buildReservationOperationalPlan,
  formatOperationalPlanForConsole,
} from "../src/lib/application/yes-hotel";
import {
  hitsMockCanceledReservationDetail,
  mapHitsDetailToInternalReservation,
} from "../src/lib/integrations/hits-mock";
import { printJson } from "./_shared";

async function main(): Promise<void> {
  const payload = hitsMockCanceledReservationDetail;
  const internalReservation = mapHitsDetailToInternalReservation(payload);
  const operationalPlan = buildReservationOperationalPlan({
    eventType: "reservation_canceled",
    currentReservation: internalReservation,
  });

  printJson("Resumo do payload HITS mock", {
    idReservation: payload.idReservation,
    status: payload.status,
    roomCodes: payload.rooms?.map((room) => room.code) ?? [],
    guestNames: payload.guests?.map((guest) => guest.name) ?? [],
  });
  printJson("InternalReservation", internalReservation);
  printJson("Plano operacional", operationalPlan);
  console.log("\n=== Resumo formatado ===");
  console.log(formatOperationalPlanForConsole(operationalPlan));
}

main().catch((error) => {
  console.error("[hits-mock-to-yes-cancel] erro:", error);
  process.exit(1);
});
