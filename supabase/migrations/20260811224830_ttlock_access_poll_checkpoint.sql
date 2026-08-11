-- Checkpoint de polling TTLock lockRecord/list (first-room-access).
-- Watermark exclusivo: processar apenas records com lockDate > last_lock_date_ms.
-- Seed do lock 16274746: evento diagnóstico 18:39:51 CG NÃO deve ser processado.

create table if not exists public.operacional_ttlock_poll_checkpoints (
  lock_id bigint primary key,
  last_lock_date_ms bigint not null default 0,
  last_record_id text,
  last_polled_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.operacional_ttlock_poll_checkpoints is
  'Watermark por lock para polling /v3/lockRecord/list. last_lock_date_ms = último lockDate já considerado.';

alter table public.operacional_ttlock_poll_checkpoints enable row level security;

drop policy if exists operacional_ttlock_poll_checkpoints_select_ops
  on public.operacional_ttlock_poll_checkpoints;
create policy operacional_ttlock_poll_checkpoints_select_ops
  on public.operacional_ttlock_poll_checkpoints
  for select
  to authenticated
  using (public.is_yes_hotel_ops_reader());

-- Seed: apto 34 — evento 11/08/2026 18:39:51 CG (lockDate=1786487991000, recordId=1777359104)
-- fica ABAIXO do próximo poll (só processa lockDate > watermark).
insert into public.operacional_ttlock_poll_checkpoints (
  lock_id, last_lock_date_ms, last_record_id, last_polled_at, last_error
) values (
  16274746,
  1786487991000,
  '1777359104',
  now(),
  'seed_after_diagnostic_183951_cg_not_processed'
)
on conflict (lock_id) do update
set last_lock_date_ms = greatest(
      public.operacional_ttlock_poll_checkpoints.last_lock_date_ms,
      excluded.last_lock_date_ms
    ),
    last_record_id = coalesce(excluded.last_record_id, public.operacional_ttlock_poll_checkpoints.last_record_id),
    updated_at = now(),
    last_error = excluded.last_error;

-- Locks candidatos: APT provisionado, reserva liberada, ainda não entrou, dentro da validade.
create or replace function public.yes_hotel_list_ttlock_poll_candidate_locks()
returns bigint[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    array_agg(distinct x.lock_id order by x.lock_id),
    '{}'::bigint[]
  )
  from (
    select i.lock_id_ttlock::bigint as lock_id
    from public.operacional_credencial_itens i
    join public.operacional_credenciais_acesso c on c.id = i.credencial_id
    join public.operacional_reservas r on r.id = c.reserva_id
    where i.tipo_destino = 'apartamento'
      and i.status_provisionamento = 'provisionado'
      and c.status = 'provisionada'
      and c.valido_de <= now()
      and c.valido_ate >= now()
      and r.entrou_no_apto is distinct from true
      and r.acesso_liberado is true
      and (
        upper(i.codigo_logico_destino) like 'APT-%'
        or upper(i.codigo_logico_destino) like 'APTO-%'
      )
      and i.lock_id_ttlock ~ '^[0-9]+$'
  ) x;
$$;

comment on function public.yes_hotel_list_ttlock_poll_candidate_locks() is
  'Locks de apartamento candidatos ao polling TTLock (first-room-access pendente).';

revoke all on function public.yes_hotel_list_ttlock_poll_candidate_locks() from public;
grant execute on function public.yes_hotel_list_ttlock_poll_candidate_locks() to service_role;
