-- Migration aditiva: Fundação financeira V1 (PR A).
-- Camada normalizada de fatos financeiros importados/projetados.
-- NÃO é livro-razão oficial. Cada origem (HITS, Omie, banco, adquirente) permanece fonte da verdade.
-- Sem ALTER/trigger em operacional_*, management_*, crm_*.
-- Sem FK para operacional_reservas / management_reservations / Pagar.me.
-- Sem parser, sem Claude, sem UI, sem backfill.
-- NÃO aplicar em produção nesta rodada (HOMO primeiro).

-- ---------------------------------------------------------------------------
-- Leitura financeira: somente admin ativo. Recepção e café não leem.
-- SECURITY INVOKER (mesmo padrão de management_crm_staff_can_read).
-- ---------------------------------------------------------------------------
create or replace function public.financial_admin_can_read()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.usuarios_internos u
    where u.auth_user_id = auth.uid()
      and u.ativo = true
      and u.perfil_usuario = 'admin'
  );
$$;

comment on function public.financial_admin_can_read() is
  'RLS financeiro V1 (SECURITY INVOKER): leitura autenticada só para perfil interno admin ativo. Sem perfil financeiro neste MVP.';

revoke all on function public.financial_admin_can_read() from public;
grant execute on function public.financial_admin_can_read() to authenticated;
grant execute on function public.financial_admin_can_read() to service_role;

-- ---------------------------------------------------------------------------
-- 1) financial_accounts
-- Máscara = no máximo 4 dígitos. Nunca gravar agência/conta completa.
-- ---------------------------------------------------------------------------
create table if not exists public.financial_accounts (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  kind text not null
    check (kind in ('bank', 'acquirer', 'psp', 'cash', 'other')),
  institution text,
  account_mask text,
  currency text not null default 'BRL',
  status text not null default 'active'
    check (status in ('active', 'inactive')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_accounts_code_uidx unique (code),
  constraint financial_accounts_code_shape_check
    check (code ~ '^[a-z][a-z0-9_]{1,62}$'),
  constraint financial_accounts_mask_check
    check (account_mask is null or account_mask ~ '^[0-9]{2,4}$'),
  constraint financial_accounts_currency_check
    check (currency = 'BRL')
);

comment on table public.financial_accounts is
  'Contas financeiras Yes (banco/adquirente/PSP/caixa). Não é plano de contas Omie. account_mask nunca guarda número completo.';
comment on column public.financial_accounts.account_mask is
  'Últimos 2–4 dígitos visíveis. Proibido persistir agência/conta completa.';

drop trigger if exists financial_accounts_updated_at on public.financial_accounts;
create trigger financial_accounts_updated_at
  before update on public.financial_accounts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) financial_imports
