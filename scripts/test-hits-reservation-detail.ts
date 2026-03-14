import {
  getReservationById,
  mapHitsReservationDetailToInternalPreview,
} from "../src/lib/integrations/hits";
import { getArgValue, printJson } from "./_shared";

async function main(): Promise<void> {
  const reservationId = getArgValue("--id");

  if (!reservationId) {
    throw new Error("Informe o id da reserva com --id <RESERVATION_ID>.");
  }

  const detail = await getReservationById(reservationId);
  const preview = mapHitsReservationDetailToInternalPreview(detail);

  printJson("Preview interno minimo", preview);
  printJson("Resposta bruta", detail);
}

main().catch((error) => {
  console.error("[hits-reservation-detail] erro:", error);
  process.exit(1);
});
