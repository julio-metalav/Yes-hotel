/**
 * Helpers de hash/idempotência OCR (puro).
 */

export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const digest = await subtle.digest("SHA-256", copy);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

export function canRunNewOcrAttempt(input: {
  priorAttempts: number;
  maxAttempts: number;
  hasSuccessfulIdempotentHit: boolean;
}): { allowed: boolean; reason?: string } {
  if (input.hasSuccessfulIdempotentHit) {
    return { allowed: false, reason: "ocr_idempotent_hit" };
  }
  if (input.priorAttempts >= input.maxAttempts) {
    return { allowed: false, reason: "ocr_attempt_limit" };
  }
  return { allowed: true };
}
