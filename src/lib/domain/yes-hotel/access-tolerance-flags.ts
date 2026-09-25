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
   * Filtro OPCIONAL de rollback: quando definido, o efeito físico fica restrito
   * a essa fechadura. Ausente (o normal) = todas as fechaduras da reserva.
   *
   * Era pré-requisito de execução real durante a homologação, o que na prática
   * deixava o bloqueio de 1h valendo para um apartamento só. Deixou de ser
   * exigido; continua funcionando para reduzir o alcance em caso de problema.
   * Não hardcodar.
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
 *
 * Execução real exige duas coisas: o cliente pedir `dry_run: false` E a flag
 * `YES_HOTEL_TTLOCK_SUSPENSION_ENABLED` estar ligada. Ausência ou `true` no
 * body continua significando dry-run — o default segue fechado.
 *
 * `homologLockIdFilter` NÃO entra mais aqui. Enquanto entrava, apagar a secret
 * de homologação desligava o bloqueio inteiro em vez de ampliá-lo, e mantê-la
 * restringia o efeito a uma fechadura. Agora ela só reduz o alcance quando
 * presente; quem liga e desliga o efeito é a flag de suspensão.
 */
export function resolveAccessToleranceEffectiveDryRun(
  bodyDryRun: unknown,
  flags: AccessToleranceFlags,
): boolean {
  if (bodyDryRun !== false) return true;
  if (!flags.ttlockSuspensionEnabled) return true;
  return false;
}
