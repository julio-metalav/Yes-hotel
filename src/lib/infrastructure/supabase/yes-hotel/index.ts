import type { SupabaseClient } from "@supabase/supabase-js";
import type { FirstRoomAccessPorts } from "../../../application/yes-hotel/first-room-access-ports.ts";
import { SupabaseAccessEventRepository } from "./access-event-repository.ts";
import { SupabaseAccessToleranceRepository } from "./access-tolerance-repository.ts";
import { SupabaseCommunicationOutboxPort } from "./communication-outbox.ts";
import { SupabaseCredentialCorrelationPort } from "./credential-correlation.ts";
import { SupabaseCredentialItemsPort } from "./credential-items.ts";
import { SupabaseAccessOutboxQueuePort } from "./access-outbox-queue.ts";
import {
  SupabaseFirstRoomAccessUnitOfWork,
  SystemClock,
} from "./first-room-access-unit-of-work.ts";
import { SupabaseReservationPendingStatePort } from "./reservation-pending-state.ts";
import { SupabasePresencialDiferidoAuditPort } from "./presencial-diferido-audit.ts";
import { isPagamentoPresencialDiferidoServerEnabled } from "../../../domain/yes-hotel/pagamento-presencial-diferido.ts";

/**
 * Configuracao operacional do hotel exibida ao hospede.
 *
 * Vive em `hotel_operacao_config`, editavel em Configuracoes -- do mesmo jeito
 * que o Wi-Fi e a geolocalizacao. Nao ha valor padrao no codigo de proposito:
 * repetir o horario ou o telefone aqui recriaria a segunda fonte de verdade
 * que a tabela veio eliminar.
 */
type HotelOperacaoConfig = {
  checkout_horario: string | null;
  telefone_recepcao: string | null;
};

const CONFIG_OPERACAO_VAZIA: HotelOperacaoConfig = {
  checkout_horario: null,
  telefone_recepcao: null,
};

/**
 * Fail-soft: leitura com erro ou tabela ainda nao provisionada devolve nulos.
 * O motor de template remove a linha inteira que cita um parametro ausente,
 * sem deixar linha orfa -- uma mensagem com uma linha a menos e melhor que
 * uma mensagem com telefone errado, e muito melhor que nenhuma mensagem.
 */
async function lerHotelOperacaoConfig(
  client: SupabaseClient,
): Promise<HotelOperacaoConfig> {
  const { data, error } = await client
    .from("hotel_operacao_config")
    .select("checkout_horario, telefone_recepcao")
    .eq("id", true)
    .maybeSingle();
  if (error || !data) return CONFIG_OPERACAO_VAZIA;
  const row = data as { checkout_horario?: unknown; telefone_recepcao?: unknown };
  return {
    checkout_horario: String(row.checkout_horario ?? "").trim() || null,
    telefone_recepcao: String(row.telefone_recepcao ?? "").trim() || null,
  };
}

/** `2026-08-11` -> `11/08/2026`. Vazio quando a data nao vier. */
function formatarDataBr(valor: unknown): string | null {
  const ymd = String(valor ?? "").slice(0, 10);
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

export function createSupabaseFirstRoomAccessPorts(
  client: SupabaseClient,
  env?: Record<string, string | undefined> | null,
): FirstRoomAccessPorts {
  // Uma leitura por instancia de ports (uma por invocacao da Edge): o
  // contexto pode ser montado mais de uma vez no mesmo ciclo.
  let configOperacao: Promise<HotelOperacaoConfig> | null = null;
  const carregarConfigOperacao = (): Promise<HotelOperacaoConfig> => {
    if (configOperacao == null) {
      configOperacao = lerHotelOperacaoConfig(client).catch(
        () => CONFIG_OPERACAO_VAZIA,
      );
    }
    return configOperacao;
  };

  return {
    events: new SupabaseAccessEventRepository(client),
    correlation: new SupabaseCredentialCorrelationPort(client),
    pending: new SupabaseReservationPendingStatePort(client),
    tolerances: new SupabaseAccessToleranceRepository(client),
    items: new SupabaseCredentialItemsPort(client),
    outbox: new SupabaseCommunicationOutboxPort(client),
    clock: new SystemClock(),
    uow: new SupabaseFirstRoomAccessUnitOfWork(client),
    accessOutboxQueue: new SupabaseAccessOutboxQueuePort(client),
    reservationDisplay: {
      async getContext(reservationId: string) {
        const { data: r } = await client
          .from("operacional_reservas")
          .select("apartamento, hospede_principal, external_reservation_id, check_in_previsto, check_out_previsto")
          .eq("id", reservationId)
          .maybeSingle();
        const external = String(r?.external_reservation_id ?? "").trim();
        const apartment_number = String(r?.apartamento ?? "—");
        let wifi_ssid: string | null = null;
        let wifi_password: string | null = null;
        const aptNum = apartment_number.trim();
        if (aptNum && aptNum !== "—") {
          const { data: apt } = await client
            .from("apartamentos")
            .select("wifi_ssid, wifi_password")
            .eq("numero", aptNum)
            .maybeSingle();
          wifi_ssid = apt?.wifi_ssid != null ? String(apt.wifi_ssid) : null;
          wifi_password = apt?.wifi_password != null ? String(apt.wifi_password) : null;
        }
        const operacao = await carregarConfigOperacao();
        return {
          apartment_number,
          reservation_code: external || "—",
          guest_main_name: String(r?.hospede_principal ?? "hóspede"),
          // Sem campo de vaga dedicado: usa o número do apartamento.
          parking_spot: aptNum && aptNum !== "—" ? aptNum : null,
          wifi_ssid,
          wifi_password,
          // Configuracao do hotel, resolvida aqui e nao no template: editar o
          // texto da mensagem nao pode alterar horario de check-out nem
          // telefone da recepcao. O template so cita o parametro.
          checkout_horario: operacao.checkout_horario,
          telefone_recepcao: operacao.telefone_recepcao,
          data_entrada: formatarDataBr(r?.check_in_previsto),
          data_saida: formatarDataBr(r?.check_out_previsto),
        };
      },
    },
    mensagensTemplates: {
      async carregar(chave: string) {
        // Fail-soft: qualquer problema devolve null e o envio usa o texto do
        // codigo. Um template nao pode derrubar o primeiro acesso.
        const { data, error } = await client
          .from("operacional_mensagens_templates")
          .select("corpo")
          .eq("chave", chave)
          .maybeSingle();
        if (error || !data) return null;
        const corpo = String((data as { corpo?: unknown }).corpo ?? "").trim();
        return corpo || null;
      },
    },
    presencialDiferidoAudit: new SupabasePresencialDiferidoAuditPort(client),
    presencialDiferidoFeatureEnabled: isPagamentoPresencialDiferidoServerEnabled(env ?? null),
  };
}

export * from "./access-event-repository.ts";
export * from "./access-outbox-queue.ts";
export * from "./access-tolerance-repository.ts";
export * from "./cobranca-pagarme-repository.ts";
export * from "./credential-correlation.ts";
export * from "./credential-correlation-logic.ts";
export * from "./reservation-pending-state.ts";
export * from "./reservation-pending-mapper.ts";
export * from "./credential-items.ts";
export * from "./communication-outbox.ts";
export * from "./first-room-access-unit-of-work.ts";
export * from "./supabase-reservation-sync-repository.ts";
export * from "./fake-reservation-sync-client.ts";
export * from "./presencial-diferido-audit.ts";
