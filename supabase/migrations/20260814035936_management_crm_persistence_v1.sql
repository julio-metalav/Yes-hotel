-- Migration aditiva: Gestão + CRM V1.
-- Fonte revisada: docs/sql/management_crm_persistence_v1_proposal.sql
-- Sem backfill. Sem ALTER/trigger em operacional_*. FKs só em crm_*/management_*.
-- DROP POLICY IF EXISTS aplica-se apenas a policies destas tabelas novas (idempotência).
-- Namespace: crm_* (pessoa/empresa) e management_* (fato comercial/BI).
-- Vínculo ao operacional: colunas uuid/text OPCIONAIS, SEM foreign key.

-- ---------------------------------------------------------------------------
-- Leitura staff (admin/recepção). Café e anon não leem PII gerencial.
-- ---------------------------------------------------------------------------
create or replace function public.management_crm_staff_can_read()
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
      and u.perfil_usuario in ('admin', 'recepcao')
  );
$$;

comment on function public.management_crm_staff_can_read() is
  'RLS Gestão/CRM (SECURITY INVOKER): leitura autenticada só para perfil interno admin ou recepcao.';

revoke all on function public.management_crm_staff_can_read() from public;
grant execute on function public.management_crm_staff_can_read() to authenticated;
grant execute on function public.management_crm_staff_can_read() to service_role;

-- ---------------------------------------------------------------------------
-- 1) crm_guests
-- match_key único só quando CPF/passaporte existe. Sem documento = sem merge.
-- ---------------------------------------------------------------------------
create table if not exists public.crm_guests (
  id uuid primary key default gen_random_uuid(),
  match_key text,
  document_type text,
  document_number_normalized text,
  country_code text,
  full_name text not null default '',
  birth_date date,
  email text,
  phone text,
  city text,
  state text,
  country text,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_guests_document_type_check
    check (document_type is null or document_type in ('cpf', 'passport')),
  constraint crm_guests_match_key_shape_check
    check (
      match_key is null
      or match_key ~ '^(cpf:[0-9]{11}|passport:[A-Z0-9]{5,15})$'
    ),
  constraint crm_guests_identity_pair_check
    check (
      (match_key is null and document_type is null and document_number_normalized is null)
      or (
        match_key is not null
        and document_type is not null
        and document_number_normalized is not null
      )
    )
);

comment on table public.crm_guests is
  'Hóspede canônico CRM. Identidade = CPF ou passaporte. E-mail/telefone não são chave. Sem documento não mescla.';
comment on column public.crm_guests.match_key is
  'cpf:########### ou passport:XXXXX. Unique parcial. Nunca logar este valor.';
comment on column public.crm_guests.email is
  'Atributo de conciliação, sem unique.';
comment on column public.crm_guests.phone is
  'Atributo de conciliação, sem unique.';

create unique index if not exists crm_guests_match_key_uidx
  on public.crm_guests (match_key)
  where match_key is not null;

create index if not exists crm_guests_last_seen_idx
  on public.crm_guests (last_seen_at desc);

-- ---------------------------------------------------------------------------
-- 2) crm_companies
-- ---------------------------------------------------------------------------
create table if not exists public.crm_companies (
  id uuid primary key default gen_random_uuid(),
  source_system text not null default 'unknown',
  source_company_id text,
  legal_name text not null,
  trade_name text,
  tax_id_normalized text,
  status text not null default 'active'
    check (status in ('active', 'inactive', 'unknown')),
  first_reservation_at timestamptz,
  last_reservation_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.crm_companies is
  'Empresa/B2B canônica. source_company_id é identificador futuro do PMS, não campo HITS inventado.';

create unique index if not exists crm_companies_source_uidx
  on public.crm_companies (source_system, source_company_id)
  where source_company_id is not null;

create unique index if not exists crm_companies_tax_id_uidx
  on public.crm_companies (tax_id_normalized)
  where tax_id_normalized is not null;

-- ---------------------------------------------------------------------------
-- 3) Catálogo de canal (kind canônico + código estável Yes)
-- ---------------------------------------------------------------------------
create table if not exists public.management_channel_catalog (
  code text primary key,
  kind text not null
    check (kind in ('direct', 'booking_engine', 'ota', 'b2b', 'manual', 'other', 'unknown')),
  label text not null,
  constraint management_channel_catalog_engine_not_ota_check
    check (not (code = 'booking_engine' and kind = 'ota')),
  constraint management_channel_catalog_booking_ota_check
    check (not (code = 'booking' and kind <> 'ota'))
);

