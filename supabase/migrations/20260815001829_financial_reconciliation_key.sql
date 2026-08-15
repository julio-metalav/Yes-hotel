-- Idempotência de grupos de conciliação. Aditivo. Sem tocar operacional/PROD.
-- reconciliation_key = SHA-256(rule_version|match_method|entry_ids ordenados).

alter table public.financial_reconciliation_groups
  add column if not exists reconciliation_key text;

comment on column public.financial_reconciliation_groups.reconciliation_key is
  'Chave determinística do grupo (rule_version + match_method + IDs ordenados das entries). Sem timestamp.';

create unique index if not exists financial_reconciliation_groups_reconciliation_key_uidx
  on public.financial_reconciliation_groups (reconciliation_key)
  where reconciliation_key is not null;

-- Uma entry ativa em no máximo um grupo. Reuso é erro de persistência.
create unique index if not exists financial_reconciliation_legs_entry_uidx
  on public.financial_reconciliation_legs (entry_id);
