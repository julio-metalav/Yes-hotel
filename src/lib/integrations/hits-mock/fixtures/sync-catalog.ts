/**
 * Fixtures simuladas para sync HITS (NÃO são contrato oficial da API).
 * Ampliam os cenários sem alterar o mapper de autenticação.
 */

import type { HitsMockReservationDetail } from "../types";
import { hitsMockNormalReservationDetail } from "./normal";
import { hitsMockCanceledReservationDetail } from "./cancel";
import { hitsMockRoomChangeNextDetail } from "./room-change";

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function withId(
  base: HitsMockReservationDetail,
  id: string,
  patch: Partial<HitsMockReservationDetail> = {},
): HitsMockReservationDetail {
  const d = clone(base);
  d.idReservation = id;
  return { ...d, ...patch, idReservation: id };
}

/** Catálogo multi-página para sync simulado. */
export function buildHitsMockSyncCatalog(): HitsMockReservationDetail[] {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const todayIso = `${yyyy}-${mm}-${dd}`;

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowIso = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;

  const in3 = new Date(today);
  in3.setDate(in3.getDate() + 3);
  const in3Iso = `${in3.getFullYear()}-${String(in3.getMonth() + 1).padStart(2, "0")}-${String(in3.getDate()).padStart(2, "0")}`;

  const page1: HitsMockReservationDetail[] = [
    withId(hitsMockNormalReservationDetail, "9001001", {
      rooms: [
        {
          ...(hitsMockNormalReservationDetail.rooms?.[0] ?? {}),
          checkIn: todayIso,
          checkOut: tomorrowIso,
          code: "05",
          pax: 2,
        },
      ],
    }),
    withId(hitsMockNormalReservationDetail, "9001002", {
      contactName: "Pedro Alves",
      contact1: "pedro@example.com",
      contact2: "+55 67 99999-0002",
      rooms: [
        {
          idRoom: "106",
          code: "12",
          checkIn: tomorrowIso,
          checkOut: in3Iso,
          pax: 2,
          status: 1,
        },
      ],
      guests: [
        {
          idEntity: "G-200",
          name: "Pedro Alves",
          main: true,
          contactMail: "pedro@example.com",
          contactPhone: "+55 67 99999-0002",
        },
        {
          idEntity: "G-201",
          name: "Ana Alves",
          main: false,
        },
      ],
    }),
    withId(hitsMockCanceledReservationDetail, "9001003", {
      rooms: [
        {
          ...(hitsMockCanceledReservationDetail.rooms?.[0] ?? {}),
          checkIn: todayIso,
          checkOut: tomorrowIso,
          code: "08",
        },
      ],
    }),
  ];

  const page2: HitsMockReservationDetail[] = [
    withId(hitsMockRoomChangeNextDetail, "9001004", {
      rooms: [
        {
          ...(hitsMockRoomChangeNextDetail.rooms?.[0] ?? {}),
          checkIn: in3Iso,
          checkOut: tomorrowIso,
          code: "18",
          pax: 3,
        },
      ],
      guests: [
        {
          idEntity: "G-400",
          name: "Lucia Ferreira",
          main: true,
          contactMail: "lucia@example.com",
          contactPhone: "+55 67 98888-4000",
        },
        { idEntity: "G-401", name: "Carlos Ferreira", main: false },
        { idEntity: "G-402", name: "Filho Ferreira", main: false },
      ],
    }),
    withId(hitsMockNormalReservationDetail, "9001005", {
      contactName: "Pagamento Pendente",
      contact1: "pendente@example.com",
      contact2: null,
      rooms: [
        {
          idRoom: "110",
          code: "22",
          checkIn: todayIso,
          checkOut: in3Iso,
          pax: 1,
          status: 1,
        },
      ],
      guests: [
        {
          idEntity: "G-500",
          name: "Pagamento Pendente",
          main: true,
          contactMail: "pendente@example.com",
          contactPhone: null,
        },
      ],
      // Marcador interno simulado — NÃO é campo oficial HITS.
      __paymentSim: "pendente",
    } as HitsMockReservationDetail & { __paymentSim?: string }),
  ];

  return [...page1, ...page2];
}

/** Mutações simuladas para segunda sincronização (cenários de alteração). */
export type HitsMockSyncScenario =
  | "baseline"
  | "identical"
  | "room_change"
  | "date_change"
  | "guest_change"
  | "guest_count_up"
  | "guest_remove"
  | "payment_paid"
  | "payment_parcial"
  | "payment_unknown"
  | "phone_email_change"
  | "cancel_one";

export function applyHitsMockSyncScenario(
  catalog: HitsMockReservationDetail[],
  scenario: HitsMockSyncScenario,
): HitsMockReservationDetail[] {
  const next = catalog.map((r) => clone(r));
  const find = (id: string) => next.find((r) => String(r.idReservation) === id);

  if (scenario === "baseline" || scenario === "identical") {
    return next;
  }

  if (scenario === "room_change") {
    const r = find("9001001");
    if (r?.rooms?.[0]) r.rooms[0].code = "18";
  }

  if (scenario === "date_change") {
    const r = find("9001002");
    if (r?.rooms?.[0]) {
      r.rooms[0].checkIn = "2099-01-10";
      r.rooms[0].checkOut = "2099-01-12";
    }
  }

  if (scenario === "guest_change") {
    const r = find("9001002");
    if (r?.guests?.[0]) {
      r.guests[0].name = "Pedro Novo";
      r.contactName = "Pedro Novo";
    }
  }

  if (scenario === "guest_count_up") {
    const r = find("9001001");
    if (r) {
      r.guests = [
        ...(r.guests ?? []),
        { idEntity: "G-199", name: "Novo Acompanhante", main: false },
      ];
      if (r.rooms?.[0]) r.rooms[0].pax = 3;
    }
  }

  if (scenario === "guest_remove") {
    const r = find("9001002");
    if (r?.guests && r.guests.length > 1) {
      r.guests = r.guests.filter((g) => g.main === true);
      if (r.rooms?.[0]) r.rooms[0].pax = 1;
    }
  }

  if (
    scenario === "payment_paid" ||
    scenario === "payment_unknown" ||
    scenario === "payment_parcial"
  ) {
    // Marcador simulado interno — o normalizer lê __paymentSim (não é contrato HITS).
    const r = find("9001005");
    if (r) {
      const sim =
        scenario === "payment_paid"
          ? "pago"
          : scenario === "payment_parcial"
            ? "parcial"
            : "desconhecido";
      (r as HitsMockReservationDetail & { __paymentSim?: string }).__paymentSim = sim;
    }
  }

  if (scenario === "phone_email_change") {
    const r = find("9001001");
    if (r) {
      r.contact1 = "marina.nova@example.com";
      r.contact2 = "+55 67 91111-2222";
      if (r.guests?.[0]) {
        r.guests[0].contactMail = "marina.nova@example.com";
        r.guests[0].contactPhone = "+55 67 91111-2222";
      }
    }
  }

  if (scenario === "cancel_one") {
    const r = find("9001002");
    if (r) r.status = 2;
  }

  return next;
}

export {
  hitsMockNormalReservationDetail,
  hitsMockCanceledReservationDetail,
  hitsMockRoomChangeNextDetail,
};
