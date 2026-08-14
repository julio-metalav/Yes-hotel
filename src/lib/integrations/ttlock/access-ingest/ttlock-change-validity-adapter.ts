/**
 * Adapter TTLock: altera somente validade via changeKeyboardPassword.
 * Nunca envia newKeyboardPwd. Nunca usa updateKeyboardPassword.
 */

import type { TtlockClient } from "../../ttlock/client.ts";
import type {
  TtlockValidityChangePort,
  TtlockValidityChangeRequest,
  TtlockValidityChangeResult,
} from "../../../application/yes-hotel/first-room-access-ports.ts";
import { TtlockApiError } from "../types.ts";
import {
  formatTtlockPublicErrorMessage,
  parseTtlockPublicError,
} from "../ttlock-api-error.ts";

function publicChangeError(e: unknown): string {
  if (e instanceof TtlockApiError) {
    const pub = parseTtlockPublicError(e.status, e.body);
    return formatTtlockPublicErrorMessage(pub).slice(0, 400);
  }
  return (e instanceof Error ? e.message : "ttlock_error").slice(0, 400);
}

export class TtlockChangeValidityAdapter implements TtlockValidityChangePort {
  constructor(private readonly client: TtlockClient) {}

  async changeValidityOnly(
    req: TtlockValidityChangeRequest,
  ): Promise<TtlockValidityChangeResult> {
    try {
      // changeKeyboardPassword sem newKeyboardPwd — só startDate/endDate.
      await this.client.changeKeyboardPassword({
        lockId: req.lockId,
        keyboardPwdId: req.keyboardPwdId,
        startDate: req.startDateMs,
        endDate: req.endDateMs,
      });
      return { ok: true };
    } catch (e) {
      const msg = publicChangeError(e);
      const retryable =
        /timeout|abort|network|429|5\d\d/i.test(msg) ||
        (e instanceof Error && e.name === "AbortError");
      return { ok: false, error: msg, retryable };
    }
  }
}
