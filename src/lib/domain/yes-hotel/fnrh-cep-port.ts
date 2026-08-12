/**
 * Port CEP — interface + ViaCEP (sem secret).
 */

export type FnrhCepAddress = {
  cep: string;
  logradouro: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
  pais: string;
};

export type FnrhCepLookupResult =
  | { ok: true; address: FnrhCepAddress }
  | { ok: false; error: string };

export interface FnrhCepProvider {
  lookup(cep: string): Promise<FnrhCepLookupResult>;
}

export function normalizeCepDigits(cep: string): string {
  return String(cep ?? "").replace(/\D/g, "");
}

export class ViaCepProvider implements FnrhCepProvider {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async lookup(cep: string): Promise<FnrhCepLookupResult> {
    const digits = normalizeCepDigits(cep);
    if (digits.length !== 8) {
      return { ok: false, error: "cep_invalid" };
    }
    try {
      const res = await this.fetchImpl(`https://viacep.com.br/ws/${digits}/json/`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return { ok: false, error: "cep_http_error" };
      const data = (await res.json()) as Record<string, unknown>;
      if (data.erro) return { ok: false, error: "cep_not_found" };
      return {
        ok: true,
        address: {
          cep: digits,
          logradouro: String(data.logradouro ?? "").trim(),
          complemento: String(data.complemento ?? "").trim(),
          bairro: String(data.bairro ?? "").trim(),
          cidade: String(data.localidade ?? "").trim(),
          uf: String(data.uf ?? "").trim().toUpperCase(),
          pais: "Brasil",
        },
      };
    } catch {
      return { ok: false, error: "cep_network_error" };
    }
  }
}

export function createViaCepProvider(fetchImpl?: typeof fetch): FnrhCepProvider {
  return new ViaCepProvider(fetchImpl);
}