comment on table public.management_channel_catalog is
  'Catálogo Yes de canal. Booking Engine ≠ Booking OTA. Sem matching por substring.';

insert into public.management_channel_catalog (code, kind, label) values
  ('direct', 'direct', 'Direto'),
  ('booking_engine', 'booking_engine', 'Booking Engine'),
  ('manual', 'manual', 'Manual'),
  ('booking', 'ota', 'Booking.com'),
  ('expedia', 'ota', 'Expedia'),
  ('hotels_com', 'ota', 'Hotels.com'),
  ('airbnb', 'ota', 'Airbnb'),
  ('b2b', 'b2b', 'B2B')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 4) management_reservations
-- ---------------------------------------------------------------------------
create table if not exists public.management_reservations (
  id uuid primary key default gen_random_uuid(),
  source_system text not null
    check (source_system in ('hits', 'manual', 'unknown')),
  source_reservation_id text,
  operacional_reserva_id uuid,
  booked_at timestamptz,
  checkin_date date not null,
  checkout_date date not null,
  status text not null
    check (status in ('booked', 'cancelled', 'no_show', 'in_house', 'checked_out', 'unknown')),
  channel_kind text not null
    check (channel_kind in ('direct', 'booking_engine', 'ota', 'b2b', 'manual', 'other', 'unknown')),
  channel_code text,
  source_code text,
  company_id uuid references public.crm_companies (id) on delete set null,
  lodging_revenue_cents bigint,
  total_amount_cents bigint,
  balance_due_cents bigint,
  currency text not null default 'BRL',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint management_reservations_dates_check
    check (checkout_date > checkin_date),
  constraint management_reservations_money_check
    check (
      (lodging_revenue_cents is null or lodging_revenue_cents >= 0)
      and (total_amount_cents is null or total_amount_cents >= 0)
      and (balance_due_cents is null or balance_due_cents >= 0)
    ),
  constraint management_reservations_engine_kind_check
    check (channel_kind <> 'booking_engine' or coalesce(channel_code, 'booking_engine') = 'booking_engine'),
  constraint management_reservations_booking_engine_code_check
    check (channel_code is distinct from 'booking_engine' or channel_kind = 'booking_engine'),
  constraint management_reservations_booking_ota_code_check
    check (channel_code is distinct from 'booking' or channel_kind = 'ota'),
  constraint management_reservations_hits_source_id_check
    check (source_system <> 'hits' or source_reservation_id is not null)
);

comment on table public.management_reservations is
  'Fato comercial gerencial. Sem FK para operacional_reservas. operacional_reserva_id é referência lógica opcional.';
comment on column public.management_reservations.booked_at is
  'Instante de venda. Null até o PMS fornecer; não inventar a partir de created_at.';
comment on column public.management_reservations.source_reservation_id is
  'Idempotência com source_system. Não é nome de campo HITS.';

create unique index if not exists management_reservations_source_uidx
  on public.management_reservations (source_system, source_reservation_id)
  where source_reservation_id is not null;

create index if not exists management_reservations_checkin_idx
  on public.management_reservations (checkin_date);

create index if not exists management_reservations_channel_idx
  on public.management_reservations (channel_kind, checkin_date);

create index if not exists management_reservations_company_idx
  on public.management_reservations (company_id)
  where company_id is not null;

create index if not exists management_reservations_operacional_idx
  on public.management_reservations (operacional_reserva_id)
  where operacional_reserva_id is not null;

