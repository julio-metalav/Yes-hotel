import type { LockLogicalType } from "../../../domain/yes-hotel/first-room-access-policy.ts";

/** Classifica destino lógico APT-/GATE-*-EXTERNAL/INTERNAL. */
export function classifyLogicalDestination(codigo: string): LockLogicalType | "other" {
  const d = String(codigo ?? "").trim().toUpperCase();
  if (d.startsWith("APT-") || d.startsWith("APTO-")) return "apartamento";
  if (d.includes("EXTERNAL") || (d.includes("GATE") && d.includes("EXT"))) return "portao_externo";
  if (d.includes("INTERNAL") || (d.includes("GATE") && d.includes("INT"))) return "portao_interno";
  if (d.includes("PORTAO") && d.includes("EXT")) return "portao_externo";
  if (d.includes("PORTAO") && d.includes("INT")) return "portao_interno";
  return "other";
}
