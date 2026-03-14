import type { HitsMockReservationDetail } from "../types";

export const hitsMockCanceledReservationDetail: HitsMockReservationDetail = {
  idReservation: "9003001",
  dateAdd: "2026-03-18T08:00:00-03:00",
  dateUp: "2026-03-20T11:20:00-03:00",
  contactName: "Fernanda Rocha",
  contact1: "fernanda.rocha@example.com",
  contact2: "+55 31 96666-3333",
  status: 2,
  rooms: [
    {
      idRoom: "231",
      code: "31",
      checkIn: "2026-03-20",
      checkOut: "2026-03-23",
      roomTypeName: "Apartamento Standard",
      status: 2,
      pax: 1,
      reservationRoomId: "RRM-9003001-1",
    },
  ],
  guests: [
    {
      idEntity: "G-300",
      name: "Fernanda Rocha",
      idRoom: "231",
      contactMail: "fernanda.rocha@example.com",
      contactPhone: "+55 31 96666-3333",
      main: true,
      documentType: "CPF",
    },
  ],
};
