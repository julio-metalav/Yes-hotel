/**
 * Retry resiliente de provisionamento TTLock:
 * erro transitório → mesmo PIN; colisão -3007 → novo PIN (fora deste módulo);
 * timeout inconclusivo → reconciliar via listKeyboardPwd antes de trocar PIN.
 */

import { isTtlockSamePasscodeError } from "./ttlock-credential-format.ts";

/** Tentativa inicial + até 6 retries (~10s) ≈ 1 minuto na fase curta. */
export const TTLOCK_PROVISION_SHORT_RETRY_MAX = 6;
export const TTLOCK_PROVISION_SHORT_DELAY_MS = 10_000;
/** Orçamento total de sleep na Edge (evita estourar wall-clock). */
export const TTLOCK_PROVISION_SHORT_BUDGET_MS = 70_000;
/** Fase 2: reentradas assíncronas (ex.: novo lifecycle_provision) a cada ~1 min, máx. 5. */
export const TTLOCK_PROVISION_PHASE2_MAX = 5;

export type TtlockProvisionErrorClass =
  | "transient"
  | "uncertain"
  | "collision"
  | "auth_config"
  | "definitive";

export type TtlockProvisionErrorClassification = {
  class: TtlockProvisionErrorClass;
  transient: boolean;
  /** Timeout/abort/resposta inconclusiva: pode ter criado PIN remota. */
  uncertain: boolean;
  retrySamePin: boolean;
  httpStatus: number | null;
  ttlockErrcode: number | null;
  reason: string;
};

const TRANSIENT_TTLOCK_ERRCODES = new Set([10001, 10002, 10003, 10004]);

function extractTtlockErrcode(message: string, body?: unknown): number | null {
  if (body && typeof body === "object" && body !== null && "errcode" in body) {
    const n = Number((body as { errcode?: unknown }).errcode);
    if (Number.isFinite(n)) return n;
  }
  const m = String(message || "").match(/TTLock erro\s+(-?\d+)/i);
  if (m) return Number(m[1]);
  return null;
}

