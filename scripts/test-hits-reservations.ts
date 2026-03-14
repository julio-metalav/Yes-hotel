import { listReservations, type HitsReservationListItem } from "../src/lib/integrations/hits";
import { getArgValue, parseOptionalNumber, printJson } from "./_shared";

function extractReservationItems(data: unknown): HitsReservationListItem[] {
  if (Array.isArray(data)) {
    return data as HitsReservationListItem[];
  }

  if (data && typeof data === "object") {
    const candidate = data as {
      data?: unknown;
      items?: unknown;
      results?: unknown;
    };

    if (Array.isArray(candidate.data)) {
      return candidate.data as HitsReservationListItem[];
    }

    if (Array.isArray(candidate.items)) {
      return candidate.items as HitsReservationListItem[];
    }

    if (Array.isArray(candidate.results)) {
      return candidate.results as HitsReservationListItem[];
    }
  }

  return [];
}

async function main(): Promise<void> {
  const response = await listReservations({
    type: parseOptionalNumber(getArgValue("--type")) as 0 | 1 | 2 | undefined,
    status: parseOptionalNumber(getArgValue("--status")) as 1 | 2 | 3 | 4 | undefined,
    initialDate: getArgValue("--initial-date"),
    finalDate: getArgValue("--final-date"),
    reservationIntegrationId: getArgValue("--reservation-integration-id"),
    page: parseOptionalNumber(getArgValue("--page")),
    size: parseOptionalNumber(getArgValue("--size")),
  });

  const items = extractReservationItems(response);

  printJson("Resumo", {
    totalExtraido: items.length,
    primeiroItem: items[0] ?? null,
  });

  printJson("Resposta bruta", response);
}

main().catch((error) => {
  console.error("[hits-reservations] erro:", error);
  process.exit(1);
});
