-- Migration aditiva: settled_amount_cents em financial_entries.
-- Omie AR/AP (pivot 4) traz bruto, liquidado e aberto ao mesmo tempo.
-- net_amount_cents permanece semântica distinta (após taxa/imposto) e NÃO recebe o liquidado.
-- NÃO aplicar em produção nesta rodada.

alter table public.financial_entries
  add column if not exists settled_amount_cents bigint;

alter table public.financial_entries
  drop constraint if exists financial_entries_money_check;

alter table public.financial_entries
  add constraint financial_entries_money_check
  check (
    (gross_amount_cents is null or gross_amount_cents >= 0)
    and (net_amount_cents is null or net_amount_cents >= 0)
    and (fee_cents is null or fee_cents >= 0)
    and (tax_cents is null or tax_cents >= 0)
    and (open_amount_cents is null or open_amount_cents >= 0)
    and (settled_amount_cents is null or settled_amount_cents >= 0)
  );

comment on column public.financial_entries.settled_amount_cents is
  'Valor liquidado/pago/recebido na origem analítica. Distinto de net_amount_cents e de open_amount_cents.';
