-- Snapshot HITS — sincronização incremental (Type=2). Mínimo necessário:
--   * cursor: hits_snapshot_sync_state não tinha onde guardar até quando o HITS
--     já foi lido (last_success_at é o FIM do ciclo e é sobrescrito por ciclos
--     parciais; o cursor só pode avançar em ciclo ok).
--   * apply incremental: hits_snapshot_sync_apply remove tudo que não veio no
--     lote (semântica de leitura completa); na incremental nada é removido por
--     ausência — só canceladas explícitas (status 2). A RPC completa fica intocada.
--   * set_cursor: a carga completa inicial (sem cursor) precisa fixar o cursor.
-- Só estado/RPCs do snapshot. Escrita só por service_role. Idempotente.

alter table public.hits_snapshot_sync_state
  add column if not exists last_cursor_at timestamptz;

comment on column public.hits_snapshot_sync_state.last_cursor_at is
  'Início (UTC) do último ciclo aplicado com status ok. NULL → próximo ciclo é a carga completa inicial.';

-- Fixa o cursor após um apply bem-sucedido do MESMO batch (carga completa inicial).
create or replace function public.hits_snapshot_sync_set_cursor(p_batch_id uuid, p_cursor_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_batch_id is null or p_cursor_at is null then
    raise exception 'hits_snapshot_cursor_required' using errcode = '22023';
  end if;
  update public.hits_snapshot_sync_state
  set last_cursor_at = p_cursor_at, updated_at = now()
  where id = true and last_success_batch_id = p_batch_id;
end;
$$;

-- Lote incremental, atômico: upsert das alteradas; remove SÓ p_cancelled_ids
-- (status 2 confirmado no detalhe); nunca remove por ausência; p_failed_ids
-- preservados; cursor avança só em p_status = 'ok'.
create or replace function public.hits_snapshot_sync_apply_incremental(
  p_batch_id uuid,
  p_rows jsonb,
  p_failed_ids text[] default '{}',
  p_cancelled_ids text[] default '{}',
  p_status text default 'ok',
  p_stopped_reason text default null,
  p_cursor_at timestamptz default null
)
returns table (rows_upserted integer, rows_removed integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_upserted integer := 0;
  v_removed integer := 0;
  v_failed_ids text[] := coalesce(p_failed_ids, '{}'::text[]);
  v_cancelled_ids text[] := coalesce(p_cancelled_ids, '{}'::text[]);
begin
  if p_batch_id is null then
    raise exception 'hits_snapshot_batch_required' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('ok', 'partial') then
    raise exception 'hits_snapshot_status_invalid' using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'hits_snapshot_rows_invalid' using errcode = '22023';
  end if;

  with src as (
    select
      nullif(btrim(r ->> 'external_reservation_id'), '') as external_reservation_id,
      left(btrim(coalesce(r ->> 'apartamento', '')), 32) as apartamento,
      left(btrim(coalesce(r ->> 'hospede_principal', '')), 160) as hospede_principal,
      case when (r ->> 'check_in') ~ '^\d{4}-\d{2}-\d{2}' then left(r ->> 'check_in', 10)::date end as check_in,
      case when (r ->> 'check_out') ~ '^\d{4}-\d{2}-\d{2}' then left(r ->> 'check_out', 10)::date end as check_out,
      case when (r ->> 'status_reserva') = 'cancelada' then 'cancelada' else 'ativa' end as status_reserva,
      case when (r ->> 'ciclo_hits') = 'hospedada' then 'hospedada' else 'confirmada' end as ciclo_hits,
      case when (r ->> 'total_hospedes') ~ '^\d{1,4}$' then greatest(1, (r ->> 'total_hospedes')::integer) else 1 end as total_hospedes
    from jsonb_array_elements(p_rows) as r
  ),
  dedup as (
    select distinct on (external_reservation_id) *
    from src
    where external_reservation_id is not null
      and external_reservation_id ~ '^[A-Za-z0-9._-]{1,128}$'
      and status_reserva <> 'cancelada'
    order by external_reservation_id
  ),
  ins as (
    insert into public.hits_reservas_snapshot as s (
      external_reservation_id, apartamento, hospede_principal, check_in, check_out,
      status_reserva, ciclo_hits, total_hospedes, source, batch_id,
      first_seen_at, last_seen_at, updated_at
    )
    select d.external_reservation_id, d.apartamento, d.hospede_principal, d.check_in, d.check_out,
           d.status_reserva, d.ciclo_hits, d.total_hospedes, 'hits', p_batch_id, v_now, v_now, v_now
    from dedup d
    on conflict (external_reservation_id) do update
      set apartamento = excluded.apartamento,
          hospede_principal = excluded.hospede_principal,
          check_in = excluded.check_in,
          check_out = excluded.check_out,
          status_reserva = excluded.status_reserva,
          ciclo_hits = excluded.ciclo_hits,
          total_hospedes = excluded.total_hospedes,
          batch_id = excluded.batch_id,
          last_seen_at = v_now,
          updated_at = v_now
    returning 1
  )
  select count(*) into v_upserted from ins;

  delete from public.hits_reservas_snapshot s
  where s.external_reservation_id = any (v_cancelled_ids);
  get diagnostics v_removed = row_count;

  update public.hits_snapshot_sync_state
  set last_finished_at = v_now,
      last_status = p_status,
      last_error = null,
      last_stopped_reason = left(p_stopped_reason, 40),
      last_rows_count = v_upserted,
      last_failed_count = coalesce(array_length(v_failed_ids, 1), 0),
      last_success_at = v_now,
      last_success_batch_id = p_batch_id,
      last_success_rows_count = v_upserted,
      last_cursor_at = case when p_status = 'ok' and p_cursor_at is not null then p_cursor_at else last_cursor_at end,
      updated_at = v_now
  where id = true;

  rows_upserted := v_upserted;
  rows_removed := v_removed;
  return next;
end;
$$;

revoke all on function public.hits_snapshot_sync_set_cursor(uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function public.hits_snapshot_sync_apply_incremental(uuid, jsonb, text[], text[], text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.hits_snapshot_sync_set_cursor(uuid, timestamptz)
  to service_role;
grant execute on function public.hits_snapshot_sync_apply_incremental(uuid, jsonb, text[], text[], text, text, timestamptz)
  to service_role;
