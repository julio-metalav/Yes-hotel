/**
 * Snapshot determinístico + SHA-256 para confirmação FNRH v2.
 * Sem I/O de rede. Usa Web Crypto quando disponível; fallback Node crypto.
 */

import { FNRH_V2_SCHEMA_VERSION } from "./fnrh-checkin-v2-policy.ts";

export type FnrhConfirmationSnapshotInput = {
  fnrh_id: string;
  reservation_id: string;
  guest_id: string;
  flow_version: "v2";
  schema_version?: string;
  terms_version: string;
  privacy_notice_version: string;
  data_confirmed: true;
  privacy_accepted: true;
  confirmation_source: "guest" | "responsible";
  completed_by_guest_id: string;
  confirmed_at: string;
  fields: Record<string, unknown>;
  documents: Array<{
    id?: string;
    document_type: string;
    document_subject: string;
    storage_ref: string;
  }>;
  minors?: Array<{
    guest_id: string;
    hospede_nome?: string;
    minor_relation?: string | null;
    minor_accompaniment?: string | null;
  }>;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Ordena chaves recursivamente para serialização estável. */
export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJson(item));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v === undefined) continue;
      out[key] = canonicalizeJson(v);
    }
    return out;
  }
  return value;
}

export function serializeConfirmationSnapshot(
  input: FnrhConfirmationSnapshotInput,
): string {
  const payload = canonicalizeJson({
    ...input,
    schema_version: input.schema_version ?? FNRH_V2_SCHEMA_VERSION,
    hash_algorithm: "SHA-256",
  });
  return JSON.stringify(payload);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const digest = await subtle.digest("SHA-256", copy);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Node fallback (scripts/testes)
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

export async function hashConfirmationSnapshot(canonicalJson: string): Promise<{
  snapshot_hash: string;
  hash_algorithm: "SHA-256";
  schema_version: string;
}> {
  const enc = new TextEncoder().encode(canonicalJson);
  const snapshot_hash = await sha256Hex(enc);
  return {
    snapshot_hash,
    hash_algorithm: "SHA-256",
    schema_version: FNRH_V2_SCHEMA_VERSION,
  };
}

export async function buildConfirmationProof(
  input: FnrhConfirmationSnapshotInput,
): Promise<{
  confirmation_snapshot: unknown;
  snapshot_json: string;
  snapshot_hash: string;
  hash_algorithm: "SHA-256";
  schema_version: string;
}> {
  const snapshot_json = serializeConfirmationSnapshot(input);
  const confirmation_snapshot = JSON.parse(snapshot_json) as unknown;
  const hashed = await hashConfirmationSnapshot(snapshot_json);
  return {
    confirmation_snapshot,
    snapshot_json,
    ...hashed,
  };
}
