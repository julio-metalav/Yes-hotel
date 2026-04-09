-- Espelho PMS (Hospedin → Yes): tabelas de sync, reservas/hóspedes brutos e vínculos.
-- Projeção para operacional_* é feita na Edge Function pms-hospedin-sync (service_role).
-- Documentação: docs/HOSPEDIN_INTEGRACAO_BASE_V1.md

-- ---------------------------------------------------------------------------
-- Auditoria de execuções
-- ---------------------------------------------------------------------------
create table if not exists public.pms_sync_runs (
    id uuid primary key default gen_random_uuid(),
    provider text not null default 'hospedin',
    status text not null default 'running' check (status in ('running', 'success', 'partial', 'failed')),
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    date_from date,
    date_to date,
    stats jsonb not null default '{}'::jsonb,
    message text,
    created_at timestamptz not null default now()
);

create index if not exists pms_sync_runs_provider_started_idx
    on public.pms_sync_runs (provider, started_at desc);

-- ---------------------------------------------------------------------------
-- Erros por execução
-- ---------------------------------------------------------------------------
create table if not exists public.pms_sync_errors (
    id uuid primary key default gen_random_uuid(),
    sync_run_id uuid references public.pms_sync_runs (id) on delete cascade,
    severity text not null default 'error' check (severity in ('warn', 'error', 'fatal')),
    step text not null default '',
    message text not null,
    context jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists pms_sync_errors_run_idx on public.pms_sync_errors (sync_run_id);

-- ---------------------------------------------------------------------------
-- Reserva espelho (fonte da verdade PMS)
-- ---------------------------------------------------------------------------
create table if not exists public.pms_reservas (
    id uuid primary key default gen_random_uuid(),
    provider text not null default 'hospedin',
    external_reservation_id text not null,
    property_external_id text,
    unit_code text not null default '',
    unit_name text not null default '',
    check_in date not null,
    check_out date not null,
    status_raw text not null default '',
    is_cancelled boolean not null default false,
    payment_status_raw text not null default '',
    payment_mapped text not null default 'pendente' check (payment_mapped in ('pendente', 'pago')),
    hospede_principal_nome text not null default '',
    raw_payload jsonb not null default '{}'::jsonb,
    pms_updated_at timestamptz,
    synced_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint pms_reservas_provider_external_key unique (provider, external_reservation_id)
);

create index if not exists pms_reservas_check_in_idx on public.pms_reservas (check_in);
create index if not exists pms_reservas_cancelled_idx on public.pms_reservas (is_cancelled) where is_cancelled = true;

-- ---------------------------------------------------------------------------
-- Hóspede espelho (identidade no PMS; dados pessoais só do próprio registro)
-- ---------------------------------------------------------------------------
create table if not exists public.pms_hospedes (
    id uuid primary key default gen_random_uuid(),
    provider text not null default 'hospedin',
    external_guest_id text not null,
    nome text not null default '',
    email text not null default '',
    telefone text not null default '',
    documento text not null default '',
    data_nascimento date,
    nacionalidade text not null default '',
    sexo text not null default '',
    endereco_logradouro text not null default '',
    cidade text not null default '',
    estado text not null default '',
    pais text not null default '',
    cep text not null default '',
    raw_payload jsonb not null default '{}'::jsonb,
    synced_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint pms_hospedes_provider_guest_key unique (provider, external_guest_id)
);

create index if not exists pms_hospedes_provider_idx on public.pms_hospedes (provider);

-- ---------------------------------------------------------------------------
-- Vínculo reserva ↔ hóspede no espelho
-- ---------------------------------------------------------------------------
create table if not exists public.pms_reserva_hospedes (
    id uuid primary key default gen_random_uuid(),
    pms_reserva_id uuid not null references public.pms_reservas (id) on delete cascade,
    pms_hospede_id uuid not null references public.pms_hospedes (id) on delete cascade,
    is_principal boolean not null default false,
    ordem integer not null default 0,
    raw_payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    constraint pms_reserva_hospedes_unique_link unique (pms_reserva_id, pms_hospede_id)
);

create index if not exists pms_reserva_hospedes_reserva_idx on public.pms_reserva_hospedes (pms_reserva_id);
create index if not exists pms_reserva_hospedes_hospede_idx on public.pms_reserva_hospedes (pms_hospede_id);

-- ---------------------------------------------------------------------------
-- Projeção operacional: rastrear hóspede no PMS (idempotência / upsert)
-- ---------------------------------------------------------------------------
alter table public.operacional_hospedes
    add column if not exists pms_external_guest_id text;

create unique index if not exists operacional_hospedes_reserva_pms_guest_uidx
    on public.operacional_hospedes (reserva_id, pms_external_guest_id)
    where pms_external_guest_id is not null and btrim(pms_external_guest_id) <> '';

create unique index if not exists operacional_reservas_origem_external_uidx
    on public.operacional_reservas (origem_externa, external_reservation_id)
    where external_reservation_id is not null and btrim(external_reservation_id) <> '';

-- ---------------------------------------------------------------------------
-- RLS: espelho e sync só via service_role (sem políticas para authenticated)
-- ---------------------------------------------------------------------------
alter table public.pms_sync_runs enable row level security;
alter table public.pms_sync_errors enable row level security;
alter table public.pms_reservas enable row level security;
alter table public.pms_hospedes enable row level security;
alter table public.pms_reserva_hospedes enable row level security;

-- updated_at nos espelhos
drop trigger if exists pms_reservas_updated_at on public.pms_reservas;
create trigger pms_reservas_updated_at
    before update on public.pms_reservas
    for each row execute function public.set_updated_at();

drop trigger if exists pms_hospedes_updated_at on public.pms_hospedes;
create trigger pms_hospedes_updated_at
    before update on public.pms_hospedes
    for each row execute function public.set_updated_at();

comment on table public.pms_reservas is 'Espelho de reservas vindas do PMS (ex.: Hospedin). Fonte da verdade operacional de datas/status/unidade.';
comment on table public.pms_hospedes is 'Espelho de hóspedes no PMS. Dados pessoais não devem ser copiados entre hóspedes na ingestão; endereço compartilhável pode ser sugerido na projeção.';
comment on table public.pms_reserva_hospedes is 'Vínculo N:N espelho reserva ↔ hóspede; suporta múltiplos links FNRH (um operacional_hospede por vínculo).';
comment on column public.operacional_hospedes.pms_external_guest_id is 'Id externo do hóspede no PMS; usado para upsert idempotente na projeção Hospedin → operacional.';
