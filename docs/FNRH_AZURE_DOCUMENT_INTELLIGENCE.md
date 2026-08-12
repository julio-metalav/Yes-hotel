# Azure Document Intelligence — FNRH OCR (alternativa)

Modelo: `prebuilt-idDocument`  
API: `2024-11-30`

Provider preferencial atual (quando secrets Google estão no Supabase): **Google Vision** — ver `docs/FNRH_GOOGLE_VISION_OCR.md`.

## Secrets Azure (Supabase Edge — nunca no Git)

```
FNRH_OCR_ENABLED=false
FNRH_OCR_PROVIDER=azure
AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT=https://<resource>.cognitiveservices.azure.com
AZURE_DOCUMENT_INTELLIGENCE_KEY=<key>
```

Ativar OCR só com `FNRH_OCR_ENABLED=true` **e** endpoint/key válidos.

## Ação manual no Azure Portal

1. Criar recurso **Azure AI Document Intelligence** (ou Cognitive Services multi-service).
2. Copiar **Endpoint** e **Key**.
3. Configurar secrets no projeto Supabase `minmmecajnmjqlgacfoz`.
4. Manter `FNRH_OCR_ENABLED=false` até smoke controlado.
5. Homologar com documento autorizado (não usar doc real de terceiro).
6. Só então ligar Production.

## Confidence (centralizado)

- HIGH ≥ 0.85 → preenche
- MEDIUM ≥ 0.60 → preenche + “Confira”
- LOW → não assume

## Consumo

View: `operacional_fnrh_ocr_pages_month` (`pages_processed_month`).
