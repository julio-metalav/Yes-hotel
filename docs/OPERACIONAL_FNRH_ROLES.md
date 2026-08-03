# PR4 — Papéis de hóspede e ciclo formal FNRH

## Objetivo

Completar o modelo operacional para representar `primary_adult`, `adult_companion`,
`minor`, responsável, confirmação e estados formais da ficha — sem UI, OCR, envio
ou ativação de ingestão.

## Migration

`supabase/migrations/0024_operacional_hospedes_fnrh_roles.sql` — **não aplicada**.

Depende logicamente de `is_yes_hotel_ops_reader()` (também em 0022; recriada de forma
idempotente em 0024).

## Compatibilidade

- Mantém `operacional_hospedes.principal` e `fnrh_hospedes.status` (legado).
- Novas colunas nullable; legado sem `guest_role` → `requires_classification` /
  ConfigurationError no adapter de primeiro acesso.
- Não classifica automaticamente dados reais neste PR.

## Segurança

- `confirmation_token_ref`: referência opaca (nunca token em claro).
- `operacional_fnrh_auditoria`: append-only (triggers bloqueiam UPDATE/DELETE).
- Authenticated JWT não altera `guest_role`, responsável nem lifecycle formal
  (triggers); escrita via service_role/Edge.
- Confirmação pública continua por token em Edge/RPC — sem policy ampla.

## Testes

```bash
npm run test:yes:fnrh-roles-completion
```
