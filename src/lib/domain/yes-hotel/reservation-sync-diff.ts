/**
 * Diff de sincronização — gera eventos append-only apenas com mudança real.
 * Detalhes sem telefone/e-mail completos.
 */

import type { SyncedReservation } from "./synced-reservation";

export type ReservationChangeEvent = {
  tipo: string;
  titulo: string;
  detalhe: string;
};

export type SyncedReservationSnapshot = {
  externalReservationId: string;
  reservationStatus: SyncedReservation["reservationStatus"];
  checkIn: string;
  checkOut: string;
  apartmentCode: string;
  mainGuestName: string;
  totalGuests: number;
  paymentStatus: SyncedReservation["paymentStatus"];
  phone: string | null;
  email: string | null;
  guestIds: string[];
};

export function toSnapshot(r: SyncedReservation): SyncedReservationSnapshot {
  return {
    externalReservationId: r.externalReservationId,
    reservationStatus: r.reservationStatus,
    checkIn: r.checkIn,
    checkOut: r.checkOut,
    apartmentCode: r.apartmentCode,
    mainGuestName: r.mainGuestName,
    totalGuests: r.totalGuests,
    paymentStatus: r.paymentStatus,
    phone: r.phone,
    email: r.email,
    guestIds: r.guests
      .map((g) => g.externalGuestId)
      .filter((id): id is string => Boolean(id))
      .sort(),
  };
}

/**
 * Compara snapshot persistido com reserva normalizada.
 * Retorna [] se idêntico (idempotência de eventos).
 */
export function detectReservationChanges(
  previous: SyncedReservationSnapshot | null,
  next: SyncedReservation,
): ReservationChangeEvent[] {
  if (!previous) {
    return [
      {
        tipo: "hits_reserva_criada",
        titulo: "Reserva sincronizada",
        detalhe: `Reserva ${next.externalReservationId} criada a partir da origem HITS (simulada).`,
      },
    ];
  }

  const events: ReservationChangeEvent[] = [];
  const snap = toSnapshot(next);

  if (previous.reservationStatus !== snap.reservationStatus) {
    if (snap.reservationStatus === "cancelada") {
      events.push({
        tipo: "hits_reserva_cancelada",
        titulo: "Reserva cancelada",
        detalhe: "Reserva cancelada na origem",
      });
    } else if (previous.reservationStatus === "cancelada" && snap.reservationStatus === "ativa") {
      events.push({
        tipo: "hits_reserva_reativada",
        titulo: "Reserva reativada",
        detalhe: "Reserva reativada na origem",
      });
    }
  }

  if (previous.apartmentCode !== snap.apartmentCode) {
    events.push({
      tipo: "hits_apartamento_alterado",
      titulo: "Apartamento alterado",
      detalhe: `Apartamento alterado: ${previous.apartmentCode || "—"} → ${snap.apartmentCode || "—"}`,
    });
  }

  if (previous.checkIn !== snap.checkIn) {
    events.push({
      tipo: "hits_checkin_alterado",
      titulo: "Chegada alterada",
      detalhe: `Chegada alterada: ${previous.checkIn} → ${snap.checkIn}`,
    });
  }

  if (previous.checkOut !== snap.checkOut) {
    events.push({
      tipo: "hits_checkout_alterado",
      titulo: "Saída alterada",
      detalhe: `Saída alterada: ${previous.checkOut} → ${snap.checkOut}`,
    });
  }

  if (previous.mainGuestName !== snap.mainGuestName) {
    events.push({
      tipo: "hits_hospede_principal_alterado",
      titulo: "Hóspede principal alterado",
      detalhe: `Hóspede principal alterado: ${previous.mainGuestName || "—"} → ${snap.mainGuestName || "—"}`,
    });
  }

  if (previous.totalGuests !== snap.totalGuests) {
    events.push({
      tipo: "hits_quantidade_hospedes_alterada",
      titulo: "Quantidade de hóspedes alterada",
      detalhe: `Quantidade de hóspedes alterada: ${previous.totalGuests} → ${snap.totalGuests}`,
    });
  }

  if (previous.paymentStatus !== snap.paymentStatus) {
    events.push({
      tipo: "hits_pagamento_alterado",
      titulo: "Pagamento alterado",
      detalhe: `Pagamento alterado: ${previous.paymentStatus} → ${snap.paymentStatus}`,
    });
  }

  if ((previous.phone || "") !== (snap.phone || "")) {
    events.push({
      tipo: "hits_telefone_alterado",
      titulo: "Telefone alterado",
      detalhe: "Telefone do hóspede atualizado",
    });
  }

  if ((previous.email || "") !== (snap.email || "")) {
    events.push({
      tipo: "hits_email_alterado",
      titulo: "E-mail alterado",
      detalhe: "E-mail do hóspede atualizado",
    });
  }

  const prevGuests = previous.guestIds.join(",");
  const nextGuests = snap.guestIds.join(",");
  if (prevGuests !== nextGuests) {
    events.push({
      tipo: "hits_hospedes_alterados",
      titulo: "Lista de hóspedes alterada",
      detalhe: "Composição de hóspedes alterada na origem",
    });
  }

  return events;
}
