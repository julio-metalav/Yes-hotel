import {
  buildReservationOperationalPlan,
  formatOperationalPlanForConsole,
} from "../src/lib/application/yes-hotel";
import {
  hitsMockRoomChangeNextDetail,
  hitsMockRoomChangePreviousDetail,
  mapHitsDetailToInternalReservation,
} from "../src/lib/integrations/hits-mock";
import { printJson } from "./_shared";

async function main(): Promise<void> {
  const previousPayload = hitsMockRoomChangePreviousDetail;
  const nextPayload = hitsMockRoomChangeNextDetail;
  const previousInternalReservation =
    mapHitsDetailToInternalReservation(previousPayload);
  const nextInternalReservation = mapHitsDetailToInternalReservation(nextPayload);
  const operationalPlan = buildReservationOperationalPlan({
    eventType: "room_changed",
    previousReservation: previousInternalReservation,
    currentReservation: nextInternalReservation,
  });

  printJson("Resumo do payload HITS mock anterior", {
    idReservation: previousPayload.idReservation,
    status: previousPayload.status,
    roomCodes: previousPayload.rooms?.map((room) => room.code) ?? [],
  });
  printJson("Resumo do payload HITS mock novo", {
    idReservation: nextPayload.idReservation,
    status: nextPayload.status,
    roomCodes: nextPayload.rooms?.map((room) => room.code) ?? [],
  });
  printJson("InternalReservation anterior", previousInternalReservation);
  printJson("InternalReservation nova", nextInternalReservation);
  printJson("Plano operacional", operationalPlan);
  console.log("\n=== Resumo formatado ===");
  console.log(formatOperationalPlanForConsole(operationalPlan));
}

main().catch((error) => {
  console.error("[hits-mock-to-yes-room-change] erro:", error);
  process.exit(1);
});
