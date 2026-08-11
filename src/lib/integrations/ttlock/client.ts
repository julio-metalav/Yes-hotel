/**
 * Cliente TTLock Open Platform.
 * Fluxo principal: passcode temporário (keyboard password).
 * addType = 2 (via gateway) para criar passcode sem Bluetooth.
 * Contrato (form-urlencoded, retry delete): docs/YES_HOTEL_TTLOCK_CONTRATO_API.md
 */

import * as crypto from "node:crypto";
import type {
  TtlockAuthResponse,
  TtlockConfig,
  TtlockKeyboardPwdAddParams,
  TtlockKeyboardPwdAddResponse,
  TtlockKeyboardPwdChangeParams,
  TtlockKeyboardPwdDeleteParams,
  TtlockSuccessResponse,
} from "./types.ts";
import { TtlockApiError } from "./types.ts";
import { getTtlockConfig, isTtlockAvailable } from "./config.ts";
import { logTtlockLifecycle } from "./lifecycle-log.ts";

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

const TTLOCK_DELETE_RETRY_MAX = 2;
const TTLOCK_DELAY_MS = 800;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientDeleteError(status: number, errcode?: number): boolean {
  if (status >= 500 || status === 429) return true;
  const transientCodes = [10001, 10002, 10003, 10004];
  if (errcode != null && errcode !== 0 && transientCodes.includes(errcode)) return true;
  return false;
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

    const lockId = typeof params.lockId === "string" ? parseInt(params.lockId, 10) : params.lockId;
    logTtlockLifecycle({
      action: "provision",
      source: "app_client",
      lock_id: lockId,
      status: "start",
      timestamp: new Date().toISOString(),
    });

    const token = await this.ensureAccessToken();
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

      const keyboardPwdId = (data as TtlockKeyboardPwdAddResponse).keyboardPwdId;
      logTtlockLifecycle({
        action: "provision",
        source: "app_client",
        lock_id: lockId,
        remote_keyboard_pwd_id: keyboardPwdId,
        status: "success",
        timestamp: new Date().toISOString(),
      });
      return { keyboardPwdId };
    } catch (e) {
      clearTimeout(timeout);
      logTtlockLifecycle({
        action: "provision",
        source: "app_client",
        lock_id: lockId,
        status: "error",
        error_message: e instanceof Error ? e.message : String(e),
        timestamp: new Date().toISOString(),
      });
      if (e instanceof TtlockApiError) throw e;
      if (e instanceof Error) throw e;
      throw new Error(String(e));
    }
  }

  /**
   * Deleta passcode na fechadura (via gateway, deleteType=2).
   * Usado para revogação de acesso.
   * API TTLock exige application/x-www-form-urlencoded (não JSON).
   * Retry: 1 tentativa inicial + até 2 retries para erros transitórios.
   */
  async deleteKeyboardPassword(
    params: Omit<TtlockKeyboardPwdDeleteParams, "deleteType" | "date">,
  ): Promise<TtlockSuccessResponse> {
    if (!this.isAvailable()) {
      throw new Error(
        "TTLock: credenciais nao configuradas. Configure TTLOCK_CLIENT_ID, TTLOCK_CLIENT_SECRET, TTLOCK_USERNAME, TTLOCK_PASSWORD.",
      );
    }

    const lockId = typeof params.lockId === "string" ? parseInt(params.lockId, 10) : params.lockId;
    const url = `${this.config.apiBaseUrl}/v3/keyboardPwd/delete`;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= 1 + TTLOCK_DELETE_RETRY_MAX; attempt++) {
      logTtlockLifecycle({
        action: "delete",
        source: "app_client",
        remote_keyboard_pwd_id: params.keyboardPwdId,
        lock_id: lockId,
        status: "start",
        attempt,
        timestamp: new Date().toISOString(),
      });
      if (attempt > 1) await delay(TTLOCK_DELAY_MS);

      const token = await this.ensureAccessToken();
      const body = new URLSearchParams({
        clientId: this.config.clientId,
        accessToken: token,
        lockId: String(lockId),
        keyboardPwdId: String(params.keyboardPwdId),
        deleteType: "2",
        date: String(Date.now()),
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const data = (await parseJsonSafe(res)) as TtlockSuccessResponse & { errcode?: number; errmsg?: string };

        if (!res.ok) {
          const errMsg = data?.errmsg ?? `Delete passcode failed: ${res.status}`;
          lastError = new TtlockApiError(errMsg, res.status, data);
          const canRetry = attempt < 1 + TTLOCK_DELETE_RETRY_MAX && isTransientDeleteError(res.status, data?.errcode);
          if (!canRetry) {
            logTtlockLifecycle({
              action: "delete",
              source: "app_client",
              remote_keyboard_pwd_id: params.keyboardPwdId,
              lock_id: lockId,
              status: "error",
              error_message: errMsg,
              attempt,
              timestamp: new Date().toISOString(),
            });
            throw lastError;
          }
          continue;
        }

        if (data.errcode != null && data.errcode !== 0) {
          const errMsg = data.errmsg ?? "Delete passcode error";
          lastError = new TtlockApiError(errMsg, res.status, data);
          const canRetry = attempt < 1 + TTLOCK_DELETE_RETRY_MAX && isTransientDeleteError(res.status, data.errcode);
          if (!canRetry) {
            logTtlockLifecycle({
              action: "delete",
              source: "app_client",
              remote_keyboard_pwd_id: params.keyboardPwdId,
              lock_id: lockId,
              status: "error",
              error_message: errMsg,
              attempt,
              timestamp: new Date().toISOString(),
            });
            throw lastError;
          }
          continue;
        }

        logTtlockLifecycle({
          action: "delete",
          source: "app_client",
          remote_keyboard_pwd_id: params.keyboardPwdId,
          lock_id: lockId,
          status: "success",
          attempt,
          timestamp: new Date().toISOString(),
        });
        return data;
      } catch (e) {
        clearTimeout(timeout);
        lastError = e instanceof Error ? e : new Error(String(e));
        const canRetry = attempt < 1 + TTLOCK_DELETE_RETRY_MAX;
        if (!canRetry) {
          const msg = lastError.message;
          logTtlockLifecycle({
            action: "delete",
            source: "app_client",
            remote_keyboard_pwd_id: params.keyboardPwdId,
            lock_id: lockId,
            status: "error",
            error_message: "Falha final após " + (1 + TTLOCK_DELETE_RETRY_MAX) + " tentativas: " + msg,
            attempt,
            timestamp: new Date().toISOString(),
          });
          throw lastError;
        }
      }
    }

    logTtlockLifecycle({
      action: "delete",
      source: "app_client",
      remote_keyboard_pwd_id: params.keyboardPwdId,
      lock_id: lockId,
      status: "error",
      error_message: lastError?.message ?? "Falha final",
      attempt: 1 + TTLOCK_DELETE_RETRY_MAX,
      timestamp: new Date().toISOString(),
    });
    throw lastError ?? new Error("Delete passcode failed");
  }

  /**
   * Altera passcode na fechadura (via gateway, changeType=2).
   * Permite alterar validade (startDate/endDate) e opcionalmente o próprio código.
   * Usado para early check-in, late check-out e ajuste manual.
   */
  async changeKeyboardPassword(
    params: Omit<TtlockKeyboardPwdChangeParams, "changeType" | "date"> & { date?: number },
  ): Promise<TtlockSuccessResponse> {
    if (!this.isAvailable()) {
      throw new Error(
        "TTLock: credenciais nao configuradas. Configure TTLOCK_CLIENT_ID, TTLOCK_CLIENT_SECRET, TTLOCK_USERNAME, TTLOCK_PASSWORD.",
      );
    }

    const token = await this.ensureAccessToken();
    const lockId = typeof params.lockId === "string" ? parseInt(params.lockId, 10) : params.lockId;
    const date = params.date ?? Date.now();

    const body: Record<string, string | number> = {
      clientId: this.config.clientId,
      accessToken: token,
      lockId,
      keyboardPwdId: params.keyboardPwdId,
      changeType: 2,
      date,
    };
    if (params.keyboardPwdName != null) body.keyboardPwdName = params.keyboardPwdName;
    if (params.newKeyboardPwd != null) body.newKeyboardPwd = params.newKeyboardPwd;
    if (params.startDate != null) body.startDate = params.startDate;
    if (params.endDate != null) body.endDate = params.endDate;

    const url = `${this.config.apiBaseUrl}/v3/keyboardPwd/change`;
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
      const data = (await parseJsonSafe(res)) as TtlockSuccessResponse & { errcode?: number; errmsg?: string };

      if (!res.ok) {
        throw new TtlockApiError(
          data?.errmsg ?? `Change passcode failed: ${res.status}`,
          res.status,
          data,
        );
      }

      if (data.errcode != null && data.errcode !== 0) {
        throw new TtlockApiError(
          data.errmsg ?? "Change passcode error",
          res.status,
          data,
        );
      }

      return data;
    } catch (e) {
      clearTimeout(timeout);
      if (e instanceof TtlockApiError) throw e;
      if (e instanceof Error) throw e;
      throw new Error(String(e));
    }
  }

  /**
   * Alias para compatibilidade com código que já usava o nome updateKeyboardPassword.
   * Delega para changeKeyboardPassword com startDate/endDate.
   */
  async updateKeyboardPassword(params: {
    lockId: number | string;
    keyboardPwdId: number;
    keyboardPwd: string;
    startDate: number;
    endDate: number;
    date?: number;
  }): Promise<{ success: boolean }> {
    await this.changeKeyboardPassword({
      lockId: params.lockId,
      keyboardPwdId: params.keyboardPwdId,
      newKeyboardPwd: params.keyboardPwd,
      startDate: params.startDate,
      endDate: params.endDate,
      date: params.date ?? Date.now(),
    });
    return { success: true };
  }
}

/** Factory: retorna cliente ou null se credenciais ausentes (falha controlada). */
export function getTtlockClient(options?: TtlockClientOptions): TtlockClient {
  return new TtlockClient(options);
}
