/**
 * Template canônico: orientação de pagamento presencial no café (PPD efetivado).
 * Sem I/O. Prazo vem do deadline real do PPD — nunca inventado.
 */

import {
  addCalendarDaysYmd,
  utcIsoToHotelLocalParts,
} from "./pagamento-presencial-diferido.ts";

export const GUEST_PAYMENT_DEFERRED_BREAKFAST_EVENT =
  "guest_payment_deferred_breakfast" as const;

export type GuestPaymentDeferredBreakfastMessage = {
  kind: typeof GUEST_PAYMENT_DEFERRED_BREAKFAST_EVENT;
  body: string;
  subject: string;
  body_html: string;
};

function escHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatYmdPtBrShort(ymd: string): string {
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd;
  return `${m[3]}/${m[2]}`;
}

/**
 * Frase de prazo a partir do deadline real (hotel local).
 * "até às 09h de amanhã" só quando o deadline é o dia civil seguinte ao now.
 */
export function formatPpdDeadlineGuestPhrase(
  deadlineIso: string,
  nowIso: string,
): { phrase: string; deadlineLocalYmd: string; usesAmanha: boolean } {
  const deadline = utcIsoToHotelLocalParts(deadlineIso);
  const now = utcIsoToHotelLocalParts(nowIso);
  const tomorrow = addCalendarDaysYmd(now.ymd, 1);
  const usesAmanha = deadline.ymd === tomorrow;
  const phrase = usesAmanha
    ? "até às 09h de amanhã"
    : `até às 09h de ${formatYmdPtBrShort(deadline.ymd)}`;
  return { phrase, deadlineLocalYmd: deadline.ymd, usesAmanha };
}

export function buildGuestPaymentDeferredBreakfastMessage(input: {
  deadlineIso: string;
  nowIso: string;
}): GuestPaymentDeferredBreakfastMessage {
  const { phrase, usesAmanha } = formatPpdDeadlineGuestPhrase(
    input.deadlineIso,
    input.nowIso,
  );

  const whenLine = usesAmanha
    ? `Amanhã, durante o café da manhã, procure nossa equipe para realizar o pagamento ${phrase}.`
    : `Durante o café da manhã, procure nossa equipe para realizar o pagamento ${phrase}.`;

  const body = [
    "💳 Pagamento presencial pendente",
    "",
    "O pagamento da sua hospedagem deverá ser realizado presencialmente.",
    "",
    whenLine,
    "",
    "☕ O café da manhã é servido das 06h às 09h.",
    'Siga as placas "Restaurante" no prédio.',
    "",
    "Caso não vá tomar café da manhã, fale conosco por este WhatsApp para regularizar o pagamento antes das 09h.",
    "",
    "Após esse horário, se o pagamento ainda estiver pendente, os acessos poderão ser temporariamente suspensos.",
    "",
    "Se precisar de ajuda, fale conosco por aqui.",
  ].join("\n");

  const body_html = [
    "<p><strong>💳 Pagamento presencial pendente</strong></p>",
    "<p>O pagamento da sua hospedagem deverá ser realizado presencialmente.</p>",
    `<p>${escHtml(whenLine)}</p>`,
    "<p>☕ O café da manhã é servido das 06h às 09h.<br/>Siga as placas “Restaurante” no prédio.</p>",
    "<p>Caso não vá tomar café da manhã, fale conosco por este WhatsApp para regularizar o pagamento antes das 09h.</p>",
    "<p>Após esse horário, se o pagamento ainda estiver pendente, os acessos poderão ser temporariamente suspensos.</p>",
    "<p>Se precisar de ajuda, fale conosco por aqui.</p>",
  ].join("\n");

  return {
    kind: GUEST_PAYMENT_DEFERRED_BREAKFAST_EVENT,
    body,
    subject: "Yes Hotel — pagamento presencial no café da manhã",
    body_html,
  };
}

export function guestPaymentDeferredBreakfastIdempotencyKey(
  reservationId: string,
  channel: "whatsapp" | "email",
): string {
  const base = `${GUEST_PAYMENT_DEFERRED_BREAKFAST_EVENT}:${reservationId}`;
  return channel === "email" ? `${base}:email` : base;
}