-- Identidade de processamento = (file_sha256, parser_version).
-- Mesmo arquivo + nova parser_version = nova importação. Sem overwrite silencioso.
-- ---------------------------------------------------------------------------
create table if not exists public.financial_imports (
  id uuid primary key default gen_random_uuid(),
  source_type text not null
    check (source_type in (
      'omie_revenue',
      'omie_ar_ap',
      'ofx_bank',
      'hits_report',
      'pagarme_export',
      'stone_settlement',
      'other'
    )),
  source_name text,
  original_filename text,
  file_sha256 text not null,
  parser_name text,
  parser_version text not null,
  period_start date,
  period_end date,
  imported_at timestamptz not null default now(),
  imported_by uuid references public.usuarios_internos (id) on delete set null,
  status text not null default 'uploaded'
    check (status in (
      'uploaded', 'parsing', 'parsed', 'normalized', 'failed', 'superseded'
    )),
  total_rows integer,
  failed_row_count integer not null default 0,
  storage_bucket text,
  storage_path text,
  error_summary text,
  supersedes_import_id uuid references public.financial_imports (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_imports_sha256_shape_check
    check (file_sha256 ~ '^[0-9a-f]{64}$'),
  constraint financial_imports_parser_version_check
    check (length(trim(parser_version)) > 0 and length(parser_version) <= 64),
  constraint financial_imports_period_check
    check (period_start is null or period_end is null or period_end >= period_start),
  constraint financial_imports_rows_check
    check (
      (total_rows is null or total_rows >= 0)
      and failed_row_count >= 0
      and (total_rows is null or failed_row_count <= total_rows)
    ),
  constraint financial_imports_file_parser_uidx unique (file_sha256, parser_version)
);

comment on table public.financial_imports is
  'Arquivo/fonte importada. Original imutável no bucket privado. Reprocessar = nova linha com mesmo SHA e parser_version distinta.';
comment on column public.financial_imports.file_sha256 is
  'SHA-256 hex minúsculo do arquivo original. Parte da identidade com parser_version.';
comment on column public.financial_imports.supersedes_import_id is
  'Import anterior explicitamente substituída. Nunca UPDATE de linhas normalizadas da import antiga.';

create index if not exists financial_imports_status_idx
  on public.financial_imports (status, imported_at desc);

create index if not exists financial_imports_sha256_idx
  on public.financial_imports (file_sha256);

drop trigger if exists financial_imports_updated_at on public.financial_imports;
create trigger financial_imports_updated_at
  before update on public.financial_imports
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3) financial_import_row_errors
-- ---------------------------------------------------------------------------
create table if not exists public.financial_import_row_errors (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null
    references public.financial_imports (id) on delete cascade,
  row_number integer not null check (row_number >= 0),
  code text not null,
  message text not null,
  raw_excerpt text,
  created_at timestamptz not null default now(),
  constraint financial_import_row_errors_excerpt_len_check
    check (raw_excerpt is null or length(raw_excerpt) <= 500),
  constraint financial_import_row_errors_message_len_check
    check (length(message) <= 500)
);

comment on table public.financial_import_row_errors is
  'Erro por linha do parser. raw_excerpt sanitizado (sem CPF/CNPJ/conta).';

create index if not exists financial_import_row_errors_import_idx
  on public.financial_import_row_errors (import_id, row_number);

