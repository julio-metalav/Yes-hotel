/**
 * Identidade canônica do hóspede (CRM).
 * Brasileiro → CPF; estrangeiro → passaporte.
 * Telefone/e-mail são atributos de conciliação, não identidade primária.
 *
 * Alinhado a FNRH 2.0 (documento_tipo cpf|passport) sem importar OCR/FNRH.
 */

export type IdentityKind = "cpf" | "passport";

export type ResolvedGuestIdentity = {
  confidence: "confirmed" | "suggested" | "missing";
  identity: { kind: IdentityKind; valueNormalized: string; confidence: "confirmed" | "suggested" } | null;
  matchKey: string | null;
};

function onlyDigits(s: string): string {
  return String(s || "").replace(/\D/g, "");
}

/** Checksum CPF — mesma regra operacional FNRH; cópia intencional para não acoplar OCR. */
export function isValidCpf(raw: string): boolean {
  const cpf = onlyDigits(raw);
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (base: string, factor: number): number => {
    let sum = 0;
    for (let i = 0; i < base.length; i++) sum += Number(base[i]) * (factor - i);
    const mod = (sum * 10) % 11;
    return mod === 10 ? 0 : mod;
  };
  return calc(cpf.slice(0, 9), 10) === Number(cpf[9]) && calc(cpf.slice(0, 10), 11) === Number(cpf[10]);
}

export function normalizePassport(raw: string): string | null {
  const v = String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (v.length < 5 || v.length > 15) return null;
  return v;
}

export function looksBrazilianNationality(nationality: string | null | undefined): boolean {
  const n = String(nationality ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
  if (!n) return false;
  return n === "BR" || n === "BRA" || n === "BRASIL" || n === "BRAZIL" || n === "BRASILEIRA" || n === "BRASILEIRO";
}

export function resolveGuestIdentity(input: {
  documentType?: string | null;
  documentNumber?: string | null;
  nationality?: string | null;
}): ResolvedGuestIdentity {
  const type = String(input.documentType ?? "").trim().toLowerCase();
  const number = String(input.documentNumber ?? "").trim();

  if (type === "cpf" || (!type && looksBrazilianNationality(input.nationality))) {
    if (isValidCpf(number)) {
      const value = onlyDigits(number);
      return {
        confidence: "confirmed",
        identity: { kind: "cpf", valueNormalized: value, confidence: "confirmed" },
        matchKey: `cpf:${value}`,
      };
    }
  }

  if (type === "passport" || type === "passaporte" || (!type && input.nationality && !looksBrazilianNationality(input.nationality))) {
    const passport = normalizePassport(number);
    if (passport) {
      return {
        confidence: type ? "confirmed" : "suggested",
        identity: {
          kind: "passport",
          valueNormalized: passport,
          confidence: type ? "confirmed" : "suggested",
        },
        matchKey: `passport:${passport}`,
      };
    }
  }

  if (isValidCpf(number)) {
    const value = onlyDigits(number);
    return {
      confidence: "suggested",
      identity: { kind: "cpf", valueNormalized: value, confidence: "suggested" },
      matchKey: `cpf:${value}`,
    };
  }

  const passport = normalizePassport(number);
  if (passport) {
    return {
      confidence: "suggested",
      identity: { kind: "passport", valueNormalized: passport, confidence: "suggested" },
      matchKey: `passport:${passport}`,
    };
  }

  return { confidence: "missing", identity: null, matchKey: null };
}

/**
 * Deduplicação: chave canônica = CPF ou passaporte.
 * E-mail/telefone nunca geram matchKey primário.
 */
export function guestMatchKeyFromIdentity(identity: ResolvedGuestIdentity): string | null {
  return identity.matchKey;
}
