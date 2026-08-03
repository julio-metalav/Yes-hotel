/**
 * Contrato puro da estratégia de suspensão/restauração reversível da mesma senha.
 * Sem I/O e sem execução remota — apenas decisão/domínio.
 */

export type SuspensionTarget = "apartamento" | "portao_externo" | "portao_interno";

export type AccessSuspensionStrategy = {
  operation: "change_validity";
  preserve_passcode: true;
  delete_allowed: false;
  freeze_lock_allowed: false;
  revoke_allowed: false;
  new_passcode_allowed: false;
  targets: SuspensionTarget[];
  original_valid_from: string;
  original_valid_until: string;
  suspended_valid_until: string;
};

export type AccessRestoreStrategy = {
  operation: "change_validity";
  preserve_passcode: true;
  delete_allowed: false;
  freeze_lock_allowed: false;
  revoke_allowed: false;
  new_passcode_allowed: false;
  targets: SuspensionTarget[];
  restore_valid_from: string;
  restore_valid_until: string;
};

export type BuildSuspensionStrategyInput = {
  original_valid_from: string;
  original_valid_until: string;
  /** Instantâneo da suspensão (ISO UTC) — vira o novo fim de validade temporário. */
  suspended_at: string;
};

const DEFAULT_TARGETS: SuspensionTarget[] = [
  "apartamento",
  "portao_externo",
  "portao_interno",
];

function assertIso(value: string, label: string): string {
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) {
    throw new Error(`${label} inválido: ${value}`);
  }
  return new Date(t).toISOString();
}

/**
 * Monta o contrato de suspensão: mesma senha, só validade, nos 3 destinos.
 * Não executa TTLock.
 */
export function buildAccessSuspensionStrategy(
  input: BuildSuspensionStrategyInput,
): AccessSuspensionStrategy {
  const original_valid_from = assertIso(input.original_valid_from, "original_valid_from");
  const original_valid_until = assertIso(input.original_valid_until, "original_valid_until");
  const suspended_valid_until = assertIso(input.suspended_at, "suspended_at");

  if (new Date(original_valid_until).getTime() <= new Date(original_valid_from).getTime()) {
    throw new Error("Validade original inválida: until deve ser posterior a from.");
  }

  return {
    operation: "change_validity",
    preserve_passcode: true,
    delete_allowed: false,
    freeze_lock_allowed: false,
    revoke_allowed: false,
    new_passcode_allowed: false,
    targets: [...DEFAULT_TARGETS],
    original_valid_from,
    original_valid_until,
    suspended_valid_until,
  };
}

/**
 * Restauração: devolve exatamente a validade original da mesma senha.
 */
export function buildAccessRestoreStrategy(input: {
  original_valid_from: string;
  original_valid_until: string;
}): AccessRestoreStrategy {
  const restore_valid_from = assertIso(input.original_valid_from, "original_valid_from");
  const restore_valid_until = assertIso(input.original_valid_until, "original_valid_until");

  return {
    operation: "change_validity",
    preserve_passcode: true,
    delete_allowed: false,
    freeze_lock_allowed: false,
    revoke_allowed: false,
    new_passcode_allowed: false,
    targets: [...DEFAULT_TARGETS],
    restore_valid_from,
    restore_valid_until,
  };
}

/** Invariantes de segurança do contrato (testáveis). */
export function assertSuspensionContractSafe(
  strategy: AccessSuspensionStrategy | AccessRestoreStrategy,
): void {
  if (strategy.operation !== "change_validity") {
    throw new Error("Operação deve ser change_validity.");
  }
  if (!strategy.preserve_passcode) {
    throw new Error("Passcode deve ser preservado.");
  }
  if (strategy.delete_allowed || strategy.freeze_lock_allowed || strategy.revoke_allowed) {
    throw new Error("delete/freeze/revoke não são permitidos.");
  }
  if (strategy.new_passcode_allowed) {
    throw new Error("Geração de nova senha não é permitida.");
  }
  if (strategy.targets.length !== 3) {
    throw new Error("Devem ser exatamente 3 destinos.");
  }
}
