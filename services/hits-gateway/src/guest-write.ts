/**
 * Validação isolada da escrita PAX (sandbox).
 * Rejeita campos desconhecidos. Não loga payload nem PII.
 */

import type {
  HitsGuestAddress,
  HitsGuestNote,
  HitsGuestsPutDto,
  HitsWebCheckinGuestCreateItem,
  HitsWebCheckinGuestsPostBody,
} from "../../../src/lib/integrations/hits/types.ts";

export const HITS_DOCUMENT_TYPES = [1, 2, 3, 4, 5, 6, 7] as const;
export const HITS_CONTACT_TYPES = [1, 2, 3, 4] as const;
export const HITS_GENDERS = [0, 1] as const;
export const HITS_TITLES = [1, 2, 3, 4] as const;
export const HITS_LANGS = [1, 2, 3] as const;
export const HITS_PURPOSE_TRIPS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
export const HITS_ARRIVING_BY = [0, 1, 2, 3, 4, 5, 7, 8] as const;
export const HITS_ACCESSIBILITY_TYPES = [1, 2, 3, 4, 5] as const;

const POST_GUEST_KEYS = ["name", "doc", "docType", "contact", "contactType"] as const;
const POST_BODY_KEYS = ["guests"] as const;
const PUT_KEYS = [
  "idEntity",
  "idReservation",
  "name",
  "gender",
  "birthdate",
  "contactType1",
  "contact1",
  "contactType2",
  "contact2",
  "title",
  "accessibility",
  "lang",
  "companyName",
  "companyDocType",
  "companyDoc",
  "docType",
  "doc",
  "docStateRegistration",
  "notes",
  "addresses",
  "foreign",
  "guestForeign",
  "purposeTrip",
  "arrivingBy",
  "jobTitle",
  "accessibilityType",
  "nationalityCountryId",
  "carLicensePlate",
] as const;
const PUT_UPDATE_KEYS = PUT_KEYS.filter((k) => k !== "idEntity" && k !== "idReservation");
const NOTE_KEYS = ["noteTypeId", "note"] as const;
const ADDRESS_KEYS = [
  "address",
  "zipCode",
  "details",
  "neighborhood",
  "number",
  "country",
  "state",
  "city",
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,7})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const MAX_GUESTS = 100;
const MAX_NESTED = 20;

export type GuestWriteParseOk<T> = { ok: true; value: T };
export type GuestWriteParseErr = { ok: false; code: "bad_request"; message: string };
export type GuestWriteParseResult<T> = GuestWriteParseOk<T> | GuestWriteParseErr;

function err(message: string): GuestWriteParseErr {
  return { ok: false, code: "bad_request", message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownKey(
  obj: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  const allow = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allow.has(key)) return key;
  }
  return null;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && Number.isSafeInteger(value);
}

function isEnumInt(value: unknown, allowed: readonly number[]): value is number {
  return typeof value === "number" && Number.isInteger(value) && allowed.includes(value);
}

function parseNonEmptyString(
  value: unknown,
  field: string,
  maxLen: number,
): GuestWriteParseResult<string> {
  if (typeof value !== "string") {
    return err(`${field} inválido.`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) {
    return err(`${field} inválido.`);
  }
  return { ok: true, value: trimmed };
}

function parseOptionalString(
  obj: Record<string, unknown>,
  field: string,
  maxLen: number,
): GuestWriteParseResult<string | undefined> {
  if (!hasOwn(obj, field)) return { ok: true, value: undefined };
  return parseNonEmptyString(obj[field], field, maxLen);
}

function parseEnumField(
  obj: Record<string, unknown>,
  field: string,
  allowed: readonly number[],
): GuestWriteParseResult<number | undefined> {
  if (!hasOwn(obj, field)) return { ok: true, value: undefined };
  if (!isEnumInt(obj[field], allowed)) {
    return err(`${field} inválido.`);
  }
  return { ok: true, value: obj[field] as number };
}

function parseBooleanField(
  obj: Record<string, unknown>,
  field: string,
): GuestWriteParseResult<boolean | undefined> {
  if (!hasOwn(obj, field)) return { ok: true, value: undefined };
  if (typeof obj[field] !== "boolean") {
    return err(`${field} inválido.`);
  }
  return { ok: true, value: obj[field] };
}

function parseStringOrNull(
  value: unknown,
  field: string,
  maxLen: number,
): GuestWriteParseResult<string | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return err(`${field} inválido.`);
  }
  if (value.length > maxLen) {
    return err(`${field} inválido.`);
  }
  return { ok: true, value };
}

