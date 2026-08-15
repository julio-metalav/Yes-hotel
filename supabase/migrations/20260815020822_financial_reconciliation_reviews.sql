-- PR G: decisões humanas de conciliação. Aditivo. Append-only.
-- Não altera financial_entries. Não mexe nos 601 auto_matched existentes.
-- NÃO aplicar em PROD nesta rodada.

create table if not exists public.financial_reconciliation_reviews (
  id uuid primary key default gen_random_uuid(),
  review_key text not null,
  review_type text not null
    check (review_type in (
      'suggested',
      'ambiguous',
      'unmatched_omie',
      'unmatched_bank',
      'possible_aggregation'
    )),
  status text not null
    check (status in (
      'confirmed',
      'rejected',
      'kept_unmatched',
      'awaiting_settlement',
      'possible_aggregation'
    )),
  action text not null
    check (action in (
      'confirm_match',
      'reject_suggestion',
      'reject_ambiguous',
      'mark_unmatched',
      'mark_awaiting_settlement',
      'mark_possible_aggregation',
      'mark_internal_transfer'
    )),
  omie_entry_id uuid references public.financial_entries (id) on delete restrict,
  bank_entry_id uuid references public.financial_entries (id) on delete restrict,
  candidate_entry_ids uuid[] not null default '{}',
  resulting_group_id uuid references public.financial_reconciliation_groups (id) on delete set null,
  rule_version text not null,
  score integer
    check (score is null or (score >= 0 and score <= 100)),
  score_evidence jsonb not null default '{}'::jsonb,
  actor_user_id uuid not null references public.usuarios_internos (id) on delete restrict,
  actor_role text not null,
  reason text,
  previous_state text,
  created_at timestamptz not null default now(),
  constraint financial_reconciliation_reviews_key_uidx unique (review_key),
  constraint financial_reconciliation_reviews_reason_len_check
    check (reason is null or length(reason) <= 500),
  constraint financial_reconciliation_reviews_key_shape_check
    check (review_key ~ '^[0-9a-f]{64}$')
);

comment on table public.financial_reconciliation_reviews is
  'Decisão humana append-only. Impede suggested/ambiguous rejeitados de reaparecerem. Sem fraude.';
comment on column public.financial_reconciliation_reviews.review_key is
  'SHA-256 determinística (rule_version + tipo + IDs). Idempotência da mesma decisão.';
comment on column public.financial_reconciliation_reviews.actor_user_id is
  'usuarios_internos.id derivado do JWT no backend. Nunca aceitar do browser.';

create index if not exists financial_reconciliation_reviews_omie_idx
  on public.financial_reconciliation_reviews (omie_entry_id)
  where omie_entry_id is not null;

create index if not exists financial_reconciliation_reviews_bank_idx
  on public.financial_reconciliation_reviews (bank_entry_id)
  where bank_entry_id is not null;

create index if not exists financial_reconciliation_reviews_created_idx
  on public.financial_reconciliation_reviews (created_at desc);

alter table public.financial_reconciliation_reviews enable row level security;

drop policy if exists financial_reconciliation_reviews_select_admin
  on public.financial_reconciliation_reviews;
create policy financial_reconciliation_reviews_select_admin
  on public.financial_reconciliation_reviews for select to authenticated
  using (public.financial_admin_can_read());

drop policy if exists financial_reconciliation_reviews_write_deny
  on public.financial_reconciliation_reviews;
create policy financial_reconciliation_reviews_write_deny
  on public.financial_reconciliation_reviews for all to authenticated
  using (false)
  with check (false);

revoke all on public.financial_reconciliation_reviews from anon, public;
revoke insert, update, delete, truncate on public.financial_reconciliation_reviews from authenticated;
grant select on public.financial_reconciliation_reviews to authenticated;
-- Append-only: service_role insere; sem UPDATE/DELETE.
grant select, insert on public.financial_reconciliation_reviews to service_role;
