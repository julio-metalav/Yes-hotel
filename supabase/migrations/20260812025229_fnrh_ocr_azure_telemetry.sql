-- Telemetria OCR FNRH (sem PII): páginas processadas, sucesso/falha, idempotência.
-- Não armazena nome, documento, imagem ou resposta bruta do provider.

create table if not exists public.operacional_fnrh_ocr_runs (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.operacional_reservas (id) on delete cascade,
  guest_id uuid not null references public.operacional_hospedes (id) on delete cascade,
  document_id uuid references public.operacional_fnrh_documentos (id) on delete set null,
  content_hash text not null,
  provider text not null,
  model text not null,
  api_version text,
  pages_processed integer not null default 0
    check (pages_processed >= 0),
  success boolean not null default false,
  skipped boolean not null default false,
  duration_ms integer,
  document_type text,
  error_code text,
  created_at timestamptz not null default now(),
  constraint operacional_fnrh_ocr_runs_content_hash_len check (length(content_hash) between 16 and 128)
);

create unique index if not exists operacional_fnrh_ocr_runs_success_idempotent_uidx
  on public.operacional_fnrh_ocr_runs (document_id, provider, model, content_hash)
  where success = true and document_id is not null;

create index if not exists operacional_fnrh_ocr_runs_month_idx
  on public.operacional_fnrh_ocr_runs (created_at desc);

create index if not exists operacional_fnrh_ocr_runs_guest_idx
  on public.operacional_fnrh_ocr_runs (guest_id, created_at desc);

create index if not exists operacional_fnrh_ocr_runs_reservation_idx
  on public.operacional_fnrh_ocr_runs (reservation_id, created_at desc);

comment on table public.operacional_fnrh_ocr_runs is
  'Runs OCR FNRH — telemetria/idempotência sem PII. pages_processed para acompanhamento de consumo.';

alter table public.operacional_fnrh_ocr_runs enable row level security;

drop policy if exists operacional_fnrh_ocr_runs_select_ops on public.operacional_fnrh_ocr_runs;
create policy operacional_fnrh_ocr_runs_select_ops
  on public.operacional_fnrh_ocr_runs
  for select
  to authenticated
  using (public.is_yes_hotel_ops_reader());

-- Sem write policy para authenticated: service_role only.

create or replace view public.operacional_fnrh_ocr_pages_month
with (security_invoker = true)
as
select
  date_trunc('month', created_at AT TIME ZONE 'America/Campo_Grande')::date as month_start,
  provider,
  model,
  sum(pages_processed)::bigint as pages_processed_month,
  count(*) filter (where success) as success_runs,
  count(*) filter (where not success and not skipped) as failed_runs,
  count(*) filter (where skipped) as skipped_runs
from public.operacional_fnrh_ocr_runs
group by 1, 2, 3;

comment on view public.operacional_fnrh_ocr_pages_month is
  'Agregado mensal de páginas OCR (sem PII). security_invoker=true.';
