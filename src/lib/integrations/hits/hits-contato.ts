/**
 * Contato do hóspede HITS → Yes — CELULAR OFICIAL.
 *
 * Contrato oficial (Swagger https://api.hitspms.net/swagger/v1/swagger.json):
 *  - `ReservationDetailGuestDto` (detalhe da reserva, `guests[]`) tem
 *    `idEntity`, `contactMail` e `contactPhone` — e **não** tem celular;
 *  - `GuestRevenueDto` (GET /Datashare/RevenueManagement/Guests?EntityId=…,
 *    exposto pelo gateway em `GET /v1/guests`) tem `entityId`, `contactMail`,
 *    `contactPhone` e **`contactCellPhone`**.
 *
 * Por isso o celular vem do cadastro do hóspede (guest master), nunca de
 * adivinhação sobre o telefone do detalhe. A classificação de número brasileiro
 * que existe aqui NÃO escolhe o contato: serve apenas como PROTEÇÃO, para
 * decidir se um valor local antigo (provável fixo) pode ser substituído pelo
 * celular oficial — e para nunca rebaixar um celular já gravado.
 *
 * Módulo puro: sem rede, sem banco, sem envio.
 */

import type { SyncedGuest, SyncedReservation } from "../../domain/yes-hotel/synced-reservation.ts";
import type { HitsGuestRevenue } from "./types.ts";

export type TelefoneTipoBr = "celular" | "fixo" | "desconhecido";

/** Só dígitos, sem +55 (12–13 dígitos) e sem 0 de operadora/tronco (11–12). */
export function digitosTelefoneBr(raw: unknown): string {
  let d = String(raw ?? "").replace(/\D/g, "");
  if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
  if ((d.length === 11 || d.length === 12) && d.startsWith("0")) d = d.slice(1);
  return d;
}

/**
 * Classificação de FORMATO (proteção, não escolha): DDD + 9XXXXXXXX = celular;
 * DDD + [2-5]XXXXXXX = fixo; qualquer outra coisa (inclusive número
 * estrangeiro) = desconhecido. Nunca usada para competir com
 * `contactCellPhone` explícito.
 */
export function classificarTelefoneBr(raw: unknown): TelefoneTipoBr {
  const d = digitosTelefoneBr(raw);
  if (d.length === 11 && /^[1-9][0-9]9[0-9]{8}$/.test(d)) return "celular";
  if (d.length === 10 && /^[1-9][0-9][2-5][0-9]{7}$/.test(d)) return "fixo";
  return "desconhecido";
}

function limpo(v: unknown): string {
  return String(v ?? "").trim();
}

/**
 * Contato operacional a partir do guest master (GuestRevenueDto):
 * WhatsApp = `contactCellPhone` e, só na ausência dele, `contactPhone`.
 * E-mail = `contactMail`. Nada é inferido.
 */
export function contatoOficialDoGuestRevenue(
  guest: HitsGuestRevenue | null | undefined,
): { phone: string | null; email: string | null; origem_telefone: "celular" | "telefone" | null } {
  if (!guest) return { phone: null, email: null, origem_telefone: null };
  const celular = limpo(guest.contactCellPhone);
  const telefone = limpo(guest.contactPhone);
  const email = limpo(guest.contactMail);
  if (celular) return { phone: celular, email: email || null, origem_telefone: "celular" };
  if (telefone) return { phone: telefone, email: email || null, origem_telefone: "telefone" };
  return { phone: null, email: email || null, origem_telefone: null };
}

/**
 * Registro do guest master correspondente ao `idEntity` pedido. O retorno pode
 * trazer vários registros: só serve o de `entityId` EXATAMENTE igual — nunca
 * "o primeiro".
 */
export function selecionarGuestRevenuePorEntityId(
  lista: ReadonlyArray<HitsGuestRevenue> | null | undefined,
  idEntity: unknown,
): HitsGuestRevenue | null {
  const alvo = limpo(idEntity);
  if (!alvo) return null;
  const encontrados = (lista ?? []).filter((g) => limpo(g?.entityId ?? g?.idEntity) === alvo);
  return encontrados.length === 1 ? encontrados[0]! : (encontrados[0] ?? null);
}