function extractHttpStatus(err: unknown): number | null {
  if (err && typeof err === "object" && "status" in err) {
    const n = Number((err as { status?: unknown }).status);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Classifica erro de add/list TTLock para política de retry.
 * ERRO TRANSITÓRIO NÃO É COLISÃO DE PIN.
 */
export function classifyTtlockProvisionError(
  err: unknown,
  opts?: { priorUncertain?: boolean },
): TtlockProvisionErrorClassification {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const name = err instanceof Error ? err.name : "";
  const httpStatus = extractHttpStatus(err);
  const body =
    err && typeof err === "object" && "body" in err
      ? (err as { body?: unknown }).body
      : undefined;
  const ttlockErrcode = extractTtlockErrcode(message, body);
  const lower = message.toLowerCase();

  // Config / auth definitivos
  if (
    /credenciais nao configuradas|não configurado|nao configurado|variáveis de ambiente|variaveis de ambiente/i.test(
      message,
    )
  ) {
    return {
      class: "auth_config",
      transient: false,
      uncertain: false,
      retrySamePin: false,
      httpStatus,
      ttlockErrcode,
      reason: "ttlock_not_configured",
    };
  }
  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    /invalid_client|invalid_grant|unauthorized|token.*invalid|access_token.*invalid|client_id.*invalid/i.test(
      message,
    )
  ) {
    return {
      class: "auth_config",
      transient: false,
      uncertain: false,
      retrySamePin: false,
      httpStatus,
      ttlockErrcode,
      reason: "auth_rejected",
    };
  }

  // Colisão de PIN (-3007)
  if (isTtlockSamePasscodeError(message) || ttlockErrcode === -3007) {
    return {
      class: "collision",
      transient: false,
      uncertain: Boolean(opts?.priorUncertain),
      retrySamePin: false,
      httpStatus,
      ttlockErrcode: ttlockErrcode ?? -3007,
      reason: "same_passcode",
    };
  }

  const isAbort =
    name === "AbortError" ||
    /aborted|abort|timeout|timed out|etimedout|econnreset|econnrefused|enotfound|network|fetch failed|socket hang up|gateway/i.test(
      lower,
    );
  const isHttpTransient =
    httpStatus === 429 || (httpStatus != null && httpStatus >= 500);
  const isTtlockTransient =
    ttlockErrcode != null && TRANSIENT_TTLOCK_ERRCODES.has(ttlockErrcode);
  const isInconclusive =
    /sem keyboardpwdid|respondeu não-json|respondeu nao-json|resposta.*inconclus/i.test(
      lower,
    );

  if (isAbort || isHttpTransient || isTtlockTransient || isInconclusive) {
    const uncertain =
      /timeout|timed out|aborted|abort|sem keyboardpwdid|inconclus/i.test(lower) ||
      name === "AbortError" ||
      isInconclusive;
    return {
      class: uncertain ? "uncertain" : "transient",
      transient: true,
      uncertain,
      retrySamePin: true,
      httpStatus,
      ttlockErrcode,
      reason: uncertain ? "uncertain_after_request" : "transient_network_or_http",
    };
  }

  // 4xx restantes = definitivos (não loop)
  if (httpStatus != null && httpStatus >= 400 && httpStatus < 500) {
    return {
      class: "definitive",
      transient: false,
      uncertain: false,
      retrySamePin: false,
      httpStatus,
      ttlockErrcode,
      reason: "http_4xx",
    };
  }

  // Erro TTLock de negócio desconhecido: não retry cego
  if (ttlockErrcode != null && ttlockErrcode !== 0) {
    return {
      class: "definitive",
      transient: false,
      uncertain: false,
      retrySamePin: false,
      httpStatus,
      ttlockErrcode,
      reason: "ttlock_business_error",
    };
  }

  // Default conservador: tratar como transitório (rede/mensagem genérica)
  return {
    class: "transient",
    transient: true,
    uncertain: Boolean(opts?.priorUncertain),
    retrySamePin: true,
    httpStatus,
    ttlockErrcode,
    reason: "unknown_default_transient",
  };
}

export type TtlockListedPasscode = {
  keyboardPwdId: number;
  keyboardPwd?: string | null;
  keyboardPwdName?: string | null;
  startDate?: number | null;
  endDate?: number | null;
  sendDate?: number | null;
  status?: number | null;
};

/**
 * Localiza o PIN na listagem read-only (sem logar o PIN).
 * Mais de um passcode igual é ambíguo: não escolhe um id.
 */
export function findListedPasscodeMatch(
  list: TtlockListedPasscode[] | null | undefined,
  candidatePin: string,
): TtlockListedPasscode | null {
  const pin = String(candidatePin || "").trim();
  if (!pin || !Array.isArray(list)) return null;
  const matches = list.filter(
    (row) =>
      String(row?.keyboardPwd ?? "").trim() === pin && typeof row.keyboardPwdId === "number",
  );
  if (matches.length !== 1) return null;
  return matches[0] ?? null;
}

/**
 * Item que o provisionamento ainda precisa tentar.
 * `falhou` volta mesmo com remote id: o id residual é a pista da reconciliação,
 * não motivo para deixar a credencial presa.
 */
export function itemNeedsProvisionRetry(item: {
  status_provisionamento?: string | null;
  remote_keyboard_pwd_id?: number | string | null;
}): boolean {
  const st = String(item.status_provisionamento ?? "").trim();
  return st === "pendente" || st === "provisionando" || st === "falhou";
}

export type TransientRetryState = {
  phase: 1 | 2;
  count: number;
  errorClass: string;
  nextEligibleAt: string | null;
};

const TRANSIENT_STATE_PREFIX = "TTLOCK_TRANSIENT_RETRY|";

export function encodeTransientRetryState(state: TransientRetryState): string {
  return (
    TRANSIENT_STATE_PREFIX +
    `phase=${state.phase};count=${state.count};class=${state.errorClass};next_eligible_at=${state.nextEligibleAt ?? ""}`
  );
}

export function parseTransientRetryState(
  raw: string | null | undefined,
): TransientRetryState | null {
  const s = String(raw || "");
  if (!s.startsWith(TRANSIENT_STATE_PREFIX)) return null;
  const body = s.slice(TRANSIENT_STATE_PREFIX.length);
  const map = new Map<string, string>();
  for (const part of body.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    map.set(part.slice(0, i), part.slice(i + 1));
  }
  const phaseRaw = Number(map.get("phase") || 1);
  const count = Number(map.get("count") || 0);
  return {
    phase: phaseRaw === 2 ? 2 : 1,
    count: Number.isFinite(count) ? count : 0,
    errorClass: map.get("class") || "transient",
    nextEligibleAt: map.get("next_eligible_at") || null,
  };
}

export function formatProvisionItemTransientError(params: {
  classification: TtlockProvisionErrorClassification;
  retryCount: number;
  nextRetryAt: string | null;
  phase: 1 | 2;
}): string {
  // Sem PIN / secrets
  return (
    `Erro transitório TTLock (${params.classification.class}/${params.classification.reason}); ` +
    `transient=true; retry_count=${params.retryCount}; phase=${params.phase}` +
    (params.nextRetryAt ? `; next_retry=${params.nextRetryAt}` : "") +
    (params.classification.httpStatus != null
      ? `; http=${params.classification.httpStatus}`
      : "") +
    (params.classification.ttlockErrcode != null
      ? `; errcode=${params.classification.ttlockErrcode}`
      : "")
  );
}

export type ShortRetryBudget = {
  sleptMs: number;
  maxBudgetMs: number;
};

export async function sleepWithinBudget(
  ms: number,
  budget: ShortRetryBudget,
  sleepFn: (ms: number) => Promise<void>,
): Promise<boolean> {
  if (ms <= 0) return true;
  if (budget.sleptMs + ms > budget.maxBudgetMs) return false;
  await sleepFn(ms);
  budget.sleptMs += ms;
  return true;
}

export type ProvisionLockAttemptResult =
  | { ok: true; keyboardPwdId: number; reconciled: boolean; attempts: number }
  | {
      ok: false;
      classification: TtlockProvisionErrorClassification;
      message: string;
      attempts: number;
      stillRetryable: boolean;
      uncertain: boolean;
    };

/**
 * -3007 só vira sucesso com um único passcode igual ao PIN na listagem,
 * e só se pudermos atribuí-lo a esta credencial.
 * Listagem ausente, ambígua ou PIN de outra credencial continua falha fechada.
 */
async function reconcileOwnedPasscode(params: {
  passcode: string;
  listPasscodes: () => Promise<TtlockListedPasscode[]>;
  pinClaimAllowed?: boolean;
  knownKeyboardPwdId?: number | null;
}): Promise<TtlockListedPasscode | null> {
  let listed: TtlockListedPasscode[];
  try {
    listed = await params.listPasscodes();
  } catch {
    return null;
  }
  const match = findListedPasscodeMatch(listed, params.passcode);
  if (!match) return null;
  const known = params.knownKeyboardPwdId;
  const knownMatches = typeof known === "number" && known === match.keyboardPwdId;
  if (params.pinClaimAllowed === false && !knownMatches) return null;
  return match;
}

/**
 * Uma fechadura: add com retry do mesmo PIN + reconciliação em estado incerto.
 */
export async function attemptProvisionLockWithSamePinRetry(params: {
  passcode: string;
  shortRetryMax?: number;
  shortDelayMs?: number;
  budget: ShortRetryBudget;
  sleepFn?: (ms: number) => Promise<void>;
  addPasscode: () => Promise<number>;
  listPasscodes: () => Promise<TtlockListedPasscode[]>;
  /**
   * false quando outra credencial já ocupa este PIN no lock.
   * Nesse caso -3007 não vira sucesso, mesmo que a listagem mostre o PIN.
   */
  pinClaimAllowed?: boolean;
  /** Id já gravado neste item. Se bater com a listagem, o passcode é nosso. */
  knownKeyboardPwdId?: number | null;
  onAttemptLog?: (info: {
    attempt: number;
    classification: TtlockProvisionErrorClassification | null;
    reconciled?: boolean;
    status: "start" | "retry" | "reconciled" | "error";
  }) => void;
}): Promise<ProvisionLockAttemptResult> {
  const shortRetryMax = params.shortRetryMax ?? TTLOCK_PROVISION_SHORT_RETRY_MAX;
  const shortDelayMs = params.shortDelayMs ?? TTLOCK_PROVISION_SHORT_DELAY_MS;
  const sleepFn =
    params.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let priorUncertain = false;
  let lastClass: TtlockProvisionErrorClassification | null = null;
  let lastMessage = "";
  let attempts = 0;

  for (let retry = 0; retry <= shortRetryMax; retry++) {
    attempts = retry + 1;
    if (retry > 0) {
      const slept = await sleepWithinBudget(shortDelayMs, params.budget, sleepFn);
      if (!slept) {
        return {
          ok: false,
          classification:
            lastClass ??
            ({
              class: "transient",
              transient: true,
              uncertain: priorUncertain,
              retrySamePin: true,
              httpStatus: null,
              ttlockErrcode: null,
              reason: "budget_exhausted",
            } satisfies TtlockProvisionErrorClassification),
          message: lastMessage || "Orçamento de retry curto esgotado; pendente fase 2.",
          attempts,
          stillRetryable: true,
          uncertain: priorUncertain,
        };
      }
      params.onAttemptLog?.({
        attempt: attempts,
        classification: lastClass,
        status: "retry",
      });
    } else {
      params.onAttemptLog?.({ attempt: attempts, classification: null, status: "start" });
    }

    try {
      const keyboardPwdId = await params.addPasscode();
      return { ok: true, keyboardPwdId, reconciled: false, attempts };
    } catch (e) {
      const classification = classifyTtlockProvisionError(e, {
        priorUncertain,
      });
      lastClass = classification;
      lastMessage = e instanceof Error ? e.message : String(e);
      params.onAttemptLog?.({
        attempt: attempts,
        classification,
        status: "error",
      });

      if (classification.class === "collision") {
        const match = await reconcileOwnedPasscode(params);
        if (match) {
          params.onAttemptLog?.({
            attempt: attempts,
            classification,
            reconciled: true,
            status: "reconciled",
          });
          return {
            ok: true,
            keyboardPwdId: match.keyboardPwdId,
            reconciled: true,
            attempts,
          };
        }
        return {
          ok: false,
          classification,
          message: lastMessage,
          attempts,
          stillRetryable: false,
          uncertain: priorUncertain,
        };
      }

      if (classification.class === "auth_config" || classification.class === "definitive") {
        return {
          ok: false,
          classification,
          message: lastMessage,
          attempts,
          stillRetryable: false,
          uncertain: false,
        };
      }

      // transient / uncertain
      if (classification.uncertain) priorUncertain = true;
      try {
        const listed = await params.listPasscodes();
        const match = findListedPasscodeMatch(listed, params.passcode);
        if (match) {
          params.onAttemptLog?.({
            attempt: attempts,
            classification,
            reconciled: true,
            status: "reconciled",
          });
          return {
            ok: true,
            keyboardPwdId: match.keyboardPwdId,
            reconciled: true,
            attempts,
          };
        }
      } catch {
        // list falhou: segue retry do mesmo PIN
      }

      if (retry >= shortRetryMax) {
        return {
          ok: false,
          classification,
          message: lastMessage,
          attempts,
          stillRetryable: true,
          uncertain: priorUncertain,
        };
      }
    }
  }

  return {
    ok: false,
    classification:
      lastClass ??
      ({
        class: "transient",
        transient: true,
        uncertain: priorUncertain,
        retrySamePin: true,
        httpStatus: null,
        ttlockErrcode: null,
        reason: "exhausted",
      } satisfies TtlockProvisionErrorClassification),
    message: lastMessage || "Retry curto esgotado",
    attempts,
    stillRetryable: true,
    uncertain: priorUncertain,
  };
}
