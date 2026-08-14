/**
 * Feature flags server-side do ciclo de tolerância / suspensão / outbox.
 * Defaults desligados. Sem NEXT_PUBLIC_*.
 */

function read(name: string, env: Record<string, string | undefined> = process.env): string {
  return String(env[name] ?? "").trim();
}

function exactTrue(name: string, env?: Record<string, string | undefined>): boolean {
  return read(name, env) === "true";
}

export type AccessToleranceFlags = {
  /** Processador de tolerâncias (due/restore). */
  processorEnabled: boolean;
  /** Execução real TTLock change_validity (sem newKeyboardPwd). */
  ttlockSuspensionEnabled: boolean;
  /** Dispatcher da operacional_acesso_outbox. */
  outboxDispatchEnabled: boolean;
  /** Envio real DigiSac (exige também DIGISAC_USE_MOCK=false + config). */
  digisacRealEnabled: boolean;
  /** Envio real de e-mail (exige RESEND_API_KEY + from). */
  emailRealEnabled: boolean;
  /**
   * Lock homologado. Execução TTLock real exige valor (fail-closed se ausente).
   * Não hardcodar. Dry-run pode listar com ou sem filtro.
   */
  homologLockIdFilter: number | null;
  /** Número interno DigiSac (somente dígitos recomendados). Placeholder até secret. */
  digisacInternalNumber: string;
};

export function getAccessToleranceFlags(
  env: Record<string, string | undefined> = process.env,
): AccessToleranceFlags {
  const lockRaw = read("YES_HOTEL_TTLOCK_HOMOLOG_LOCK_ID", env);
  let homologLockIdFilter: number | null = null;
  if (lockRaw) {
    const n = Number(lockRaw);
    if (Number.isFinite(n) && n > 0) homologLockIdFilter = Math.floor(n);
  }

  return {
    processorEnabled: exactTrue("YES_HOTEL_ACCESS_TOLERANCE_PROCESSOR_ENABLED", env),
    ttlockSuspensionEnabled: exactTrue("YES_HOTEL_TTLOCK_SUSPENSION_ENABLED", env),
    outboxDispatchEnabled: exactTrue("YES_HOTEL_ACCESS_OUTBOX_DISPATCH_ENABLED", env),
    // Fail-closed: ausência de DIGISAC_USE_MOCK NÃO ativa envio real.
    digisacRealEnabled:
      exactTrue("YES_HOTEL_ACCESS_DIGISAC_REAL_ENABLED", env) &&
      read("DIGISAC_USE_MOCK", env) === "false",
    emailRealEnabled:
      exactTrue("YES_HOTEL_ACCESS_EMAIL_REAL_ENABLED", env) &&
      Boolean(read("RESEND_API_KEY", env)),
    homologLockIdFilter,
    digisacInternalNumber: read("YES_HOTEL_DIGISAC_INTERNAL_NUMBER", env),
  };
}

export function isAccessToleranceProcessorEnabled(
  flags?: AccessToleranceFlags,
): boolean {
  return (flags ?? getAccessToleranceFlags()).processorEnabled;
}

/**
 * dry-run efetivo do Edge.
 * Cliente pode pedir dry_run=false; execução real só com flag TTLock + homolog lock.
 * Ausência / true → dry-run. Homolog ausente → dry-run (fail-closed).
 */
export function resolveAccessToleranceEffectiveDryRun(
  bodyDryRun: unknown,
  flags: AccessToleranceFlags,
): boolean {
  if (bodyDryRun !== false) return true;
  if (!flags.ttlockSuspensionEnabled) return true;
  if (flags.homologLockIdFilter == null) return true;
  return false;
}
