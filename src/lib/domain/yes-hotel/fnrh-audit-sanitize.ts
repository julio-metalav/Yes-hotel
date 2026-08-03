/**
 * Mascaramento para payloads de auditoria FNRH (sem dados sensíveis completos).
 */

const SENSITIVE_KEY =
  /documento|document|token|senha|password|keyboardPwd|assinatura|base64|foto|facial|biometr|storage_path|cpf|rg_numero/i;

export function sanitizeFnrhAuditState(
  state: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!state || typeof state !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (typeof value === "string" && value.length > 80) {
      out[key] = `${value.slice(0, 8)}…`;
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = sanitizeFnrhAuditState(value as Record<string, unknown>);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function assertAuditPayloadSafe(value: unknown): void {
  const json = JSON.stringify(value);
  if (/"token"\s*:\s*"(?!\[redacted\])[^"]{8,}"/i.test(json)) {
    throw new Error("Auditoria contém token em claro.");
  }
  if (/"keyboardPwd"\s*:/i.test(json) || /"assinatura_base64"\s*:/i.test(json)) {
    throw new Error("Auditoria contém dado sensível proibido.");
  }
  if (/"documento"\s*:\s*"(?!\[redacted\])[^"]+"/i.test(json)) {
    throw new Error("Auditoria contém documento completo.");
  }
}
