# Yes Hotel — Fundação financeira V1

Contrato persistente do módulo financeiro/auditoria. **Não aplicar em produção nesta rodada.**

`financial_entries` é a **camada normalizada de fatos financeiros importados/projetados**. Não é livro-razão oficial. HITS, Omie e banco permanecem fontes distintas e não devem ser somados como um único fato.

## Escopo deste PR

Schema `financial_*`, bucket privado, RLS admin-only, seed Sicredi, contratos TS. Sem parser, sem Claude, sem UI, sem backfill, sem alteração HITS/Pagar.me/management.

## Tabelas

| Tabela | Papel |
|---|---|
| `financial_accounts` | Contas Yes (`sicredi_principal`, `sicredi_0911`). Máscara 2–4 dígitos. |
| `financial_imports` | Arquivo/fonte. Identidade `(file_sha256, parser_version)`. |
| `financial_import_row_errors` | Erro por linha, excerpt sanitizado. |
| `financial_entries` | Fato normalizado (centavos). |
| `financial_reconciliation_groups` | Grupo de match + `score_evidence`. |
| `financial_reconciliation_legs` | Pernas 1:N / N:1 / parcial. |
| `financial_audit_findings` | Divergências. Sem `fraude_confirmada`. |
| `financial_ai_analyses` | Contrato futuro do assistente. Sem Anthropic neste PR. |

## O que vai na linha vs no arquivo

**Na linha (`financial_entries`):** valores em centavos, datas, direção, IDs de origem, `person_name` curto, `person_document_hash` (SHA-256), `description` ≤500, `reservation_ref` lógico sem FK, `raw_payload` allowlist sanitizada.

**Só no bucket privado `financial-imports`:** XLSX/OFX original. CPF/CNPJ completo, agência/conta, MEMO integral e planilha crua não devem ser duplicados em `raw_payload`.

Chaves proibidas em `raw_payload`: `cpf`, `cnpj`, `account_number`, `agencia`, `conta`, `pan`, etc. (ver check SQL + `src/lib/financial/payload.ts`).

## Reimport

Mesmo `file_sha256` + mesma `parser_version` → rejeitar.  
Mesmo arquivo + `parser_version` nova → nova importação. A anterior pode ser marcada `superseded`; linhas antigas `voided_by_reimport`. Sem overwrite silencioso.

## RLS

Leitura: `financial_admin_can_read()` (admin ativo). Recepção e café não leem.  
Escrita authenticated: negada. Escrita futura: Edge Function + `service_role`.

## KPIs (futuro)

HITS = operação/receita da hospedagem. Omie = faturamento/financeiro. Banco = caixa/liquidação.
