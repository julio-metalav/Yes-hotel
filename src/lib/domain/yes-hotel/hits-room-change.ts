/**
 * Troca de apartamento na mesma reserva HITS.
 * Compara códigos canônicos (01–40). Não decide TTLock: só diz se a
 * reconciliação precisa acontecer e quais fechaduras lógicas saem ou ficam.
 */

import { normalizeApartmentCode, resolveBlockLayoutByApartment } from "./hotel-layout.ts";

export function canonicalApartmentCode(raw: string | null | undefined): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    return normalizeApartmentCode(text);
  } catch {
    return null;
  }
}

/** APT-NN e os dois portões do bloco. O mesmo conjunto que o lifecycle já grava nos itens. */
export function accessCodesForApartment(apartmentCode: string): string[] {
  const norm = normalizeApartmentCode(apartmentCode);
  const gate = resolveBlockLayoutByApartment(norm).gateCode;
  return [`APT-${norm}`, `GATE-${gate}-EXTERNAL`, `GATE-${gate}-INTERNAL`];
}

export type DecisaoTrocaApartamento =
  | { acao: "noop" }
  | { acao: "atualizar"; de: string; para: string };

/**
 * Só age quando os dois lados são apartamentos válidos e diferentes.
 * Lado local vazio não é troca: é reserva ainda sem quarto, fora deste fluxo.
 */
export function decidirTrocaApartamento(input: {
  apartamentoLocal: string | null | undefined;
  apartamentoHits: string | null | undefined;
}): DecisaoTrocaApartamento {
  const de = canonicalApartmentCode(input.apartamentoLocal);
  const para = canonicalApartmentCode(input.apartamentoHits);
  if (!de || !para || de === para) return { acao: "noop" };
  return { acao: "atualizar", de, para };
}