/**
 * Vale a pena gastar um GET de guest master por este hóspede já materializado?
 * Só quando o cadastro local pode MELHORAR: sem WhatsApp, com WhatsApp que não
 * é celular (fixo/desconhecido — candidato a ser substituído pelo celular
 * oficial) ou sem e-mail. Quem já tem celular e e-mail não gera consulta.
 */
export function precisaGuestMaster(
  local: { whatsapp?: string | null; email?: string | null } | null | undefined,
): boolean {
  const whatsapp = limpo(local?.whatsapp);
  const email = limpo(local?.email);
  if (!whatsapp) return true;
  if (classificarTelefoneBr(whatsapp) !== "celular") return true;
  return !email;
}

/**
 * Aplica o contato oficial do guest master sobre os hóspedes do detalhe já
 * normalizado. Só mexe em `phone`/`email` e só quando o guest master trouxe
 * valor; hóspede sem registro correspondente fica com o fallback do detalhe
 * (`contactPhone`/`contactMail`). Devolve uma cópia: nada é mutado.
 */
export function aplicarContatoOficialNaReserva(
  synced: SyncedReservation,
  porEntityId: ReadonlyMap<string, HitsGuestRevenue>,
): SyncedReservation {
  if (porEntityId.size === 0) return synced;
  let mudou = false;
  const guests: SyncedGuest[] = (synced.guests ?? []).map((g) => {
    const idEntity = limpo(g.externalGuestId);
    const master = idEntity ? porEntityId.get(idEntity) : undefined;
    if (!master) return g;
    const oficial = contatoOficialDoGuestRevenue(master);
    if (!oficial.phone && !oficial.email) return g;
    mudou = true;
    return {
      ...g,
      phone: oficial.phone ?? g.phone,
      email: oficial.email ?? g.email,
      // Marca a procedência: só `cell` autoriza substituir um fixo já gravado.
      phoneSource: oficial.phone ? (oficial.origem_telefone === "celular" ? "cell" : "phone") : g.phoneSource,
    };
  });
  if (!mudou) return synced;
  const principal = guests.find((g) => g.isPrincipal) ?? guests[0] ?? null;
  return {
    ...synced,
    guests,
    phone: principal?.phone ?? synced.phone,
    email: principal?.email ?? synced.email,
  };
}

function mesmoTelefone(a: unknown, b: unknown): boolean {
  const da = digitosTelefoneBr(a);
  const db = digitosTelefoneBr(b);
  if (da.length > 0 && da === db) return true;
  return limpo(a).toLowerCase() === limpo(b).toLowerCase() && limpo(a) !== "";
}

/**
 * WhatsApp de hóspede JÁ materializado: devolve o novo valor ou null (no-op).
 * `origemCelular` = o valor veio de `contactCellPhone` (celular oficial).
 * - local vazio → preenche;
 * - local é fixo e o HITS trouxe o CELULAR OFICIAL → substitui;
 * - local é celular → nunca rebaixa (nem para fixo, nem para outro celular);
 * - mesmo número → no-op;
 * - local de formato desconhecido (não vazio) → não mexe: pode ser edição
 *   manual ou número estrangeiro e não há coluna de origem no schema.
 */
export function decidirWhatsappExistente(
  local: unknown,
  hits: unknown,
  origemCelular = false,
): string | null {
  const atual = limpo(local);
  const novo = limpo(hits);
  if (!novo) return null;
  if (!atual) return novo;
  if (mesmoTelefone(atual, novo)) return null;
  const tipoAtual = classificarTelefoneBr(atual);
  if (tipoAtual !== "fixo") return null;
  // Só sobe para celular: oficial (`contactCellPhone`) ou, na ausência de
  // origem declarada, um número que comprovadamente é celular brasileiro.
  if (origemCelular || classificarTelefoneBr(novo) === "celular") return novo;
  return null;
}

/**
 * E-mail de hóspede JÁ materializado: só preenche quando o local está vazio e o
 * HITS trouxe um e-mail plausível. E-mail local já preenchido nunca é
 * sobrescrito automaticamente (não há coluna de origem que prove a procedência).
 */
export function decidirEmailExistente(local: unknown, hits: unknown): string | null {
  const atual = limpo(local);
  const novo = limpo(hits);
  if (!novo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(novo)) return null;
  if (!atual) return novo;
  return null;
}
