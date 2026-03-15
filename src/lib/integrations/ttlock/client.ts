/**
 * Cliente TTLock Open Platform.
 * Fluxo principal: passcode temporário (keyboard password).
 * addType = 2 (via gateway) para criar passcode sem Bluetooth.
 */

import * as crypto from "node:crypto";
import type {
  TtlockAuthResponse,
  TtlockConfig,
  TtlockKeyboardPwdAddParams,
  TtlockKeyboardPwdAddResponse,
} from "./types";
import { TtlockApiError } from "./types";
import { getTtlockConfig, isTtlockAvailable } from "./config";

function md5Lower(value: string): string {
  return crypto.createHash("md5").update(value, "utf8").digest("hex").toLowerCase();
}

async function parseJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export interface TtlockClientOptions {
  config?: TtlockConfig;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class TtlockClient {
  private readonly config: TtlockConfig;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(options: TtlockClientOptions = {}) {
    this.config = options.config ?? getTtlockConfig();
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  getConfig(): TtlockConfig {
    return this.config;
  }

  /** Retorna true se as credenciais estão configuradas (não valida token). */
  isAvailable(): boolean {
    return isTtlockAvailable(this.config);
  }

  /**
   * Obtém access token (OAuth2 com username/password).
   * A API TTLock exige password como MD5 em minúsculas de 32 caracteres.
   */
  async getAccessToken(): Promise<string> {
    if (!this.isAvailable()) {
      throw new Error(
        `TTLock: credenciais nao configuradas. Defina: ${["TTLOCK_CLIENT_ID", "TTLOCK_CLIENT_SECRET", "TTLOCK_USERNAME", "TTLOCK_PASSWORD"].join(", ")}.`,
      );
    }

    const passwordMd5 = md5Lower(this.config.password);
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      username: this.config.username,
      password: passwordMd5,
      grant_type: "password",
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(this.config.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const data = (await parseJsonSafe(res)) as TtlockAuthResponse & { errcode?: number; errmsg?: string };

      if (!res.ok) {
        throw new TtlockApiError(
          data?.errmsg ?? `Token request failed: ${res.status}`,
          res.status,
          data,
        );
      }

      if (data.errcode && data.errcode !== 0) {
        throw new TtlockApiError(
          data.errmsg ?? "Token error",
          res.status,
          data,
        );
      }

      const accessToken = data.access_token;
      if (!accessToken || typeof accessToken !== "string") {
        throw new TtlockApiError("Resposta sem access_token", res.status, data);
      }

      const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 7776000;
      this.cachedToken = {
        token: accessToken,
        expiresAt: Date.now() + (expiresIn - 60) * 1000,
      };

      return accessToken;
    } catch (e) {
      clearTimeout(timeout);
      if (e instanceof TtlockApiError) throw e;
      if (e instanceof Error) throw e;
      throw new Error(String(e));
    }
  }

  /**
   * Garante um token válido (usa cache se ainda não expirou).
   */
  async ensureAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now()) {
      return this.cachedToken.token;
    }
    return this.getAccessToken();
  }

  /**
   * Cria passcode temporário na fechadura (via gateway, addType=2).
   * lockId: número ou string numérica do lock (identificador_externo_ttlock).
   * startDate/endDate: timestamps em milissegundos.
   * Retorna keyboardPwdId para uso em alteração/revogação futura.
   */
  async createKeyboardPassword(
    params: Omit<TtlockKeyboardPwdAddParams, "addType" | "date">,
  ): Promise<TtlockKeyboardPwdAddResponse> {
    if (!this.isAvailable()) {
      throw new Error(
        "TTLock: credenciais nao configuradas. Configure TTLOCK_CLIENT_ID, TTLOCK_CLIENT_SECRET, TTLOCK_USERNAME, TTLOCK_PASSWORD.",
      );
    }

    const token = await this.ensureAccessToken();
    const lockId = typeof params.lockId === "string" ? parseInt(params.lockId, 10) : params.lockId;
    const date = Date.now();

    const body: Record<string, string | number> = {
      clientId: this.config.clientId,
      accessToken: token,
      lockId,
      keyboardPwd: params.keyboardPwd,
      startDate: params.startDate,
      endDate: params.endDate,
      addType: 2,
      date,
    };
    if (params.keyboardPwdName != null) body.keyboardPwdName = params.keyboardPwdName;

    const url = `${this.config.apiBaseUrl}/v3/keyboardPwd/add`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      const data = (await parseJsonSafe(res)) as TtlockKeyboardPwdAddResponse & {
        errcode?: number;
        errmsg?: string;
      };

      if (!res.ok) {
        throw new TtlockApiError(
          data?.errmsg ?? `Add passcode failed: ${res.status}`,
          res.status,
          data,
        );
      }

      if (data.errcode && data.errcode !== 0) {
        throw new TtlockApiError(
          data.errmsg ?? "Add passcode error",
          res.status,
          data,
        );
      }

      if (typeof (data as TtlockKeyboardPwdAddResponse).keyboardPwdId !== "number") {
        throw new TtlockApiError("Resposta sem keyboardPwdId", res.status, data);
      }

      return { keyboardPwdId: (data as TtlockKeyboardPwdAddResponse).keyboardPwdId };
    } catch (e) {
      clearTimeout(timeout);
      if (e instanceof TtlockApiError) throw e;
      if (e instanceof Error) throw e;
      throw new Error(String(e));
    }
  }

  /**
   * Stub para alteração de passcode (fase futura).
   */
  async updateKeyboardPassword(_params: {
    lockId: number | string;
    keyboardPwdId: number;
    keyboardPwd: string;
    startDate: number;
    endDate: number;
    date: number;
  }): Promise<{ success: boolean }> {
    throw new Error("TTLock updateKeyboardPassword ainda nao implementado (fase futura).");
  }

  /**
   * Stub para revogação de passcode (fase futura).
   */
  async deleteKeyboardPassword(_params: {
    lockId: number | string;
    keyboardPwdId: number;
    date: number;
  }): Promise<{ success: boolean }> {
    throw new Error("TTLock deleteKeyboardPassword ainda nao implementado (fase futura).");
  }
}

/** Factory: retorna cliente ou null se credenciais ausentes (falha controlada). */
export function getTtlockClient(options?: TtlockClientOptions): TtlockClient {
  return new TtlockClient(options);
}
