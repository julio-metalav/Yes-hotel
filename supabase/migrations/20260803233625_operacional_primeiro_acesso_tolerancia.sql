-- Recovered from remote schema_migrations (minmmecajnmjqlgacfoz)
-- version=20260803233625 name=operacional_primeiro_acesso_tolerancia
-- DO NOT re-apply; already applied remotely.

-- Yes Hotel 0022 — primeiro acesso + tolerância
create or replace function public.is_yes_hotel_ops_reader()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.usuarios_internos u
    where u.auth_user_id = auth.uid()
      and u.ativo = true
      and lower(u.perfil_usuario) in ('admin', 'recepcao')
  );
$$;

comment on function public.is_yes_hotel_ops_reader() is
  'True se o JWT atual pertence a usuario interno ativo admin ou recepcao.';

create table if not exists public.operacional_acesso_eventos (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  source_event_id text not null,
  idempotency_key text not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  lock_id bigint not null,
  keyboard_pwd_id bigint null,
  record_type integer not null,
  access_method text not null,
  success boolean not null,
  reservation_id uuid null references public.operacional_reservas (id) on delete set null,
  credential_id uuid null references public.operacional_credenciais_acesso (id) on delete set null,
  credential_item_id uuid null references public.operacional_credencial_itens (id) on delete set null,
  logical_destination text null,
  processing_status text not null,
  ignored_reason text null,
  raw_payload_sanitized jsonb null,
  processed_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint operacional_acesso_eventos_source_event_uidx unique (source, source_event_id),
  constraint operacional_acesso_eventos_idempotency_uidx unique (idempotency_key),
  constraint operacional_acesso_eventos_processing_status_check check (
    processing_status in (
      'received',
      'processing',
      'processed',
      'ignored',
      'failed'
    )
  ),
  constraint operacional_acesso_eventos_access_method_check check (
    access_method in (
      'passcode',
      'app',
      'gateway',
      'ic_card',
      'fingerprint',
      'mechanical_key',
      'remote',
      'inside',
      'invalid_passcode',
      'other'
    )
  )
);

create index if not exists operacional_acesso_eventos_lock_id_idx
  on public.operacional_acesso_eventos (lock_id);
create index if not exists operacional_acesso_eventos_occurred_at_idx
  on public.operacional_acesso_eventos (occurred_at);
create index if not exists operacional_acesso_eventos_reservation_id_idx
  on public.operacional_acesso_eventos (reservation_id);
create index if not exists operacional_acesso_eventos_processing_status_idx
  on public.operacional_acesso_eventos (processing_status);

comment on table public.operacional_acesso_eventos is
  'Eventos de abertura TTLock sanitizados. Nunca armazenar senha/passcode em texto.';
comment on column public.operacional_acesso_eventos.raw_payload_sanitized is
  'Payload sem keyboardPwd, tokens ou secrets. Idempotency futura deve usar HMAC.';

create table if not exists public.operacional_acesso_tolerancias (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.operacional_reservas (id) on delete cascade,
  credential_id uuid not null references public.operacional_credenciais_acesso (id) on delete cascade,
  first_room_access_at timestamptz not null,
  grace_started_at timestamptz not null,
  suspension_due_at timestamptz not null,
  grace_status text not null,
  pending_payment_at_start boolean not null,
  pending_fnrh_at_start boolean not null,
  current_payment_pending boolean not null,
  current_fnrh_pending boolean not null,
  pending_snapshot jsonb not null default '[]'::jsonb,
  original_valid_from timestamptz not null,
  original_valid_until timestamptz not null,
  suspended_at timestamptz null,
  restored_at timestamptz null,
  welcome_message_event_id uuid null references public.operacional_acesso_eventos (id) on delete set null,
  last_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operacional_acesso_tolerancias_credential_uidx unique (credential_id),
  constraint operacional_acesso_tolerancias_grace_status_check check (
    grace_status in (
      'active',
      'cancelled',
      'suspension_pending',
      'suspended',
      'partial_failure',
      'restore_pending',
      'restored',
      'error'
    )
  ),
  constraint operacional_acesso_tolerancias_validity_check check (
    original_valid_until > original_valid_from
  )
);

create index if not exists operacional_acesso_tolerancias_reservation_id_idx
  on public.operacional_acesso_tolerancias (reservation_id);
create index if not exists operacional_acesso_tolerancias_due_status_idx
  on public.operacional_acesso_tolerancias (suspension_due_at)
  where grace_status in ('active', 'suspension_pending');

comment on table public.operacional_acesso_tolerancias is
  'Tolerancia unica de 1h apos primeiro uso de senha no apartamento com pendencias.';

create table if not exists public.operacional_acesso_tolerancia_itens (
  id uuid primary key default gen_random_uuid(),
  tolerance_id uuid not null references public.operacional_acesso_tolerancias (id) on delete cascade,
  credential_item_id uuid not null references public.operacional_credencial_itens (id) on delete cascade,
  logical_destination text not null,
  lock_id bigint not null,
  remote_keyboard_pwd_id bigint not null,
  original_valid_from timestamptz not null,
  original_valid_until timestamptz not null,
  suspended_valid_until timestamptz null,
  suspension_status text not null,
  restore_status text not null,
  suspension_attempts integer not null default 0,
  restore_attempts integer not null default 0,
  last_attempt_at timestamptz null,
  last_error text null,
  suspended_at timestamptz null,
  restored_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operacional_acesso_tolerancia_itens_unique unique (tolerance_id, credential_item_id),
  constraint operacional_acesso_tolerancia_itens_suspension_status_check check (
    suspension_status in ('pending', 'succeeded', 'failed', 'skipped')
  ),
  constraint operacional_acesso_tolerancia_itens_restore_status_check check (
    restore_status in ('not_applicable', 'pending', 'succeeded', 'failed', 'skipped')
  ),
  constraint operacional_acesso_tolerancia_itens_attempts_check check (
    suspension_attempts >= 0 and restore_attempts >= 0
  )
);

create index if not exists operacional_acesso_tolerancia_itens_tolerance_id_idx
  on public.operacional_acesso_tolerancia_itens (tolerance_id);

comment on table public.operacional_acesso_tolerancia_itens is
  'Estado de suspensao/restauracao por item. Sem senha; usa lock_id + remote_keyboard_pwd_id.';

alter table public.operacional_acesso_eventos enable row level security;
alter table public.operacional_acesso_tolerancias enable row level security;
alter table public.operacional_acesso_tolerancia_itens enable row level security;

drop policy if exists operacional_acesso_eventos_select_ops on public.operacional_acesso_eventos;
create policy operacional_acesso_eventos_select_ops
  on public.operacional_acesso_eventos
  for select
  to authenticated
  using (public.is_yes_hotel_ops_reader());

drop policy if exists operacional_acesso_tolerancias_select_ops on public.operacional_acesso_tolerancias;
create policy operacional_acesso_tolerancias_select_ops
  on public.operacional_acesso_tolerancias
  for select
  to authenticated
  using (public.is_yes_hotel_ops_reader());

drop policy if exists operacional_acesso_tolerancia_itens_select_ops on public.operacional_acesso_tolerancia_itens;
create policy operacional_acesso_tolerancia_itens_select_ops
  on public.operacional_acesso_tolerancia_itens
  for select
  to authenticated
  using (public.is_yes_hotel_ops_reader());
