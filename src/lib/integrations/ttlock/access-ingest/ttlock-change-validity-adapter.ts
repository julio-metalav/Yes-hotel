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
      const msg = e instanceof Error ? e.message.slice(0, 200) : "ttlock_error";
      const retryable =
        /timeout|abort|network|429|5\d\d/i.test(msg) ||
        (e instanceof Error && e.name === "AbortError");
      return { ok: false, error: msg, retryable };
    }
  }
}
