/**
 * Port OCR FNRH — interface + no-op (provider ausente no repo).
 */

export type FnrhOcrDocumentSide = "front" | "back" | "single";

export type FnrhOcrRequest = {
  storage_ref: string;
  document_type: string;
  side?: FnrhOcrDocumentSide;
  mime_type?: string;
};

export type FnrhOcrSuggestedFields = {
  hospede_nome?: string;
  documento_numero?: string;
  documento_tipo?: string;
  data_nascimento?: string;
  orgao_emissor?: string;
  pais_emissor?: string;
  sexo?: string;
  nacionalidade?: string;
};

export type FnrhOcrResult = {
  ok: boolean;
  provider: string;
  suggested_fields: FnrhOcrSuggestedFields;
  confidence: Record<string, number>;
  provenance: "ocr";
  skipped: boolean;
  reason?: string;
};

export interface FnrhOcrProvider {
  readonly name: string;
  extract(request: FnrhOcrRequest): Promise<FnrhOcrResult>;
}

/** No-op: OCR desligado / provider não contratado. */
export class NoopFnrhOcrProvider implements FnrhOcrProvider {
  readonly name = "noop";

  async extract(_request: FnrhOcrRequest): Promise<FnrhOcrResult> {
    return {
      ok: true,
      provider: this.name,
      suggested_fields: {},
      confidence: {},
      provenance: "ocr",
      skipped: true,
      reason: "ocr_provider_unavailable",
    };
  }
}

export function createFnrhOcrProvider(enabled: boolean): FnrhOcrProvider {
  // Mesmo com flag true, sem provider real no repo → no-op (fail-closed funcional).
  void enabled;
  return new NoopFnrhOcrProvider();
}
