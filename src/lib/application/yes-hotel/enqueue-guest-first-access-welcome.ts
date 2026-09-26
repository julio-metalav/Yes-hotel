/**
 * Enfileira boas-vindas pós-primeiro-acesso (hóspede) — WA + e-mail.
 * Idempotente por reserva. Sem cobrança no body.
 */

import {
  buildGuestFirstAccessWelcomeMessage,
  guestFirstAccessWelcomeIdempotencyKey,
  GUEST_FIRST_ACCESS_WELCOME_EVENT,
} from "../../domain/yes-hotel/guest-access-messages.ts";
import type { AccessOutboxQueuePort } from "./first-room-access-ports.ts";
import { renderizarTemplate } from "../../domain/yes-hotel/mensagens-template.ts";

/** Chave no catalogo. Uma so: as demais mensagens ainda usam o texto do codigo. */
const TEMPLATE_BOAS_VINDAS_CHAVE = "boas_vindas_primeiro_acesso";

export type EnqueueGuestFirstAccessWelcomeInput = {
  queue: AccessOutboxQueuePort;
  reservation_id: string;
  credential_id: string | null;
  access_event_id?: string | null;
  tolerance_id?: string | null;
  guest_main_name: string;
  apartment_number: string;
  parking_spot?: string | null;
  wifi_ssid?: string | null;
  wifi_password?: string | null;
  /** Parametros que so o template usa; ausentes caem fora do texto. */
  checkout_horario?: string | null;
  telefone_recepcao?: string | null;
  data_entrada?: string | null;
  data_saida?: string | null;
  /**
   * Texto editavel. Ausente, ilegivel ou invalido: usa o texto do codigo.
   * O primeiro acesso nunca pode falhar por causa de um template.
   */
  carregarTemplate?: (chave: string) => Promise<string | null>;
  /** Diagnostico do fallback, sem PII. */
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  nowIso: string;
};

/**
 * Texto editavel quando existir; texto do codigo quando nao.
 *
 * Toda falha aqui e engolida de proposito e registrada: template ausente,
 * leitura com erro ou corpo que renderiza vazio nao podem impedir a
 * boas-vindas de sair. O pior resultado aceitavel e o hospede receber o texto
 * antigo; o inaceitavel e nao receber nada.
 */
async function resolverCorpo(
  input: EnqueueGuestFirstAccessWelcomeInput,
  padrao: { body: string; subject: string; body_html: string },
): Promise<{ body: string; subject: string; body_html: string }> {
  const log = input.log ?? (() => {});
  if (!input.carregarTemplate) return padrao;

  let corpo: string | null = null;
  try {
    corpo = await input.carregarTemplate(TEMPLATE_BOAS_VINDAS_CHAVE);
  } catch (_e) {
    log("[BOAS_VINDAS] falha ao ler template; usando texto padrao", {
      chave: TEMPLATE_BOAS_VINDAS_CHAVE,
    });
    return padrao;
  }
  if (!corpo || !corpo.trim()) return padrao;

  const render = renderizarTemplate(corpo, {
    hospede_nome: input.guest_main_name,
    apartamento: input.apartment_number,
    wifi_rede: input.wifi_ssid,
    wifi_senha: input.wifi_password,
    checkout_horario: input.checkout_horario,
    telefone_recepcao: input.telefone_recepcao,
    data_entrada: input.data_entrada,
    data_saida: input.data_saida,
  });

  if (!render.texto.trim()) {
    log("[BOAS_VINDAS] template renderizou vazio; usando texto padrao", {
      chave: TEMPLATE_BOAS_VINDAS_CHAVE,
      ausentes: render.parametros_ausentes.length,
    });
    return padrao;
  }
  if (render.parametros_desconhecidos.length > 0) {
    log("[BOAS_VINDAS] template cita parametro inexistente; linhas removidas", {
      parametros: render.parametros_desconhecidos,
    });
  }

  return {
    body: render.texto,
    subject: padrao.subject,
    body_html: render.html,
  };
}

export async function enqueueGuestFirstAccessWelcomeMessages(
  input: EnqueueGuestFirstAccessWelcomeInput,
): Promise<void> {
  const padrao = buildGuestFirstAccessWelcomeMessage({
    guest_first_name: input.guest_main_name,
    apartment_number: input.apartment_number,
    parking_spot: input.parking_spot ?? input.apartment_number,
    wifi_ssid: input.wifi_ssid,
    wifi_password: input.wifi_password,
    checkout_horario: input.checkout_horario,
    telefone_recepcao: input.telefone_recepcao,
  });

  const msg = await resolverCorpo(input, padrao);

  const base = {
    event_type: GUEST_FIRST_ACCESS_WELCOME_EVENT,
    reservation_id: input.reservation_id,
    credential_id: input.credential_id,
    access_event_id: input.access_event_id ?? null,
    tolerance_id: input.tolerance_id ?? null,
    recipient_ref: null,
    template: GUEST_FIRST_ACCESS_WELCOME_EVENT,
    status: "pending" as const,
    attempts: 0,
    available_at: input.nowIso,
    processed_at: null,
    last_error: null,
  };

  await input.queue.enqueue({
    ...base,
    channel: "whatsapp",
    payload: { body: msg.body },
    idempotency_key: guestFirstAccessWelcomeIdempotencyKey(
      input.reservation_id,
      "whatsapp",
    ),
  });
  await input.queue.enqueue({
    ...base,
    channel: "email",
    payload: { body: msg.body, subject: msg.subject, body_html: msg.body_html },
    idempotency_key: guestFirstAccessWelcomeIdempotencyKey(
      input.reservation_id,
      "email",
    ),
  });
}

/** available_at da pendência ≈ 1 minuto após o welcome. */
export function pendingMessageAvailableAt(nowIso: string, delayMs = 60_000): string {
  return new Date(Date.parse(nowIso) + delayMs).toISOString();
}
