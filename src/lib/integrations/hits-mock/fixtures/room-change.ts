import type { HitsMockReservationDetail } from "../types";

export const hitsMockRoomChangePreviousDetail: HitsMockReservationDetail = {
  idReservation: "9002001",
  dateAdd: "2026-03-18T08:00:00-03:00",
  dateUp: "2026-03-19T07:45:00-03:00",
  contactName: "Carlos Menezes",
  contact1: "carlos.menezes@example.com",
  contact2: "+55 21 97777-2222",
  status: 1,
  rooms: [
    {
      idRoom: "110",
      code: "10",
      checkIn: "2026-03-20",
      checkOut: "2026-03-23",
      roomTypeName: "Apartamento Standard",
      status: 1,
      pax: 2,
      reservationRoomId: "RRM-9002001-1A",
    },
  ],
  guests: [
    {
      idEntity: "G-200",
      name: "Carlos Menezes",
      idRoom: "110",
      contactMail: "carlos.menezes@example.com",
      contactPhone: "+55 21 97777-2222",
      main: true,
      documentType: "CPF",
    },
  ],
};

export const hitsMockRoomChangeNextDetail: HitsMockReservationDetail = {
  idReservation: "9002001",
  dateAdd: "2026-03-18T08:00:00-03:00",
  dateUp: "2026-03-20T10:15:00-03:00",
  contactName: "Carlos Menezes",
  contact1: "carlos.menezes@example.com",
  contact2: "+55 21 97777-2222",
  status: 1,
  rooms: [
    {
      idRoom: "224",
      code: "24",
      checkIn: "2026-03-20",
      checkOut: "2026-03-23",
      roomTypeName: "Apartamento Standard",
      status: 1,
      pax: 2,
      reservationRoomId: "RRM-9002001-1B",
    },
  ],
  guests: [
    {
      idEntity: "G-200",
      name: "Carlos Menezes",
      idRoom: "224",
      contactMail: "carlos.menezes@example.com",
      contactPhone: "+55 21 97777-2222",
      main: true,
      documentType: "CPF",
    },
  ],
};