function parseNote(value: unknown): GuestWriteParseResult<HitsGuestNote> {
  if (!isPlainObject(value)) {
    return err("notes inválido.");
  }
  const extra = unknownKey(value, NOTE_KEYS);
  if (extra) return err("Campo não permitido em notes.");
  if (!isPositiveInt(value.noteTypeId)) {
    return err("notes.noteTypeId inválido.");
  }
  if (!hasOwn(value, "note")) {
    return err("notes.note inválido.");
  }
  const note = parseStringOrNull(value.note, "notes.note", 2000);
  if (!note.ok) return note;
  return { ok: true, value: { noteTypeId: value.noteTypeId, note: note.value } };
}

function parseNotes(value: unknown): GuestWriteParseResult<HitsGuestNote[] | null> {
  if (value === null) return { ok: true, value: null };
  if (!Array.isArray(value)) {
    return err("notes inválido.");
  }
  if (value.length > MAX_NESTED) {
    return err("notes inválido.");
  }
  const out: HitsGuestNote[] = [];
  for (const item of value) {
    const parsed = parseNote(item);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  return { ok: true, value: out };
}

function parseAddress(value: unknown): GuestWriteParseResult<HitsGuestAddress> {
  if (!isPlainObject(value)) {
    return err("addresses inválido.");
  }
  const extra = unknownKey(value, ADDRESS_KEYS);
  if (extra) return err("Campo não permitido em addresses.");
  const out: HitsGuestAddress = {};
  for (const key of ADDRESS_KEYS) {
    if (!hasOwn(value, key)) continue;
    const parsed = parseStringOrNull(value[key], `addresses.${key}`, 200);
    if (!parsed.ok) return parsed;
    out[key] = parsed.value;
  }
  return { ok: true, value: out };
}

function parseAddresses(
  value: unknown,
): GuestWriteParseResult<HitsGuestAddress[] | null> {
  if (value === null) return { ok: true, value: null };
  if (!Array.isArray(value)) {
    return err("addresses inválido.");
  }
  if (value.length > MAX_NESTED) {
    return err("addresses inválido.");
  }
  const out: HitsGuestAddress[] = [];
  for (const item of value) {
    const parsed = parseAddress(item);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  return { ok: true, value: out };
}

function parseCreateGuest(
  value: unknown,
): GuestWriteParseResult<HitsWebCheckinGuestCreateItem> {
  if (!isPlainObject(value)) {
    return err("hóspede inválido.");
  }
  const extra = unknownKey(value, POST_GUEST_KEYS);
  if (extra) {
    return err("Campo não permitido no hóspede.");
  }

  const name = parseNonEmptyString(value.name, "name", 200);
  if (!name.ok) return name;

  const hasDoc = hasOwn(value, "doc");
  const hasDocType = hasOwn(value, "docType");
  if (hasDoc !== hasDocType) {
    return err("doc e docType devem ser enviados juntos.");
  }

  const hasContact = hasOwn(value, "contact");
  const hasContactType = hasOwn(value, "contactType");
  if (hasContact !== hasContactType) {
    return err("contact e contactType devem ser enviados juntos.");
  }

  const item: HitsWebCheckinGuestCreateItem = { name: name.value };

  if (hasDoc) {
    const doc = parseNonEmptyString(value.doc, "doc", 64);
    if (!doc.ok) return doc;
    if (!isEnumInt(value.docType, HITS_DOCUMENT_TYPES)) {
      return err("docType inválido.");
    }
    item.doc = doc.value;
    item.docType = value.docType as HitsWebCheckinGuestCreateItem["docType"];
  }

  if (hasContact) {
    const contact = parseNonEmptyString(value.contact, "contact", 128);
    if (!contact.ok) return contact;
    if (!isEnumInt(value.contactType, HITS_CONTACT_TYPES)) {
      return err("contactType inválido.");
    }
    item.contact = contact.value;
    item.contactType = value.contactType as HitsWebCheckinGuestCreateItem["contactType"];
  }

  return { ok: true, value: item };
}

export function parseGuestsPostBody(
  raw: unknown,
): GuestWriteParseResult<HitsWebCheckinGuestsPostBody> {
  if (!isPlainObject(raw)) {
    return err("Body inválido.");
  }
  const extra = unknownKey(raw, POST_BODY_KEYS);
  if (extra) {
    return err("Campo não permitido.");
  }
  if (!Array.isArray(raw.guests)) {
    return err("guests deve ser uma lista.");
  }
  if (raw.guests.length < 1 || raw.guests.length > MAX_GUESTS) {
    return err("guests deve ter entre 1 e 100 hóspedes.");
  }

  const guests: HitsWebCheckinGuestCreateItem[] = [];
  for (const item of raw.guests) {
    const parsed = parseCreateGuest(item);
    if (!parsed.ok) return parsed;
    guests.push(parsed.value);
  }
  return { ok: true, value: { guests } };
}

export function parseGuestsPutBody(raw: unknown): GuestWriteParseResult<HitsGuestsPutDto> {
  if (!isPlainObject(raw)) {
    return err("Body inválido.");
  }
  const extra = unknownKey(raw, PUT_KEYS);
  if (extra) {
    return err("Campo não permitido.");
  }
  if (!isPositiveInt(raw.idEntity)) {
    return err("idEntity deve ser um inteiro positivo.");
  }
  if (!isPositiveInt(raw.idReservation)) {
    return err("idReservation deve ser um inteiro positivo.");
  }

  const hasUpdate = PUT_UPDATE_KEYS.some((key) => hasOwn(raw, key));
  if (!hasUpdate) {
    return err("Informe ao menos um campo para atualização.");
  }

  const out: HitsGuestsPutDto = {
    idEntity: raw.idEntity,
    idReservation: raw.idReservation,
  };

  const name = parseOptionalString(raw, "name", 200);
  if (!name.ok) return name;
  if (name.value !== undefined) out.name = name.value;

  const gender = parseEnumField(raw, "gender", HITS_GENDERS);
  if (!gender.ok) return gender;
  if (gender.value !== undefined) out.gender = gender.value as HitsGuestsPutDto["gender"];

  if (hasOwn(raw, "birthdate")) {
    const birthdate = parseNonEmptyString(raw.birthdate, "birthdate", 40);
    if (!birthdate.ok) return birthdate;
    if (!DATE_RE.test(birthdate.value) || !Number.isFinite(Date.parse(birthdate.value))) {
      return err("birthdate inválido.");
    }
    out.birthdate = birthdate.value;
  }

  const contactType1 = parseEnumField(raw, "contactType1", HITS_CONTACT_TYPES);
  if (!contactType1.ok) return contactType1;
  if (contactType1.value !== undefined) {
    out.contactType1 = contactType1.value as HitsGuestsPutDto["contactType1"];
  }
  const contact1 = parseOptionalString(raw, "contact1", 128);
  if (!contact1.ok) return contact1;
  if (contact1.value !== undefined) out.contact1 = contact1.value;

  const contactType2 = parseEnumField(raw, "contactType2", HITS_CONTACT_TYPES);
  if (!contactType2.ok) return contactType2;
  if (contactType2.value !== undefined) {
    out.contactType2 = contactType2.value as HitsGuestsPutDto["contactType2"];
  }
  const contact2 = parseOptionalString(raw, "contact2", 128);
  if (!contact2.ok) return contact2;
  if (contact2.value !== undefined) out.contact2 = contact2.value;

  const title = parseEnumField(raw, "title", HITS_TITLES);
  if (!title.ok) return title;
  if (title.value !== undefined) out.title = title.value as HitsGuestsPutDto["title"];

  const accessibility = parseBooleanField(raw, "accessibility");
  if (!accessibility.ok) return accessibility;
  if (accessibility.value !== undefined) out.accessibility = accessibility.value;

  const lang = parseEnumField(raw, "lang", HITS_LANGS);
  if (!lang.ok) return lang;
  if (lang.value !== undefined) out.lang = lang.value as HitsGuestsPutDto["lang"];

  const companyName = parseOptionalString(raw, "companyName", 200);
  if (!companyName.ok) return companyName;
  if (companyName.value !== undefined) out.companyName = companyName.value;

  const companyDocType = parseEnumField(raw, "companyDocType", HITS_DOCUMENT_TYPES);
  if (!companyDocType.ok) return companyDocType;
  if (companyDocType.value !== undefined) {
    out.companyDocType = companyDocType.value as HitsGuestsPutDto["companyDocType"];
  }
  const companyDoc = parseOptionalString(raw, "companyDoc", 64);
  if (!companyDoc.ok) return companyDoc;
  if (companyDoc.value !== undefined) out.companyDoc = companyDoc.value;

  const docType = parseEnumField(raw, "docType", HITS_DOCUMENT_TYPES);
  if (!docType.ok) return docType;
  if (docType.value !== undefined) out.docType = docType.value as HitsGuestsPutDto["docType"];
  const doc = parseOptionalString(raw, "doc", 64);
  if (!doc.ok) return doc;
  if (doc.value !== undefined) out.doc = doc.value;

  const docStateRegistration = parseOptionalString(raw, "docStateRegistration", 64);
  if (!docStateRegistration.ok) return docStateRegistration;
  if (docStateRegistration.value !== undefined) {
    out.docStateRegistration = docStateRegistration.value;
  }

  if (hasOwn(raw, "notes")) {
    const notes = parseNotes(raw.notes);
    if (!notes.ok) return notes;
    out.notes = notes.value;
  }

  if (hasOwn(raw, "addresses")) {
    const addresses = parseAddresses(raw.addresses);
    if (!addresses.ok) return addresses;
    out.addresses = addresses.value;
  }

  const foreign = parseBooleanField(raw, "foreign");
  if (!foreign.ok) return foreign;
  if (foreign.value !== undefined) out.foreign = foreign.value;

  const guestForeign = parseBooleanField(raw, "guestForeign");
  if (!guestForeign.ok) return guestForeign;
  if (guestForeign.value !== undefined) out.guestForeign = guestForeign.value;

  const purposeTrip = parseEnumField(raw, "purposeTrip", HITS_PURPOSE_TRIPS);
  if (!purposeTrip.ok) return purposeTrip;
  if (purposeTrip.value !== undefined) {
    out.purposeTrip = purposeTrip.value as HitsGuestsPutDto["purposeTrip"];
  }

  const arrivingBy = parseEnumField(raw, "arrivingBy", HITS_ARRIVING_BY);
  if (!arrivingBy.ok) return arrivingBy;
  if (arrivingBy.value !== undefined) {
    out.arrivingBy = arrivingBy.value as HitsGuestsPutDto["arrivingBy"];
  }

  const jobTitle = parseOptionalString(raw, "jobTitle", 200);
  if (!jobTitle.ok) return jobTitle;
  if (jobTitle.value !== undefined) out.jobTitle = jobTitle.value;

  const accessibilityType = parseEnumField(raw, "accessibilityType", HITS_ACCESSIBILITY_TYPES);
  if (!accessibilityType.ok) return accessibilityType;
  if (accessibilityType.value !== undefined) {
    out.accessibilityType = accessibilityType.value as HitsGuestsPutDto["accessibilityType"];
  }

  if (hasOwn(raw, "nationalityCountryId")) {
    if (!isPositiveInt(raw.nationalityCountryId)) {
      return err("nationalityCountryId inválido.");
    }
    out.nationalityCountryId = raw.nationalityCountryId;
  }

  const carLicensePlate = parseOptionalString(raw, "carLicensePlate", 32);
  if (!carLicensePlate.ok) return carLicensePlate;
  if (carLicensePlate.value !== undefined) out.carLicensePlate = carLicensePlate.value;

  return { ok: true, value: out };
}

export function isHitsSandboxTenant(tenantName: string): boolean {
  return tenantName.trim().toLowerCase() === "dev";
}

export function isHitsGuestWriteEnabled(input: {
  hitsReady: boolean;
  tenantName: string;
  guestWriteFlag: string;
}): boolean {
  return (
    input.hitsReady === true &&
    input.guestWriteFlag === "true" &&
    isHitsSandboxTenant(input.tenantName)
  );
}
