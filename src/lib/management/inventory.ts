/**
 * Inventário para ocupação/RevPAR.
 * Default 40 aptos (layout atual 1–40). Bloqueios futuros reduzem disponíveis.
 */

export const DEFAULT_SELLABLE_ROOMS = 40;

export type InventoryDay = {
  stayDate: string;
  sellableRooms: number;
  blockedRooms: number;
};

export function availableRoomsOnDay(input: {
  sellableRooms?: number;
  blockedRooms?: number;
}): number {
  const sellable = input.sellableRooms ?? DEFAULT_SELLABLE_ROOMS;
  const blocked = input.blockedRooms ?? 0;
  if (!Number.isInteger(sellable) || sellable < 0) {
    throw new Error("sellableRooms inválido");
  }
  if (!Number.isInteger(blocked) || blocked < 0) {
    throw new Error("blockedRooms inválido");
  }
  const available = sellable - blocked;
  return available > 0 ? available : 0;
}

export function availableRoomNights(days: InventoryDay[]): number {
  return days.reduce(
    (sum, day) =>
      sum +
      availableRoomsOnDay({
        sellableRooms: day.sellableRooms,
        blockedRooms: day.blockedRooms,
      }),
    0,
  );
}

export function inventoryRange(input: {
  stayDates: string[];
  sellableRooms?: number;
  blockedByDate?: Record<string, number>;
}): InventoryDay[] {
  const sellable = input.sellableRooms ?? DEFAULT_SELLABLE_ROOMS;
  return input.stayDates.map((stayDate) => ({
    stayDate,
    sellableRooms: sellable,
    blockedRooms: input.blockedByDate?.[stayDate] ?? 0,
  }));
}