-- ---------------------------------------------------------------------------
-- 5) management_stays
-- ---------------------------------------------------------------------------
create table if not exists public.management_stays (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null
    references public.management_reservations (id) on delete cascade,
  room_number text,
  scheduled_checkin_date date not null,
  scheduled_checkout_date date not null,
  actual_checkin_at timestamptz,
  actual_checkout_at timestamptz,
  status text not null
    check (status in ('planned', 'occupied', 'completed', 'cancelled', 'no_show')),
  lodging_revenue_cents bigint,
  nights integer not null check (nights >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint management_stays_schedule_check
    check (scheduled_checkout_date > scheduled_checkin_date),
  constraint management_stays_nights_match_schedule_check
    check (nights = (scheduled_checkout_date - scheduled_checkin_date))
);

comment on table public.management_stays is
  'Estadia ≠ reserva. cancelled/no_show não entram em ocupação (regra de aplicação).';

create index if not exists management_stays_reservation_idx
  on public.management_stays (reservation_id);

create index if not exists management_stays_schedule_idx
  on public.management_stays (scheduled_checkin_date, scheduled_checkout_date);

create index if not exists management_stays_status_idx
  on public.management_stays (status);

-- ---------------------------------------------------------------------------
-- 6) management_reservation_guests
-- ---------------------------------------------------------------------------
create table if not exists public.management_reservation_guests (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null
    references public.management_reservations (id) on delete cascade,
  guest_id uuid not null
    references public.crm_guests (id) on delete restrict,
  role text not null
    check (role in ('principal', 'accompanying')),
  is_primary boolean not null default false,
  operacional_hospede_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint management_reservation_guests_pair_uidx unique (reservation_id, guest_id)
);

comment on table public.management_reservation_guests is
  'Vínculo reserva canônica ↔ hóspede canônico. operacional_hospede_id sem FK.';

create unique index if not exists management_reservation_guests_primary_uidx
  on public.management_reservation_guests (reservation_id)
  where is_primary = true;

create index if not exists management_reservation_guests_guest_idx
  on public.management_reservation_guests (guest_id);

-- ---------------------------------------------------------------------------
-- 7) management_financial_events (append-friendly)
-- ---------------------------------------------------------------------------
create table if not exists public.management_financial_events (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid
    references public.management_reservations (id) on delete set null,
  occurred_at timestamptz,
  competence_date date,
  amount_cents bigint not null,
  event_type text not null
    check (event_type in (
      'charge', 'payment', 'refund', 'adjustment', 'commission', 'fee', 'writeoff'
    )),
  payment_method text,
  source_system text not null default 'unknown',
  external_id text,
  notes text,
  created_at timestamptz not null default now(),
  constraint management_financial_events_no_pii_notes_check
    check (notes is null or length(notes) <= 500)
);

comment on table public.management_financial_events is
  'Projeção gerencial. Não substitui operacional_cobrancas_pagarme / operacional_pagamentos_pagarme.';
comment on column public.management_financial_events.notes is
  'Texto curto. Proibido CPF, passaporte, PAN ou payload de provedor.';

create unique index if not exists management_financial_events_external_uidx
  on public.management_financial_events (source_system, external_id)
  where external_id is not null;

create index if not exists management_financial_events_reservation_idx
  on public.management_financial_events (reservation_id, occurred_at);

create index if not exists management_financial_events_competence_idx
  on public.management_financial_events (competence_date);

-- ---------------------------------------------------------------------------
-- 8) management_receivables
-- ---------------------------------------------------------------------------
create table if not exists public.management_receivables (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid
    references public.management_reservations (id) on delete set null,
  company_id uuid
    references public.crm_companies (id) on delete set null,
  original_amount_cents bigint not null check (original_amount_cents >= 0),
  open_amount_cents bigint not null check (open_amount_cents >= 0),
  due_date date not null,
  settled_at timestamptz,
  status text not null
    check (status in ('open', 'partial', 'settled', 'written_off')),
  payer_kind text
    check (payer_kind is null or payer_kind in ('guest', 'company', 'unknown')),
  source_system text not null default 'unknown',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint management_receivables_open_vs_original_check
    check (open_amount_cents <= original_amount_cents)
);

comment on table public.management_receivables is
  'Contas a receber gerenciais. Aging: current / 1-30 / 31-60 / 61-90 / 90+.';

