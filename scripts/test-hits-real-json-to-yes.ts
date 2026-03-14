import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  buildReservationOperationalPlan,
  formatOperationalPlanForConsole,
} from "../src/lib/application/yes-hotel";
import type { HitsReservationDetail } from "../src/lib/integrations/hits";
import { mapHitsReservationDetailToInternalReservation } from "../src/lib/integrations/hits";
import { getArgValue, printJson } from "./_shared";

const DEFAULT_SAMPLE_FILE = "fixtures/hits-real-sample-detail.json";

function resolveInputFilePath(): string {
  const inputPath = getArgValue("--file") ?? DEFAULT_SAMPLE_FILE;
  return path.resolve(process.cwd(), inputPath);
}

async function loadHitsReservationDetailFromFile(
  filePath: string,
): Promise<HitsReservationDetail> {
  const content = await readFile(filePath, "utf-8");
  return JSON.parse(content) as HitsReservationDetail;
}

async function main(): Promise<void> {
  const filePath = resolveInputFilePath();
  const payload = await loadHitsReservationDetailFromFile(filePath);
  const internalReservation = mapHitsReservationDetailToInternalReservation(payload);
  const operationalPlan = buildReservationOperationalPlan({
    eventType:
      internalReservation.status === "canceled"
        ? "reservation_canceled"
        : "reservation_created",
    currentReservation: internalReservation,
  });

  printJson("Resumo do JSON bruto", {
    filePath,
    idReservation: payload.idReservation,
    roomCodes: payload.rooms?.map((room) => room.code) ?? [],
    guestNames: payload.guests?.map((guest) => guest.name) ?? [],
    dateUp: payload.dateUp ?? null,
    dateAdd: payload.dateAdd ?? null,
  });
  printJson("InternalReservation", internalReservation);
  printJson("Plano operacional", operationalPlan);
  console.log("\n=== Resumo formatado ===");
  console.log(formatOperationalPlanForConsole(operationalPlan));
}

main().catch((error) => {
  console.error("[hits-real-json-to-yes] erro:", error);
  process.exit(1);
});
