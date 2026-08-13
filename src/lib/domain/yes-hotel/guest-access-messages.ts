/**
 * Templates canônicos: acesso pré-chegada e boas-vindas pós-entrada.
 * Sem I/O. Wi-Fi nunca entra como chave JSON "senha"/"password" no payload —
 * o dispatcher monta o bloco a partir de campos resolvidos.
 */

import { formatTtlockPasscodeForGuest } from "./ttlock-credential-format.ts";
import { isFinanceiramenteLiberadoParaAcesso } from "./reservation-financial-classification.ts";

export const GUEST_ACCESS_READY_EVENT = "guest_access_ready" as const;
export const GUEST_FIRST_ACCESS_WELCOME_EVENT = "guest_first_access_welcome" as const;

export const CONTACT_BLOCK = [
  "📞 Precisa falar conosco?",
  "Se tiver qualquer dificuldade para falar conosco por este WhatsApp,",
  "você também pode ligar para:",
  "",
  "Breno: (67) 99088-1337",
  "Julio: (67) 98402-0002",
  "Laura: (67) 99989-5245",
].join("\n");

export const CONTACT_BLOCK_STAY = [
  "📞 Se tiver qualquer dificuldade para falar conosco por este WhatsApp,",
  "você também pode ligar para:",
  "",
  "Breno: (67) 99088-1337",
  "Julio: (67) 98402-0002",
  "Laura: (67) 99989-5245",
].join("\n");

const HOTEL_ADDRESS =
  "Rua Joaquim Murtinho, 1967 – Bairro Aeroporto, Corumbá/MS";

export type BuildGuestAccessReadyInput = {
  guest_first_name: string;
  apartment_number: string;
  /** PIN técnico (sem #). */
  passcode: string;
  parking_spot: string;
  /** Data amigável pt-BR do check-in (ex.: 12/08/2026). */
  checkin_date_label: string;
  /**
   * true = mensagem enviada antes das 13h do dia do check-in (senha futura).
   * false = às 13h ou depois (senha já ativa).
   */
  before_activation: boolean;
  /**
   * Linha opcional para o hóspede (ex.: reenvio com senha da hospedagem 14/08).
   * Não mencionar detalhes técnicos.
   */
  stay_access_note?: string | null;
};