-- ---------------------------------------------------------------------------
-- 4) financial_entries
-- Fatos normalizados importados/projetados. Não substitui HITS, Omie nem extrato.
-- PII: person_document_hash apenas; raw_payload só campos estruturais allowlist.
-- Arquivo original permanece no storage privado.
-- ---------------------------------------------------------------------------
create table if not exists public.financial_entries (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.financial_accounts (id) on delete set null,
  source_system text not null
    check (source_system in ('hits', 'omie', 'sicredi', 'stone', 'pagarme', 'manual')),
  source_kind text not null
    check (source_kind in (
      'hits_reservation',
      'omie_invoice',
      'omie_receivable',
      'omie_payable',
      'bank_credit',
      'bank_debit',
      'acquirer_settlement',
      'psp_payment',
      'other'
    )),
  source_import_id uuid
    references public.financial_imports (id) on delete restrict,
  source_record_id text,
  source_row integer,
  direction text not null
    check (direction in ('credit', 'debit')),
  entry_type text not null
    check (entry_type in (
      'receivable', 'payable', 'bank_tx', 'fee', 'tax',
      'transfer', 'invoice', 'payment', 'other'
    )),
  document_number text,
  installment text,
  person_name text,
  person_document_hash text,
  description text,
  category_source text,
  category_yes text,
  gross_amount_cents bigint,
  net_amount_cents bigint,
  fee_cents bigint,
  tax_cents bigint,
  open_amount_cents bigint,
  issue_date date,
  due_date date,
  settlement_date date,
  competence_date date,
  payment_method text,
  external_reference text,
  reservation_ref jsonb,
  raw_payload jsonb,
  normalized_hash text,
  lifecycle_status text not null default 'active'
    check (lifecycle_status in ('active', 'voided_by_reimport', 'ignored')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_entries_source_row_check
    check (source_row is null or source_row >= 0),
  constraint financial_entries_money_check
    check (
      (gross_amount_cents is null or gross_amount_cents >= 0)
      and (net_amount_cents is null or net_amount_cents >= 0)
      and (fee_cents is null or fee_cents >= 0)
      and (tax_cents is null or tax_cents >= 0)
      and (open_amount_cents is null or open_amount_cents >= 0)
    ),
  constraint financial_entries_person_name_len_check
    check (person_name is null or length(person_name) <= 200),
  constraint financial_entries_description_len_check
    check (description is null or length(description) <= 500),
  constraint financial_entries_doc_hash_shape_check
    check (person_document_hash is null or person_document_hash ~ '^[0-9a-f]{64}$'),
  constraint financial_entries_normalized_hash_shape_check
    check (normalized_hash is null or normalized_hash ~ '^[0-9a-f]{64}$'),
  constraint financial_entries_raw_payload_size_check
    check (raw_payload is null or octet_length(raw_payload::text) <= 8192),
  constraint financial_entries_raw_payload_no_pii_keys_check
    check (
      raw_payload is null
      or not (raw_payload ?| array[
        'cpf', 'cnpj', 'cpf_cnpj', 'document_number_full',
        'federal_registration', 'federalRegistrationNumber',
        'docCpfCnpjPassport', 'account_number', 'agencia', 'conta',
        'pan', 'card_number', 'pix_copia_e_cola', 'pixCopiaECola'
      ])
    )
);

comment on table public.financial_entries is
  'Camada normalizada de fatos financeiros importados/projetados. Não é livro-razão oficial. HITS/Omie/banco permanecem fontes distintas.';
comment on column public.financial_entries.person_document_hash is
  'SHA-256 hex de kind:digitos (cpf/cnpj). Nunca persistir documento completo nesta tabela.';
comment on column public.financial_entries.raw_payload is
  'Remanescente estrutural sanitizado (allowlist). PII completo e extrato original ficam só no arquivo privado.';
comment on column public.financial_entries.reservation_ref is
  'Referência lógica opcional {hits_id, integration_id, operacional_reserva_id, management_reservation_id}. Sem FK.';
comment on column public.financial_entries.lifecycle_status is
  'active | voided_by_reimport | ignored. Reimport não UPDATE valores: void da linha antiga + insert novo.';

create unique index if not exists financial_entries_source_record_uidx
  on public.financial_entries (source_system, source_kind, source_record_id)
  where source_record_id is not null
    and lifecycle_status = 'active';

create unique index if not exists financial_entries_import_row_uidx
  on public.financial_entries (source_import_id, source_row)
  where source_import_id is not null
    and source_row is not null
    and lifecycle_status = 'active';

create index if not exists financial_entries_import_idx
  on public.financial_entries (source_import_id);

create index if not exists financial_entries_account_settlement_idx
  on public.financial_entries (account_id, settlement_date)
  where account_id is not null;

create index if not exists financial_entries_active_idx
  on public.financial_entries (source_system, source_kind)
  where lifecycle_status = 'active';

drop trigger if exists financial_entries_updated_at on public.financial_entries;
create trigger financial_entries_updated_at
  before update on public.financial_entries
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5) financial_reconciliation_groups
-- Evidência estruturada do score/regra (não só confidence).
-- ---------------------------------------------------------------------------
create table if not exists public.financial_reconciliation_groups (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'suggested'
    check (status in (
      'suggested', 'auto_matched', 'confirmed', 'rejected', 'superseded'
    )),
  match_method text,
  rule_version text,
  confidence integer
    check (confidence is null or (confidence >= 0 and confidence <= 100)),
  matched_amount_cents bigint
    check (matched_amount_cents is null or matched_amount_cents >= 0),
  score_evidence jsonb not null default '{}'::jsonb,
  reviewed_by uuid references public.usuarios_internos (id) on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_reconciliation_groups_note_len_check
    check (review_note is null or length(review_note) <= 500)
);

comment on table public.financial_reconciliation_groups is
  'Grupo de conciliação 1:1 / 1:N / N:1 / parcial. IA não grava match. score_evidence guarda sinais da regra.';
