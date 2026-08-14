# Yes Hotel — Importação OFX Sicredi V1

Parser e normalização de extratos OFX Sicredi para `financial_entries`. **Não é UI, Omie, Claude, conciliação nem classificação receita/despesa.** Banco nesta fase é apenas fato bancário.

Não aplicar a migration de grants em produção nesta rodada. Não persistir extratos reais sem autorização.

## Deduplicação

1. **Com FITID:** `source_record_id = FITID`. A unique ativa `(source_system, source_kind, source_record_id)` impede a mesma origem duas vezes.
2. **Sem FITID:** `source_record_id` fica nulo. `normalized_hash` é canônico (sistema + conta + data + centavos + direção + descrição + referência externa) e serve para correlação, **não** para apagar linhas.
3. Duas transações bancárias legítimas iguais no mesmo dia **não** são tratadas como duplicata. Elas convivem via `(source_import_id, source_row)`.
4. FITID repetido **no mesmo arquivo**: a primeira linha vale; as seguintes viram `duplicate_source_record`.
5. Reimport do mesmo arquivo: identidade `(file_sha256, parser_version)`. Mesmo hash + mesma versão = import duplicado.

## Conta

O parser **não** usa nome de arquivo. Resolve por `BANKID` (Sicredi `748` quando presente) + últimos 4 dígitos de `ACCTID` contra `financial_accounts.account_mask`.

- last4 OFX = `0911` → `sicredi_0911` (resolução `mask`)
- `--account` é hint do operador; se a máscara cadastrada não aparecer no OFX, a conta fica `operator_hint` (não usa nome de arquivo)
- last4 OFX igual à máscara de **outra** conta Yes → `account_unresolved`
- sem hint e sem máscara casada → `account_unresolved`; nenhuma linha é atribuída

Nos OFX reais Sicredi, `0911` é apelido operacional: não aparece em `ACCTID`/`BRANCHID`.

Persistência exige `--account` **e** fingerprint cadastrado em `financial_accounts.metadata.ofx`:

```json
{ "ofx": { "bank_id": "748", "branch_fingerprint": null, "account_last4": "••••", "account_type": "CHECKING" } }
```

- last4/BANKID/ACCTTYPE — nunca número completo
- mismatch → `account_fingerprint_mismatch`, import inteiro aborta
- fingerprints reais ficam só no HOMO; não vão para o Git
- Storage do OFX original ainda não é feito neste backfill

Agência/conta completa não entram em `raw_payload` nem no dry-run.

## Datas e valores

Datas OFX (`YYYYMMDD`, `YYYYMMDDHHMMSS`, `…[offset:TZ]`) são parseadas sem `Date.parse`. Sem offset utilizável assume `America/Campo_Grande`. `settlement_date` = `YYYY-MM-DD`.

Valores: string OFX → centavos inteiros. Sem float. `"-1234.56"` → 123456 + débito.

## Saldos

`LEDGERBAL` / `AVAILBAL` ficam só no metadata do import. Não viram `financial_entry`.

## Grants (Fase 0)

`20260814233000_financial_grants_revoke_authenticated.sql` versiona o REVOKE de escrita de `authenticated` nas tabelas `financial_*`. A foundation V1 não deve ser editada retroativamente. Tabelas financeiras futuras precisam revogar o mesmo privilégio na própria migration.
