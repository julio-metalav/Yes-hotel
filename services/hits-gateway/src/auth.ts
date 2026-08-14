/**
 * Bearer token Yes → Gateway. Comparação em tempo constante.
 * Não loga Authorization nem o token.
 */

import { constantTimeEqual } from "../../../src/lib/integrations/ttlock/access-ingest/constant-time.ts";

export function extractBearerToken(authorizationHeader: string | undefined): string | null {
  const raw = String(authorizationHeader ?? "").trim();
  const match = /^Bearer\s+(\S+)/i.exec(raw);
  if (!match) return null;
  return match[1] ?? null;
}

export function isValidGatewayBearer(
  authorizationHeader: string | undefined,
  expectedToken: string,
): boolean {
  if (!expectedToken) return false;
  const provided = extractBearerToken(authorizationHeader);
  if (!provided) return false;
  return constantTimeEqual(provided, expectedToken);
}
