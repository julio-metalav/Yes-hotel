/**
 * Tipos para integração TTLock Open Platform.
 * Fluxo principal desta fase: passcode temporário (keyboard password), não eKey.
 */

export interface TtlockConfig {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  tokenUrl: string;
  apiBaseUrl: string;
  /** Se false, chamadas à API devem falhar de forma controlada. */
  enabled: boolean;
  /** Indica se as credenciais estão preenchidas (não valida se são válidas). */
  hasCredentials: boolean;
}

export interface TtlockAuthResponse {
  access_token: string;
  uid?: number;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
}

export interface TtlockKeyboardPwdAddParams {
  lockId: number | string;
  keyboardPwd: string;
  keyboardPwdName?: string;
  startDate: number;
  endDate: number;
  addType?: 1 | 2 | 3;
  date: number;
}

export interface TtlockKeyboardPwdAddResponse {
  keyboardPwdId: number;
}

/** Item da listagem read-only v3/lock/listKeyboardPwd. */
export interface TtlockKeyboardPwdListItem {
  keyboardPwdId: number;
  lockId?: number;
  keyboardPwd?: string;
  keyboardPwdName?: string;
  keyboardPwdVersion?: number;
  keyboardPwdType?: number;
  startDate?: number;
  endDate?: number;
  sendDate?: number;
  isCustom?: number;
  status?: number;
  senderUsername?: string;
}

export interface TtlockKeyboardPwdListResponse {
  list?: TtlockKeyboardPwdListItem[];
  pages?: number;
  pageNo?: number;
  pageSize?: number;
  total?: number;
}

/** Parâmetros para deletar passcode (v3/keyboardPwd/delete). deleteType=2 = via gateway. */
export interface TtlockKeyboardPwdDeleteParams {
  lockId: number | string;
  keyboardPwdId: number;
  deleteType?: 1 | 2 | 3;
  date: number;
}

/** Parâmetros para alterar passcode (v3/keyboardPwd/change). changeType=2 = via gateway. */
export interface TtlockKeyboardPwdChangeParams {
  lockId: number | string;
  keyboardPwdId: number;
  keyboardPwdName?: string;
  newKeyboardPwd?: string;
  startDate?: number;
  endDate?: number;
  changeType?: 1 | 2 | 3;
  date: number;
}

/** Resposta genérica de sucesso (errcode 0). */
export interface TtlockSuccessResponse {
  errcode?: number;
  errmsg?: string;
  description?: string;
}

export interface TtlockApiErrorBody {
  errcode?: number;
  errmsg?: string;
  description?: string;
}

export class TtlockApiError extends Error {
  readonly status: number;
  readonly body: TtlockApiErrorBody | unknown;

  constructor(message: string, status: number, body: TtlockApiErrorBody | unknown) {
    super(message);
    this.name = "TtlockApiError";
    this.status = status;
    this.body = body;
  }
}