comment on column public.financial_reconciliation_groups.score_evidence is
  'Evidência determinística, ex.: {amount_exact, document_match, date_distance_days, name_match}.';

create index if not exists financial_reconciliation_groups_status_idx
  on public.financial_reconciliation_groups (status);

drop trigger if exists financial_reconciliation_groups_updated_at
  on public.financial_reconciliation_groups;
create trigger financial_reconciliation_groups_updated_at
  before update on public.financial_reconciliation_groups
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 6) financial_reconciliation_legs
-- ---------------------------------------------------------------------------
create table if not exists public.financial_reconciliation_legs (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null
    references public.financial_reconciliation_groups (id) on delete cascade,
  entry_id uuid not null
    references public.financial_entries (id) on delete restrict,
  role text not null
    check (role in ('source', 'target')),
  allocated_amount_cents bigint not null
    check (allocated_amount_cents >= 0),
  created_at timestamptz not null default now(),
  constraint financial_reconciliation_legs_pair_uidx unique (group_id, entry_id)
);

comment on table public.financial_reconciliation_legs is
  'Perna de um grupo de conciliação. Permite split e lote sem duplicar o grupo.';

create index if not exists financial_reconciliation_legs_entry_idx
  on public.financial_reconciliation_legs (entry_id);

-- ---------------------------------------------------------------------------
-- 7) financial_audit_findings
-- Proibido estado fraude_confirmada. No máximo fraud_risk_signal.
-- ---------------------------------------------------------------------------
create table if not exists public.financial_audit_findings (
  id uuid primary key default gen_random_uuid(),
  finding_type text not null
    check (finding_type in (
      'hits_without_omie',
      'omie_without_hits',
      'omie_without_bank',
      'bank_without_omie',
      'value_mismatch',
      'duplicate_possible',
      'date_mismatch',
      'unidentified_credit',
      'unidentified_debit',
      'internal_transfer',
      'partial_payment',
      'payment_aggregation',
      'possible_wrong_category',
      'unbalanced_match_group',
      'import_row_error_unresolved',
      'hits_balance_vs_omie_open'
    )),
  signal_class text not null
    check (signal_class in (
      'divergence', 'anomaly', 'requires_review', 'fraud_risk_signal'
    )),
  severity text not null
    check (severity in ('info', 'low', 'medium', 'high')),
  amount_cents bigint
    check (amount_cents is null or amount_cents >= 0),
  period_start date,
  period_end date,
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'open'
    check (status in ('open', 'in_review', 'resolved', 'ignored', 'justified')),
  resolution_code text,
  resolved_by uuid references public.usuarios_internos (id) on delete set null,
  resolved_at timestamptz,
  human_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_audit_findings_period_check
    check (period_start is null or period_end is null or period_end >= period_start),
  constraint financial_audit_findings_note_len_check
    check (human_note is null or length(human_note) <= 500)
);

comment on table public.financial_audit_findings is
  'Divergência/anomalia determinística. Sem estado fraude_confirmada. Claude só explica; não cria finding oficial nesta fase.';

create index if not exists financial_audit_findings_open_idx
  on public.financial_audit_findings (status, finding_type)
  where status in ('open', 'in_review');

create index if not exists financial_audit_findings_period_idx
  on public.financial_audit_findings (period_start, period_end);

drop trigger if exists financial_audit_findings_updated_at
  on public.financial_audit_findings;
create trigger financial_audit_findings_updated_at
  before update on public.financial_audit_findings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 8) financial_ai_analyses
