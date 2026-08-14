/**
 * Erro TTLock público: status + errcode/errmsg/description, sem secrets.
 */
const SECRET_KEY_RE =
  /"(?:accessToken|clientSecret|client_secret|password|passwd|keyboardPwd|newKeyboardPwd|token|authorization|apikey|api_key|secret)"\s*:/i;
const SECRET_ASSIGN_RE =
  /(?:accessToken|clientSecret|client_secret|password|passwd|keyboardPwd|newKeyboardPwd)=[^\s"'&<]+/gi;

export type TtlockPublicError = {
  http_status: number;
  errcode: number | null;
  errmsg: string | null;
  description: string | null;
  body_kind: "json" | "text" | "empty";
  body_preview: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function previewText(raw: string): string {
  const cut = raw
    .replace(SECRET_ASSIGN_RE, (m) => `${m.split("=")[0]}=[redacted]`)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  if (SECRET_KEY_RE.test(cut)) {
    return "[redacted_sensitive_keys]";
  }
  return cut;
}

export function parseTtlockPublicError(httpStatus: number, parsed: unknown): TtlockPublicError {
  if (parsed == null || parsed === "") {
    return {
      http_status: httpStatus,
      errcode: null,
      errmsg: null,
      description: null,
      body_kind: "empty",
      body_preview: "",
    };
  }
  if (typeof parsed === "string") {
    return {
      http_status: httpStatus,
      errcode: null,
      errmsg: null,
      description: null,
      body_kind: "text",
      body_preview: previewText(parsed),
    };
  }
  const rec = asRecord(parsed);
  if (!rec) {
    return {
      http_status: httpStatus,
      errcode: null,
      errmsg: null,
      description: null,
      body_kind: "text",
      body_preview: previewText(JSON.stringify(parsed)),
    };
  }
  const errcode = typeof rec.errcode === "number" ? rec.errcode : null;
  const errmsg = rec.errmsg == null ? null : String(rec.errmsg).slice(0, 200);
  const description = rec.description == null ? null : String(rec.description).slice(0, 200);
  return {
    http_status: httpStatus,
    errcode,
    errmsg,
    description,
    body_kind: "json",
    body_preview: previewText(
      JSON.stringify({
        errcode,
        errmsg,
        description,
      }),
    ),
  };
}

export function formatTtlockPublicErrorMessage(err: TtlockPublicError): string {
  const parts = [`http=${err.http_status}`, `kind=${err.body_kind}`];
  if (err.errcode != null) parts.push(`errcode=${err.errcode}`);
  if (err.errmsg) parts.push(`errmsg=${err.errmsg}`);
  if (err.description) parts.push(`description=${err.description}`);
  if (!err.errmsg && err.body_kind === "text" && err.body_preview) {
    parts.push(`body=${err.body_preview}`);
  }
  return `TTLock change failed (${parts.join(" ")})`;
}

export function assertTtlockPublicErrorSafe(err: TtlockPublicError): void {
  const json = JSON.stringify(err);
  if (SECRET_KEY_RE.test(json)) {
    throw new Error("Erro TTLock público contém chave sensível.");
  }
  if (/accessToken|clientSecret|keyboardPwd/i.test(json) && SECRET_KEY_RE.test(json)) {
    throw new Error("Erro TTLock público não sanitizado.");
  }
}