export type GuestAccessMessage = {
  kind: typeof GUEST_ACCESS_READY_EVENT | typeof GUEST_FIRST_ACCESS_WELCOME_EVENT;
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

function firstNameFrom(full: string | null | undefined): string {
  const s = String(full ?? "").trim().replace(/\s+/g, " ");
  if (!s) return "hóspede";
  return s.split(" ")[0] || "hóspede";
}

export function guestFirstName(full: string | null | undefined): string {
  return firstNameFrom(full);
}

/** Vaga: campo específico se houver; senão número do apto (comportamento vigente). */
export function resolveParkingSpot(input: {
  parking_spot?: string | null;
  apartment_number?: string | null;
}): string {
  const explicit = String(input.parking_spot ?? "").trim();
  if (explicit) return explicit;
  const apt = String(input.apartment_number ?? "").trim();
  return apt || "—";
}

export function formatCheckinDateLabelPtBr(
  checkin: Date | string,
  timeZone = "America/Campo_Grande",
): string {
  const d = checkin instanceof Date ? checkin : new Date(checkin);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

/**
 * true se agora < 13:00 do dia do check-in no fuso do hotel.
 */
export function isBeforeCheckinActivationHour(
  checkin: Date | string,
  now: Date | string,
  timeZone = "America/Campo_Grande",
): boolean {
  const c = checkin instanceof Date ? checkin : new Date(checkin);
  const n = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(c.getTime()) || Number.isNaN(n.getTime())) return false;

  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = (d: Date) => {
    const p = fmt.formatToParts(d);
    const get = (t: string) => p.find((x) => x.type === t)?.value || "0";
    return {
      y: Number(get("year")),
      m: Number(get("month")),
      d: Number(get("day")),
      h: Number(get("hour")),
      min: Number(get("minute")),
    };
  };
  const zc = parts(c);
  const zn = parts(n);
  if (zn.y !== zc.y || zn.m !== zc.m || zn.d !== zc.d) {
    // Antes do dia do check-in → senha ainda não ativa; depois do dia → já ativa.
    const beforeDay =
      zn.y < zc.y ||
      (zn.y === zc.y && zn.m < zc.m) ||
      (zn.y === zc.y && zn.m === zc.m && zn.d < zc.d);
    return beforeDay;
  }
  return zn.h < 13;
}

export function buildGuestAccessReadyMessage(
  input: BuildGuestAccessReadyInput,
): GuestAccessMessage {
  const name = firstNameFrom(input.guest_first_name);
  const apt = String(input.apartment_number || "").trim() || "—";
  const vaga = String(input.parking_spot || "").trim() || apt;
  const pass = formatTtlockPasscodeForGuest(input.passcode);
  const pin = pass.technical;
  const pinHash = pass.displayWithHash || `${pin}#`;
  const activation = input.before_activation
    ? `⏰ Sua senha ficará ativa a partir das 13h do dia ${input.checkin_date_label}.`
    : "⏰ Sua senha já está ativa.";
  const stayNote = String(input.stay_access_note ?? "").trim();

  const body = [
    `🏨 Olá, ${name}! Seu acesso ao Yes Hotel está liberado.`,
    "",
    "📍 Endereço",
    HOTEL_ADDRESS,
    "",
    `🛏️ Apartamento: ${apt}`,
    "",
    `🔑 Sua senha de acesso: ${pinHash}`,
    `(digite ${pin} + #)`,
    ...(stayNote ? ["", stayNote] : []),
    "",
    "A mesma senha é utilizada nos portões de pedestres e na porta do apartamento.",
    "",
    "Para entrar:",
    `• No portão de pedestres, digite ${pin} + #.`,
    `• Na porta do apartamento, utilize novamente ${pin} + #.`,
    "",
    activation,
    "",
    "🚗 Estacionamento",
    `Sua vaga é a ${vaga}.`,
    "O controle do portão de veículos fica dentro do apartamento.",
    "",
    "Se estiver chegando de carro, faça primeiro o acesso pelo portão de",
    "pedestres para entrar no apartamento e pegar o controle do portão.",
    "",
    CONTACT_BLOCK,
    "",
    "Boa viagem e até breve! 😊",
  ].join("\n");

  const body_html = [
    `<p>🏨 Olá, <strong>${escHtml(name)}</strong>! Seu acesso ao Yes Hotel está liberado.</p>`,
    `<p><strong>📍 Endereço</strong><br/>${escHtml(HOTEL_ADDRESS)}</p>`,
    `<p><strong>🛏️ Apartamento:</strong> ${escHtml(apt)}</p>`,
    `<p><strong>🔑 Sua senha de acesso:</strong> ${escHtml(pinHash)}<br/>(digite ${escHtml(pin)} + #)</p>`,
    ...(stayNote ? [`<p>${escHtml(stayNote)}</p>`] : []),
    `<p>A mesma senha é utilizada nos portões de pedestres e na porta do apartamento.</p>`,
    `<p>Para entrar:<br/>• No portão de pedestres, digite ${escHtml(pin)} + #.<br/>• Na porta do apartamento, utilize novamente ${escHtml(pin)} + #.</p>`,
    `<p>${escHtml(activation)}</p>`,
    `<p><strong>🚗 Estacionamento</strong><br/>Sua vaga é a ${escHtml(vaga)}.<br/>O controle do portão de veículos fica dentro do apartamento.</p>`,
    `<p>Se estiver chegando de carro, faça primeiro o acesso pelo portão de pedestres para entrar no apartamento e pegar o controle do portão.</p>`,
    `<pre style="font-family:inherit;white-space:pre-wrap">${escHtml(CONTACT_BLOCK)}</pre>`,
    `<p>Boa viagem e até breve! 😊</p>`,
  ].join("\n");

  return {
    kind: GUEST_ACCESS_READY_EVENT,
    body,
    subject: `Seu acesso ao Yes Hotel — Apartamento ${apt}`,
    body_html,
  };
}

export type BuildGuestFirstAccessWelcomeInput = {
  guest_first_name: string;
  apartment_number: string;
  parking_spot: string;
  /** Ambos obrigatórios para exibir o bloco; senão omitir. */
  wifi_ssid?: string | null;
  wifi_password?: string | null;
};

export function shouldIncludeWifiBlock(
  ssid: string | null | undefined,
  password: string | null | undefined,
): boolean {
  return Boolean(String(ssid ?? "").trim() && String(password ?? "").trim());
}

export function buildGuestFirstAccessWelcomeMessage(
  input: BuildGuestFirstAccessWelcomeInput,
): GuestAccessMessage {
  const name = firstNameFrom(input.guest_first_name);
  const apt = String(input.apartment_number || "").trim() || "—";
  const vaga = String(input.parking_spot || "").trim() || apt;
  const ssid = String(input.wifi_ssid ?? "").trim();
  const wifiPwd = String(input.wifi_password ?? "").trim();
  const showWifi = shouldIncludeWifiBlock(ssid, wifiPwd);

  const wifiLines = showWifi
    ? ["", "📶 Wi-Fi", `Rede: ${ssid}`, `Senha: ${wifiPwd}`, ""]
    : [""];

  const body = [
    `🏨 Bem-vindo ao Yes Hotel, ${name}!`,
    "",
    `Esperamos que tenha uma excelente estadia no apartamento ${apt}. 😊`,
    ...wifiLines,
    "🚗 Estacionamento",
    `Sua vaga é a ${vaga}.`,
    "O controle do portão de veículos está dentro do apartamento.",
    "",
    "Para sair com o veículo, passe pela faixa amarela próxima ao portão",
    "e ele abrirá automaticamente.",
    "",
    "☕ Café da manhã",
    "Servido das 06h às 09h.",
    "",
    "O salão fica no final do estacionamento.",
    "Siga as placas “Restaurante” no prédio.",
    "",
    "🚭 Não é permitido fumar dentro do apartamento.",
    "",
    "💬 Precisando de qualquer ajuda durante sua hospedagem,",
    "é só falar conosco por aqui.",
    "",
    CONTACT_BLOCK_STAY,
    "",
    "Desejamos uma ótima estadia!",
  ].join("\n");

  const wifiHtml = showWifi
    ? `<p><strong>📶 Wi-Fi</strong><br/>Rede: ${escHtml(ssid)}<br/>Senha: ${escHtml(wifiPwd)}</p>`
    : "";

  const body_html = [
    `<p>🏨 Bem-vindo ao Yes Hotel, <strong>${escHtml(name)}</strong>!</p>`,
    `<p>Esperamos que tenha uma excelente estadia no apartamento ${escHtml(apt)}. 😊</p>`,
    wifiHtml,
    `<p><strong>🚗 Estacionamento</strong><br/>Sua vaga é a ${escHtml(vaga)}.<br/>O controle do portão de veículos está dentro do apartamento.</p>`,
    `<p>Para sair com o veículo, passe pela faixa amarela próxima ao portão e ele abrirá automaticamente.</p>`,
    `<p><strong>☕ Café da manhã</strong><br/>Servido das 06h às 09h.<br/>O salão fica no final do estacionamento.<br/>Siga as placas “Restaurante” no prédio.</p>`,
    `<p>🚭 Não é permitido fumar dentro do apartamento.</p>`,
    `<p>💬 Precisando de qualquer ajuda durante sua hospedagem, é só falar conosco por aqui.</p>`,
    `<pre style="font-family:inherit;white-space:pre-wrap">${escHtml(CONTACT_BLOCK_STAY)}</pre>`,
    `<p>Desejamos uma ótima estadia!</p>`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    kind: GUEST_FIRST_ACCESS_WELCOME_EVENT,
    body,
    subject: `Bem-vindo ao Yes Hotel — Apartamento ${apt}`,
    body_html,
  };
}

/**
 * Financeiro liberado para acesso — mesma regra do domínio financeiro.
 * - HITS/pago operacional OU saldo <= 0 → liberado
 * - Pagar.me quitação integral (paid >= saldo) → liberado mesmo com HITS pendente
 * - comissionada → liberado para acesso, sem Pagar.me
 * - desconhecida → NÃO libera automaticamente
 */
export function isFinanceiroLiberadoParaAcesso(input: {
  pagamento_status?: string | null;
  classificacao_comissionamento?: string | null;
  reservation_balance_due?: number | null;
  /** Soma centavos das cobranças Pagar.me status=paid. */
  pagarme_paid_centavos_total?: number | null;
}): boolean {
  return isFinanceiramenteLiberadoParaAcesso({
    pagamentoStatus: input.pagamento_status,
    balanceDue: input.reservation_balance_due,
    classificacao: input.classificacao_comissionamento,
    pagarmePaidCentavosTotal: input.pagarme_paid_centavos_total,
  });
}

export function guestAccessReadyIdempotencyKey(reservationId: string): string {
  return `guest_access_ready:${reservationId}`;
}

export function guestFirstAccessWelcomeIdempotencyKey(
  reservationId: string,
  channel: "whatsapp" | "email",
): string {
  const base = `guest_first_access_welcome:${reservationId}`;
  return channel === "email" ? `${base}:email` : base;
}