-- Contrato persistente apenas. Sem Anthropic neste PR. Sem escrita em fatos.
-- ---------------------------------------------------------------------------
create table if not exists public.financial_ai_analyses (
  id uuid primary key default gen_random_uuid(),
  finding_id uuid references public.financial_audit_findings (id) on delete set null,
  group_id uuid references public.financial_reconciliation_groups (id) on delete set null,
  provider text,
  model text,
  prompt_version text,
  input_hash text,
  input_snapshot_redacted jsonb,
  output_schema_version text,
  response_structured jsonb,
  confidence numeric(5, 4)
    check (confidence is null or (confidence >= 0 and confidence <= 1)),
  signal_class text
    check (signal_class is null or signal_class in (
      'divergence', 'anomaly', 'requires_review', 'fraud_risk_signal', 'none'
    )),
  evidence jsonb not null default '[]'::jsonb,
  tool_calls jsonb,
  token_input integer,
  token_output integer,
  estimated_cost_usd numeric(12, 6),
  status text not null default 'ok'
    check (status in ('ok', 'timeout', 'provider_error', 'refused')),
  created_at timestamptz not null default now(),
  constraint financial_ai_analyses_input_hash_shape_check
    check (input_hash is null or input_hash ~ '^[0-9a-f]{64}$'),
  constraint financial_ai_analyses_tokens_check
    check (
      (token_input is null or token_input >= 0)
      and (token_output is null or token_output >= 0)
      and (estimated_cost_usd is null or estimated_cost_usd >= 0)
    )
);

comment on table public.financial_ai_analyses is
  'Análise assistiva persistida. Não altera saldo, baixa, match ou reserva. Snapshot de input deve ser redigido.';

create index if not exists financial_ai_analyses_finding_idx
  on public.financial_ai_analyses (finding_id)
  where finding_id is not null;

create index if not exists financial_ai_analyses_group_idx
  on public.financial_ai_analyses (group_id)
  where group_id is not null;

-- ---------------------------------------------------------------------------
-- 9) Storage — bucket privado financial-imports
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'financial-imports',
  'financial-imports',
  false,
  52428800,
  array[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/x-ofx',
    'application/ofx',
    'application/xml',
    'text/xml',
    'text/plain'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists financial_imports_objects_select_admin on storage.objects;
create policy financial_imports_objects_select_admin
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'financial-imports'
    and public.financial_admin_can_read()
  );

-- Sem INSERT/UPDATE/DELETE authenticated: upload futuro só via Edge/service_role.

-- ---------------------------------------------------------------------------
-- 10) Seed idempotente — contas Sicredi (máscara, nunca número completo)
-- ---------------------------------------------------------------------------
insert into public.financial_accounts (code, kind, institution, account_mask, currency, status)
values
  ('sicredi_principal', 'bank', 'Sicredi', null, 'BRL', 'active'),
  ('sicredi_0911', 'bank', 'Sicredi', '0911', 'BRL', 'active')
on conflict (code) do update set
  kind = excluded.kind,
  institution = excluded.institution,
  account_mask = excluded.account_mask,
  currency = excluded.currency,
  status = excluded.status;

-- ---------------------------------------------------------------------------
-- 11) RLS — admin lê; authenticated não escreve; service_role escreve
-- ---------------------------------------------------------------------------
alter table public.financial_accounts enable row level security;
alter table public.financial_imports enable row level security;
alter table public.financial_import_row_errors enable row level security;
alter table public.financial_entries enable row level security;
alter table public.financial_reconciliation_groups enable row level security;
alter table public.financial_reconciliation_legs enable row level security;
alter table public.financial_audit_findings enable row level security;
alter table public.financial_ai_analyses enable row level security;

drop policy if exists financial_accounts_select_admin on public.financial_accounts;
create policy financial_accounts_select_admin
  on public.financial_accounts for select to authenticated
  using (public.financial_admin_can_read());

drop policy if exists financial_imports_select_admin on public.financial_imports;
create policy financial_imports_select_admin
  on public.financial_imports for select to authenticated
  using (public.financial_admin_can_read());

drop policy if exists financial_import_row_errors_select_admin on public.financial_import_row_errors;
create policy financial_import_row_errors_select_admin
  on public.financial_import_row_errors for select to authenticated
  using (public.financial_admin_can_read());

drop policy if exists financial_entries_select_admin on public.financial_entries;
create policy financial_entries_select_admin
  on public.financial_entries for select to authenticated
  using (public.financial_admin_can_read());

