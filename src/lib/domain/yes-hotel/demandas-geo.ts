/**
 * Geolocalização operacional de Demandas (Haversine no backend de domínio).
 * O navegador não é fonte de verdade do resultado.
 */

export const DEMANDAS_DEFAULT_RAIO_METROS = 200;
export const EARTH_RADIUS_METERS = 6_371_000;

export type DemandasGeoConfig = {
  latitude: number;
  longitude: number;
  raio_metros: number;
};

export type DemandasGeoCheckInput = {
  latitude: number;
  longitude: number;
  precisao_metros: number | null;
  sem_local_especifico: boolean;
  config: DemandasGeoConfig | null;
};

export type DemandasGeoCheckResult = {
  required: boolean;
  approved: boolean;
  distance_meters: number | null;
  raio_metros: number | null;
  code:
    | "dispensada"
    | "aprovada"
    | "recusada"
    | "nao_configurada"
    | "coordenada_invalida";
  message?: string;
};

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function assertLatitude(value: number): void {
  if (!Number.isFinite(value) || value < -90 || value > 90) {
    throw new Error("demandas_latitude_invalida");
  }
}

export function assertLongitude(value: number): void {
  if (!Number.isFinite(value) || value < -180 || value > 180) {
    throw new Error("demandas_longitude_invalida");
  }
}

export function assertRaioMetros(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("demandas_raio_invalido");
  }
}

export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  assertLatitude(lat1);
  assertLatitude(lat2);
  assertLongitude(lon1);
  assertLongitude(lon2);

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function evaluateDemandasGeoCheck(
  input: DemandasGeoCheckInput,
): DemandasGeoCheckResult {
  if (input.sem_local_especifico) {
    return {
      required: false,
      approved: true,
      distance_meters: null,
      raio_metros: input.config?.raio_metros ?? null,
      code: "dispensada",
    };
  }

  if (!input.config) {
    return {
      required: true,
      approved: false,
      distance_meters: null,
      raio_metros: null,
      code: "nao_configurada",
      message:
        "Geolocalização do hotel ainda não foi configurada. Peça a um admin para definir latitude, longitude e raio.",
    };
  }

  try {
    assertLatitude(input.latitude);
    assertLongitude(input.longitude);
  } catch {
    return {
      required: true,
      approved: false,
      distance_meters: null,
      raio_metros: input.config.raio_metros,
      code: "coordenada_invalida",
      message: "Coordenadas de geolocalização inválidas.",
    };
  }

  const distance = haversineMeters(
    input.latitude,
    input.longitude,
    input.config.latitude,
    input.config.longitude,
  );
  const approved = distance <= input.config.raio_metros;

  return {
    required: true,
    approved,
    distance_meters: distance,
    raio_metros: input.config.raio_metros,
    code: approved ? "aprovada" : "recusada",
    message: approved
      ? undefined
      : `Fora do raio permitido (${Math.round(distance)} m > ${input.config.raio_metros} m).`,
  };
}
