import type { HitsMockReservationDetail } from "../types.ts";

export const hitsMockNormalReservationDetail: HitsMockReservationDetail = {
  idReservation: "9001001",
  dateAdd: "2026-03-18T08:00:00-03:00",
  dateUp: "2026-03-19T09:30:00-03:00",
  contactName: "Marina Lopes",
  contact1: "marina.lopes@example.com",
  contact2: "+55 11 98888-1111",
  status: 1,
  rooms: [
    {
      idRoom: "105",
      code: "05",
      checkIn: "2026-03-20",
      checkOut: "2026-03-23",
      roomTypeName: "Apartamento Standard",
      status: 1,
      pax: 2,
      reservationRoomId: "RRM-9001001-1",
    },
  ],
  guests: [
    {
      idEntity: "G-100",
      name: "Marina Lopes",
      idRoom: "105",
      contactMail: "marina.lopes@example.com",
      contactPhone: "+55 11 98888-1111",
      main: true,
      documentType: "CPF",
    },
    {
      idEntity: "G-101",
      name: "Acompanhante Teste",
      idRoom: "105",
      main: false,
      documentType: "CPF",
    },
  ],
};
