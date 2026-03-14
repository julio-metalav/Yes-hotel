import type { AccessTarget } from "./types";

interface BlockLayout {
  blockCode: string;
  apartmentStart: number;
  apartmentEnd: number;
  gateCode: string;
}

const HOTEL_BLOCKS: BlockLayout[] = [
  {
    blockCode: "BLOCO_1",
    apartmentStart: 1,
    apartmentEnd: 20,
    gateCode: "1947",
  },
  {
    blockCode: "BLOCO_2",
    apartmentStart: 21,
    apartmentEnd: 40,
    gateCode: "1967",
  },
];

export function normalizeApartmentCode(apartmentCode: string): string {
  const numeric = Number(apartmentCode);

  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 40) {
    throw new Error(
      `Apartamento invalido para o layout mockado do hotel: ${apartmentCode}`,
    );
  }

  return String(numeric).padStart(2, "0");
}

export function resolveBlockLayoutByApartment(apartmentCode: string): BlockLayout {
  const normalizedApartmentCode = normalizeApartmentCode(apartmentCode);
  const apartmentNumber = Number(normalizedApartmentCode);
  const block = HOTEL_BLOCKS.find(
    (entry) =>
      apartmentNumber >= entry.apartmentStart &&
      apartmentNumber <= entry.apartmentEnd,
  );

  if (!block) {
    throw new Error(
      `Nao foi possivel resolver bloco para o apartamento ${normalizedApartmentCode}.`,
    );
  }

  return block;
}

export function getAccessTargetsForApartment(apartmentCode: string): AccessTarget[] {
  const normalizedApartmentCode = normalizeApartmentCode(apartmentCode);
  const block = resolveBlockLayoutByApartment(normalizedApartmentCode);

  return [
    {
      type: "apartment_lock",
      blockCode: block.blockCode,
      apartmentCode: normalizedApartmentCode,
      targetCode: `APT-${normalizedApartmentCode}`,
    },
    {
      type: "block_gate_external",
      blockCode: block.blockCode,
      targetCode: `GATE-${block.gateCode}-EXTERNAL`,
    },
    {
      type: "block_gate_internal",
      blockCode: block.blockCode,
      targetCode: `GATE-${block.gateCode}-INTERNAL`,
    },
  ];
}

export function getHotelBlocks(): ReadonlyArray<BlockLayout> {
  return HOTEL_BLOCKS;
}
