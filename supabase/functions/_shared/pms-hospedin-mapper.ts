/**
 * Normalização defensiva de payloads PMS para o espelho Yes.
 * A API pública da Hospedin não está documentada no repositório; este módulo
 * aceita formatos comuns (array raiz, { data: [] }, { reservations: [] }) e
 * campos com nomes alternativos. Ajuste HOSPEDIN_* ou este arquivo quando
 * a Hospedin fornecer contrato oficial (OpenAPI).
 */

export type NormalizedPmsGuest = {
  externalGuestId: string;
  nome: string;
  email: string;
  telefone: string;
  isPrincipal: boolean;
  endereco_logradouro: string;
  cidade: string;
  estado: string;
  pais: string;
  cep: string;
  documento: string;
  data_nascimento: string | null;
  nacionalidade: string;
  sexo: string;
  raw: Record<string, unknown>;
};

export type NormalizedPmsReservation = {
  externalReservationId: string;
  propertyExternalId: string | null;
  unitCode: string;
  unitName: string;
  checkIn: string;
  checkOut: string;
  statusRaw: string;
  isCancelled: boolean;
  paymentStatusRaw: string;
  paymentMapped: "pendente" | "pago";
  hospedePrincipalNome: string;
  guests: NormalizedPmsGuest[];
  raw: Record<string, unknown>;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function pickStr(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function pickDateStr(obj: Record<string, unknown>, keys: string[]): string {
  const s = pickStr(obj, keys);
  if (!s) return "";
  const d = s.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return "";
}

function isCancelledStatus(raw: string): boolean {
  const s = raw.toLowerCase();
  return (
    s.includes("cancel") ||
    s.includes("canceled") ||
    s.includes("cancelada") ||
    s === "c" ||
    s === "cancelado"
  );
}

function isPaidish(raw: string): boolean {
  const s = raw.toLowerCase();
  return s.includes("paid") || s.includes("pago") || s.includes("liquid") || s === "ok" || s === "1";
}

/** Garante no máximo um `isPrincipal`; se nenhum, o primeiro vira principal. */
export function ensureSinglePrincipal(guests: NormalizedPmsGuest[]): NormalizedPmsGuest[] {
  if (guests.length === 0) return guests;
  const firstIdx = guests.findIndex((g) => g.isPrincipal);
  if (firstIdx < 0) {
    return guests.map((g, i) => ({ ...g, isPrincipal: i === 0 }));
  }
  return guests.map((g, i) => ({ ...g, isPrincipal: i === firstIdx }));
}

/** Aplica endereço compartilhável do hóspede principal aos demais se estiverem vazios (não copia e-mail/telefone/nome). */
export function applyShareableAddressFromPrincipal(guests: NormalizedPmsGuest[]): NormalizedPmsGuest[] {
  const principal = guests.find((g) => g.isPrincipal) ?? guests[0];
  if (!principal) return guests;
  return guests.map((g) => {
    if (g === principal || g.isPrincipal) return g;
    return {
      ...g,
      endereco_logradouro: g.endereco_logradouro || principal.endereco_logradouro,
      cidade: g.cidade || principal.cidade,
      estado: g.estado || principal.estado,
      pais: g.pais || principal.pais,
      cep: g.cep || principal.cep,
    };
  });
}

function normalizeGuest(obj: Record<string, unknown>, fallbackId: string, idx: number): NormalizedPmsGuest {
  const id = pickStr(obj, [
    "id",
    "guest_id",
    "hospede_id",
    "customer_id",
    "pessoa_id",
    "external_id",
  ]) || fallbackId;
  const nome = pickStr(obj, ["name", "nome", "full_name", "guest_name", "hospede"]);
  const email = pickStr(obj, ["email", "e_mail", "mail"]);
  const telefone = pickStr(obj, ["phone", "telefone", "whatsapp", "mobile", "celular"]);
  const isPrincipal = Boolean(
    obj.is_principal === true ||
      obj.principal === true ||
      obj.main === true ||
      obj.primary === true ||
      (idx === 0 && pickStr(obj, ["type", "tipo"]) === "principal"),
  );
  const doc = pickStr(obj, ["document", "documento", "cpf", "rg", "passport"]);
  const dn = pickStr(obj, ["birth_date", "data_nascimento", "nascimento"]);
  const nat = pickStr(obj, ["nationality", "nacionalidade"]);
  const sexo = pickStr(obj, ["gender", "sexo", "sex"]);
  return {
    externalGuestId: id,
    nome,
    email,
    telefone,
    isPrincipal,
    endereco_logradouro: pickStr(obj, ["address", "endereco", "logradouro", "street"]),
    cidade: pickStr(obj, ["city", "cidade", "municipio"]),
    estado: pickStr(obj, ["state", "estado", "uf"]),
    pais: pickStr(obj, ["country", "pais", "nacionalidade_pais"]),
    cep: pickStr(obj, ["zip", "cep", "postal_code"]),
    documento: doc,
    data_nascimento: dn ? dn.slice(0, 10) : null,
    nacionalidade: nat,
    sexo,
    raw: obj,
  };
}

function extractGuestsArray(res: Record<string, unknown>, resExtId: string): Record<string, unknown>[] {
  const g = res.guests ?? res.hospedes ?? res.guest_list ?? res.pessoas;
  if (Array.isArray(g)) return g.filter((x) => asRecord(x)) as Record<string, unknown>[];
  const single = asRecord(res.guest ?? res.hospede ?? res.main_guest);
  if (single) return [single];
  return [];
}

function normalizeReservation(obj: Record<string, unknown>, index: number): NormalizedPmsReservation | null {
  const externalReservationId = pickStr(obj, [
    "id",
    "reservation_id",
    "booking_id",
    "reserva_id",
    "external_id",
    "codigo",
  ]);
  if (!externalReservationId) return null;

  const checkIn = pickDateStr(obj, [
    "check_in",
    "checkin",
    "checkIn",
    "arrival",
    "data_checkin",
    "start_date",
  ]);
  const checkOut = pickDateStr(obj, [
    "check_out",
    "checkout",
    "checkOut",
    "departure",
    "data_checkout",
    "end_date",
  ]);
  if (!checkIn || !checkOut) return null;

  const statusRaw = pickStr(obj, ["status", "situacao", "state", "booking_status"]);
  const payRaw = pickStr(obj, [
    "payment_status",
    "pagamento",
    "payment",
    "financial_status",
    "paid",
  ]);
  const unit = asRecord(obj.room as unknown) ?? asRecord(obj.unit as unknown) ?? asRecord(obj.accommodation as unknown);
  const unitCode = unit
    ? pickStr(unit, ["code", "codigo", "number", "numero", "name", "nome"])
    : pickStr(obj, ["room", "apartment", "apartamento", "unit_code", "unidade"]);
  const unitName = unit ? pickStr(unit, ["name", "nome", "description"]) : pickStr(obj, ["room_name", "unidade_nome"]);

  const guestsRaw = extractGuestsArray(obj, externalReservationId);
  const guests: NormalizedPmsGuest[] = guestsRaw.map((g, i) =>
    normalizeGuest(g, `${externalReservationId}:guest:${i}`, i)
  );

  const withAddr = ensureSinglePrincipal(
    applyShareableAddressFromPrincipal(guests.length ? guests : [
      normalizeGuest({}, `${externalReservationId}:guest:0`, 0),
    ]),
  );

  const principal = withAddr.find((x) => x.isPrincipal) ?? withAddr[0];
  const hospedePrincipalNome = principal?.nome ?? "";

  return {
    externalReservationId,
    propertyExternalId: pickStr(obj, ["property_id", "hotel_id", "establishment_id"]) || null,
    unitCode: unitCode || "—",
    unitName: unitName || "",
    checkIn,
    checkOut,
    statusRaw: statusRaw || "unknown",
    isCancelled: isCancelledStatus(statusRaw),
    paymentStatusRaw: payRaw,
    paymentMapped: isPaidish(payRaw) ? "pago" : "pendente",
    hospedePrincipalNome,
    guests: withAddr.map((g, i) => ({
      ...g,
      nome: g.nome.trim() ? g.nome : (g.isPrincipal ? "Hóspede principal" : `Hóspede ${i + 1}`),
    })),
    raw: obj,
  };
}

function extractReservationArray(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) {
    return body.map((x) => asRecord(x)).filter(Boolean) as Record<string, unknown>[];
  }
  const root = asRecord(body);
  if (!root) return [];
  const candidates = ["data", "reservations", "bookings", "items", "results", "rows"];
  for (const k of candidates) {
    const v = root[k];
    if (Array.isArray(v)) {
      return v.map((x) => asRecord(x)).filter(Boolean) as Record<string, unknown>[];
    }
  }
  return [];
}

/**
 * Converte resposta HTTP JSON da Hospedin (ou stub) em reservas normalizadas.
 */
export function normalizeHospedinListPayload(body: unknown): NormalizedPmsReservation[] {
  const arr = extractReservationArray(body);
  const out: NormalizedPmsReservation[] = [];
  for (let i = 0; i < arr.length; i++) {
    const n = normalizeReservation(arr[i], i);
    if (n) out.push(n);
  }
  return out;
}
