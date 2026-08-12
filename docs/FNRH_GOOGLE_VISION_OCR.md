# FNRH OCR — Google Cloud Vision

Feature flag (fail-closed):

```
FNRH_OCR_ENABLED=false
FNRH_OCR_PROVIDER=google
```

## Secrets (Supabase Edge — nunca no Git / logs / UI)

```
GOOGLE_CLOUD_PROJECT_ID
GOOGLE_SERVICE_ACCOUNT_EMAIL
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
```

Modelo/API: `DOCUMENT_TEXT_DETECTION` (`vision-document-text-detection` / `v1`).

## Identificadores canônicos

| Caso | `documento_tipo` | `documento_numero` |
|------|------------------|--------------------|
| Brasileiro (CPF explícito + checksum) | `cpf` | CPF |
| Estrangeiro (passaporte claro) | `passport` | nº passaporte |
| Sem identificador seguro | *(vazio)* | *(vazio)* — complemento manual |

Foto de CNH/RG/CIN é apenas **fonte**. Registro CNH / número RG **não** viram identificador.

`document_type=other` no upload é placeholder técnico — **nunca** vira `documento_tipo=other`.

## Fluxo

`fnrh-document-upload` → port OCR → `GoogleVisionOcrProvider` → normalização heurística → **persistência server-side** em `fnrh_hospedes` (com provenance `ocr`) → `suggested_fields` → UI.

- Auth: JWT service account → OAuth access token (server-side).
- Bytes do documento privado; sem URL pública permanente.
- OCR falhou / sem texto / timeout → upload **continua**; fallback manual.
- Precedência: `manual > ocr > hits > legacy`.
- CPF: só se rótulo explícito + checksum válido (nunca inventado).
- Autosave (`fnrh-submit` draft): só campos em `dirty_manual_fields` viram provenance `manual`.

## Ativar (após smoke controlado)

1. Confirmar secrets no projeto Supabase.
2. `FNRH_OCR_PROVIDER=google`
3. Redeploy `fnrh-document-upload` (e `fnrh-submit` se mudou autosave).
4. Smoke com documento autorizado (não usar doc real de terceiro).
5. Só então `FNRH_OCR_ENABLED=true`.

## Alternativa Azure

`FNRH_OCR_PROVIDER=azure` + `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` + `AZURE_DOCUMENT_INTELLIGENCE_KEY`.

Ver também `docs/FNRH_AZURE_DOCUMENT_INTELLIGENCE.md`.

## Telemetria

Tabela `operacional_fnrh_ocr_runs` / view `operacional_fnrh_ocr_pages_month` (sem PII).
