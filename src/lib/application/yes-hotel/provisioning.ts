/**
 * Módulo de provisionamento de acesso (Fase TTLock 1).
 * Resolve reserva -> destinos com lock_id real e monta plano persistível.
 * Não chama API TTLock; apenas prepara dados para persistência.
 */

import {
  calculateCredentialWindow,
  getAccessTargetsForApartment,
  normalizeApartmentCode,
} from "../../domain/yes-hotel.ts";
import type { CredentialWindow } from "../../domain/yes-hotel.ts";
import type { ReservationAdjustment } from "../../domain/yes-hotel.ts";
import type {
  FechaduraRow,
  OperacionalMotivoOrigem,
  ProvisioningDestination,
  ProvisioningPlanToPersist,
} from "./types.ts";

/** Mapeia source da janela (domínio) para motivo_origem (persistência). */
export function mapWindowSourceToMotivoOrigem(
  source: CredentialWindow["source"],
): OperacionalMotivoOrigem {
  switch (source) {
    case "early_checkin":
      return "early_checkin";
    case "late_checkout":
      return "late_checkout";
    case "manual_combined":
      return "manual_adjustment";
    default:
      return "checkin_normal";
  }
}

/** Gera código lógico do destino a partir da fechadura. */
function codigoLogicoFromFechadura(f: FechaduraRow): string {
  if (f.tipo_fechadura === "apartamento" && f.apartamento_numero) {
    return `APT-${String(f.apartamento_numero).padStart(2, "0")}`;
  }
  if (f.tipo_fechadura === "portao_externo" && f.portao_identificador) {
    return `GATE-${f.portao_identificador}-EXTERNAL`;
  }
  if (f.tipo_fechadura === "portao_interno" && f.portao_identificador) {
    return `GATE-${f.portao_identificador}-INTERNAL`;
  }
  return "UNKNOWN";
}

/**
 * Resolve destinos de provisionamento com lock_id real a partir dos targets
 * lógicos e da lista de fechaduras (vinda do banco).
 */
export function resolveDestinationsFromFechaduras(
  apartmentCode: string,
  fechaduras: FechaduraRow[],
): ProvisioningDestination[] {
  const normalized = normalizeApartmentCode(apartmentCode);
  const targets = getAccessTargetsForApartment(normalized);
  const destinations: ProvisioningDestination[] = [];

  for (const target of targets) {
    const fechadura = fechaduras.find((f) => {
      const codigo = codigoLogicoFromFechadura(f);
      return codigo === target.targetCode;
    });
    if (fechadura) {
      destinations.push({
        fechaduraId: fechadura.id,
        lockIdTtlock: fechadura.identificador_externo_ttlock,
        tipoDestino: fechadura.tipo_fechadura,
        codigoLogicoDestino: codigoLogicoFromFechadura(fechadura),
      });
    }
  }

  return destinations;
}

/** Dados mínimos da reserva operacional para gerar o plano. */
export interface ReservaOperacionalMinima {
  apartamento: string;
  checkInPrevisto: string | Date;
  checkOutPrevisto: string | Date;
}

/**
 * Gera o plano de provisionamento de acesso para persistência.
 * Usa janela padrão (check-in 13:00, check-out 11:00) e aceita ajuste (early/late).
 */
export function buildProvisioningPlanToPersist(
  reserva: ReservaOperacionalMinima,
  fechaduras: FechaduraRow[],
  adjustment?: ReservationAdjustment,
): ProvisioningPlanToPersist {
  const apartmentCode = normalizeApartmentCode(reserva.apartamento);
  const window = calculateCredentialWindow(
    {
      reservationId: "",
      guestMainName: "",
      apartmentCode,
      checkIn: reserva.checkInPrevisto,
      checkOut: reserva.checkOutPrevisto,
      status: "confirmed",
    },
    adjustment,
  );
  const motivoOrigem = mapWindowSourceToMotivoOrigem(window.source);
  const destinations = resolveDestinationsFromFechaduras(apartmentCode, fechaduras);

  return {
    validoDe: window.validFrom,
    validoAte: window.validTo,
    motivoOrigem,
    destinations,
  };
}