create index if not exists management_receivables_due_open_idx
  on public.management_receivables (due_date)
  where status in ('open', 'partial') and open_amount_cents > 0;

create index if not exists management_receivables_reservation_idx
  on public.management_receivables (reservation_id);

-- ---------------------------------------------------------------------------
-- 9) management_channel_costs
-- Ausência de linha = comissão desconhecida. Não inserir 0 por default.
-- ---------------------------------------------------------------------------
create table if not exists public.management_channel_costs (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null
    references public.management_reservations (id) on delete cascade,
  cost_type text not null
    check (cost_type in ('commission', 'channel_fee', 'other')),
  amount_cents bigint not null check (amount_cents >= 0),
  percentage numeric(7, 4),
  source text not null default 'unknown',
  calculated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table public.management_channel_costs is
  'Custo de canal conhecido. Sem linha = desconhecido. Nunca assumir comissão 0.';

create unique index if not exists management_channel_costs_reservation_type_uidx
  on public.management_channel_costs (reservation_id, cost_type, source);

-- ---------------------------------------------------------------------------
-- 10) management_daily_snapshots  (as_of × stay_date × slot)
-- ---------------------------------------------------------------------------
create table if not exists public.management_daily_snapshots (
  id uuid primary key default gen_random_uuid(),
  as_of_date date not null,
  stay_date date not null,
  as_of_slot text not null default 'eod',
  rooms_on_books integer not null check (rooms_on_books >= 0),
  reservation_count integer not null check (reservation_count >= 0),
  lodging_revenue_cents bigint,
  rooms_available integer not null check (rooms_available >= 0),
  adr_cents bigint generated always as (
    case
      when rooms_on_books > 0 and lodging_revenue_cents is not null
        then lodging_revenue_cents / rooms_on_books
      else null
    end
  ) stored,
  created_at timestamptz not null default now(),
  constraint management_daily_snapshots_slot_check
    check (as_of_slot in ('eod', 'midday', 'manual')),
  constraint management_daily_snapshots_natural_key unique (as_of_date, stay_date, as_of_slot)
);

comment on table public.management_daily_snapshots is
  'OTB histórico. Pickup = snapshot(later) - snapshot(earlier) no mesmo stay_date. INSERT-only no MVP: não atualizar as_of histórico.';
comment on column public.management_daily_snapshots.as_of_slot is
  'MVP = eod. Permite mais de um snapshot/dia no futuro (midday/manual).';

create index if not exists management_daily_snapshots_stay_idx
  on public.management_daily_snapshots (stay_date, as_of_date);

create index if not exists management_daily_snapshots_asof_idx
  on public.management_daily_snapshots (as_of_date, as_of_slot);