drop policy if exists financial_reconciliation_groups_select_admin on public.financial_reconciliation_groups;
create policy financial_reconciliation_groups_select_admin
  on public.financial_reconciliation_groups for select to authenticated
  using (public.financial_admin_can_read());

drop policy if exists financial_reconciliation_legs_select_admin on public.financial_reconciliation_legs;
create policy financial_reconciliation_legs_select_admin
  on public.financial_reconciliation_legs for select to authenticated
  using (public.financial_admin_can_read());

drop policy if exists financial_audit_findings_select_admin on public.financial_audit_findings;
create policy financial_audit_findings_select_admin
  on public.financial_audit_findings for select to authenticated
  using (public.financial_admin_can_read());

drop policy if exists financial_ai_analyses_select_admin on public.financial_ai_analyses;
create policy financial_ai_analyses_select_admin
  on public.financial_ai_analyses for select to authenticated
  using (public.financial_admin_can_read());

drop policy if exists financial_accounts_write_deny on public.financial_accounts;
create policy financial_accounts_write_deny
  on public.financial_accounts for all to authenticated
  using (false) with check (false);

drop policy if exists financial_imports_write_deny on public.financial_imports;
create policy financial_imports_write_deny
  on public.financial_imports for all to authenticated
  using (false) with check (false);

drop policy if exists financial_import_row_errors_write_deny on public.financial_import_row_errors;
create policy financial_import_row_errors_write_deny
  on public.financial_import_row_errors for all to authenticated
  using (false) with check (false);

drop policy if exists financial_entries_write_deny on public.financial_entries;
create policy financial_entries_write_deny
  on public.financial_entries for all to authenticated
  using (false) with check (false);

drop policy if exists financial_reconciliation_groups_write_deny on public.financial_reconciliation_groups;
create policy financial_reconciliation_groups_write_deny
  on public.financial_reconciliation_groups for all to authenticated
  using (false) with check (false);

drop policy if exists financial_reconciliation_legs_write_deny on public.financial_reconciliation_legs;
create policy financial_reconciliation_legs_write_deny
  on public.financial_reconciliation_legs for all to authenticated
  using (false) with check (false);

drop policy if exists financial_audit_findings_write_deny on public.financial_audit_findings;
create policy financial_audit_findings_write_deny
  on public.financial_audit_findings for all to authenticated
  using (false) with check (false);

drop policy if exists financial_ai_analyses_write_deny on public.financial_ai_analyses;
create policy financial_ai_analyses_write_deny
  on public.financial_ai_analyses for all to authenticated
  using (false) with check (false);

revoke all on public.financial_accounts from anon, public;
revoke all on public.financial_imports from anon, public;
revoke all on public.financial_import_row_errors from anon, public;
revoke all on public.financial_entries from anon, public;
revoke all on public.financial_reconciliation_groups from anon, public;
revoke all on public.financial_reconciliation_legs from anon, public;
revoke all on public.financial_audit_findings from anon, public;
revoke all on public.financial_ai_analyses from anon, public;

grant select on public.financial_accounts to authenticated;
grant select on public.financial_imports to authenticated;
grant select on public.financial_import_row_errors to authenticated;
grant select on public.financial_entries to authenticated;
grant select on public.financial_reconciliation_groups to authenticated;
grant select on public.financial_reconciliation_legs to authenticated;
grant select on public.financial_audit_findings to authenticated;
grant select on public.financial_ai_analyses to authenticated;

grant select, insert, update, delete on public.financial_accounts to service_role;
grant select, insert, update, delete on public.financial_imports to service_role;
grant select, insert, update, delete on public.financial_import_row_errors to service_role;
grant select, insert, update, delete on public.financial_entries to service_role;
grant select, insert, update, delete on public.financial_reconciliation_groups to service_role;
grant select, insert, update, delete on public.financial_reconciliation_legs to service_role;
grant select, insert, update, delete on public.financial_audit_findings to service_role;
grant select, insert, update, delete on public.financial_ai_analyses to service_role;