-- ---------------------------------------------------------------------------
-- 11) management_room_inventory_daily
-- ---------------------------------------------------------------------------
create table if not exists public.management_room_inventory_daily (
  stay_date date primary key,
  sellable_rooms integer not null check (sellable_rooms >= 0),
  blocked_rooms integer not null default 0 check (blocked_rooms >= 0),
  available_rooms integer generated always as (
    greatest(sellable_rooms - blocked_rooms, 0)
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.management_room_inventory_daily is
  'Inventário por noite. Default operacional atual = 40 vendáveis; bloqueios reduzem RevPAR/ocupação.';

-- ---------------------------------------------------------------------------
-- RLS: leitura staff; escrita só service_role (sem policy de insert para authenticated)
-- ---------------------------------------------------------------------------
alter table public.crm_guests enable row level security;
alter table public.crm_companies enable row level security;
alter table public.management_channel_catalog enable row level security;
alter table public.management_reservations enable row level security;
alter table public.management_stays enable row level security;
alter table public.management_reservation_guests enable row level security;
alter table public.management_financial_events enable row level security;
alter table public.management_receivables enable row level security;
alter table public.management_channel_costs enable row level security;
alter table public.management_daily_snapshots enable row level security;
alter table public.management_room_inventory_daily enable row level security;

drop policy if exists crm_guests_select_staff on public.crm_guests;
create policy crm_guests_select_staff
  on public.crm_guests for select to authenticated
  using (public.management_crm_staff_can_read());

drop policy if exists crm_companies_select_staff on public.crm_companies;
create policy crm_companies_select_staff
  on public.crm_companies for select to authenticated
  using (public.management_crm_staff_can_read());

drop policy if exists management_channel_catalog_select_staff on public.management_channel_catalog;
create policy management_channel_catalog_select_staff
  on public.management_channel_catalog for select to authenticated
  using (public.management_crm_staff_can_read());

drop policy if exists management_reservations_select_staff on public.management_reservations;
create policy management_reservations_select_staff
  on public.management_reservations for select to authenticated
  using (public.management_crm_staff_can_read());

drop policy if exists management_stays_select_staff on public.management_stays;
create policy management_stays_select_staff
  on public.management_stays for select to authenticated
  using (public.management_crm_staff_can_read());

drop policy if exists management_reservation_guests_select_staff on public.management_reservation_guests;
create policy management_reservation_guests_select_staff
  on public.management_reservation_guests for select to authenticated
  using (public.management_crm_staff_can_read());

drop policy if exists management_financial_events_select_staff on public.management_financial_events;
create policy management_financial_events_select_staff
  on public.management_financial_events for select to authenticated
  using (public.management_crm_staff_can_read());

drop policy if exists management_receivables_select_staff on public.management_receivables;
create policy management_receivables_select_staff
  on public.management_receivables for select to authenticated
  using (public.management_crm_staff_can_read());

drop policy if exists management_channel_costs_select_staff on public.management_channel_costs;
create policy management_channel_costs_select_staff
  on public.management_channel_costs for select to authenticated
  using (public.management_crm_staff_can_read());

drop policy if exists management_daily_snapshots_select_staff on public.management_daily_snapshots;
create policy management_daily_snapshots_select_staff
  on public.management_daily_snapshots for select to authenticated
  using (public.management_crm_staff_can_read());

drop policy if exists management_room_inventory_daily_select_staff on public.management_room_inventory_daily;
create policy management_room_inventory_daily_select_staff
  on public.management_room_inventory_daily for select to authenticated
  using (public.management_crm_staff_can_read());

-- authenticated: somente SELECT (RLS staff). Escrita: service_role.
-- service_role no Supabase não é superuser; BYPASSRLS não substitui GRANT.
revoke all on public.crm_guests from anon, public;
revoke all on public.crm_companies from anon, public;
revoke all on public.management_reservations from anon, public;
revoke all on public.management_stays from anon, public;
revoke all on public.management_reservation_guests from anon, public;
revoke all on public.management_financial_events from anon, public;
revoke all on public.management_receivables from anon, public;
revoke all on public.management_channel_costs from anon, public;
revoke all on public.management_daily_snapshots from anon, public;
revoke all on public.management_room_inventory_daily from anon, public;
revoke all on public.management_channel_catalog from anon, public;

grant select on public.crm_guests to authenticated;
grant select on public.crm_companies to authenticated;
grant select on public.management_channel_catalog to authenticated;
grant select on public.management_reservations to authenticated;
grant select on public.management_stays to authenticated;
grant select on public.management_reservation_guests to authenticated;
grant select on public.management_financial_events to authenticated;
grant select on public.management_receivables to authenticated;
grant select on public.management_channel_costs to authenticated;
grant select on public.management_daily_snapshots to authenticated;
grant select on public.management_room_inventory_daily to authenticated;

grant select, insert, update, delete on public.crm_guests to service_role;
grant select, insert, update, delete on public.crm_companies to service_role;
grant select, insert, update, delete on public.management_channel_catalog to service_role;
grant select, insert, update, delete on public.management_reservations to service_role;
grant select, insert, update, delete on public.management_stays to service_role;
grant select, insert, update, delete on public.management_reservation_guests to service_role;
grant select, insert, update, delete on public.management_financial_events to service_role;
grant select, insert, update, delete on public.management_receivables to service_role;
grant select, insert, update, delete on public.management_channel_costs to service_role;
grant select, insert, update, delete on public.management_daily_snapshots to service_role;
grant select, insert, update, delete on public.management_room_inventory_daily to service_role;
