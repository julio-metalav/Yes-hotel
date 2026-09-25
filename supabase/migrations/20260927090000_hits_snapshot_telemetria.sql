-- Snapshot HITS — telemetria inequívoca do ciclo.
--
-- Problema: `last_rows_count` (= linhas upsertadas no lote) era lido como
-- "reservas que mudaram". Não é: na incremental (Type=2, janela por data) a
-- mesma reserva volta em vários ciclos, o detalhe é relido e a linha é
-- reenviada ao snapshot mesmo idêntica. Aqui o contador antigo é mantido por
-- compatibilidade (mesmo valor de sempre) e cada etapa do ciclo ganha um
-- contador próprio:
--   last_returned_count  ids únicos devolvidos pela listagem (após dedupe)
--   last_detail_count    detalhes HITS lidos com sucesso
--   last_upserted_count  linhas submetidas/upsertadas no snapshot (= last_rows_count)
--   last_changed_count   linhas cujo CONTEÚDO FUNCIONAL mudou (nova ou diferente)
--   last_removed_count   linhas removidas (completa: ausentes; incremental: canceladas)
--   last_failed_count    (já existia) detalhes que falharam
--
-- `changed` compara SÓ os campos funcionais da projeção (apartamento,
-- hospede_principal, check_in, check_out, status_reserva, ciclo_hits,
-- total_hospedes) com o que já estava armazenado, ANTES do upsert, no mesmo
-- statement (a CTE vê o estado anterior). batch_id/last_seen_at/updated_at não
-- contam. Linha nova conta como alteração.
--
-- Assinaturas das RPCs de apply ganham 2 parâmetros opcionais no fim
-- (p_returned_count, p_detail_count) → assinatura nova; a antiga é derrubada
-- para não deixar sobrecarga ambígua ao PostgREST. Sem mudança de população,
-- de remoção, de cursor, de RLS ou de scheduler. Escrita continua só service_role.

alter table public.hits_snapshot_sync_state
  add column if not exists last_returned_count integer,
  add column if not exists last_detail_count integer,
  add column if not exists last_upserted_count integer,
  add column if not exists last_changed_count integer,
  add column if not exists last_removed_count integer;

comment on column public.hits_snapshot_sync_state.last_rows_count is
  'COMPATIBILIDADE: linhas processadas/submetidas (upsertadas) no último ciclo aplicado. NÃO é "reservas alteradas" — ver last_changed_count.';
comment on column public.hits_snapshot_sync_state.last_success_rows_count is
  'COMPATIBILIDADE: mesmo valor de last_rows_count no último ciclo ok/partial.';
comment on column public.hits_snapshot_sync_state.last_returned_count is
  'IDs únicos devolvidos pela listagem HITS no último ciclo (após dedupe; inclui os que falharam no detalhe e as canceladas).';
comment on column public.hits_snapshot_sync_state.last_detail_count is
  'Detalhes HITS lidos com sucesso no último ciclo (linhas candidatas ao snapshot).';
comment on column public.hits_snapshot_sync_state.last_upserted_count is
  'Linhas submetidas/upsertadas no snapshot no último ciclo (idênticas incluídas). = last_rows_count.';
comment on column public.hits_snapshot_sync_state.last_changed_count is
  'Linhas cujo conteúdo funcional realmente mudou no último ciclo (nova, ou apartamento/hóspede principal/datas/status/ciclo/total diferentes do armazenado).';
comment on column public.hits_snapshot_sync_state.last_removed_count is
  'Linhas removidas do snapshot no último ciclo (completa: ausentes do lote e não falhas; incremental: canceladas explícitas).';

-- ---------------------------------------------------------------------------
-- Apply COMPLETO (Type=0): mesma lógica; + changed/removed/returned/detail.
-- ---------------------------------------------------------------------------
drop function if exists public.hits_snapshot_sync_apply(uuid, jsonb, text[], text, text);

create or replace function public.hits_snapshot_sync_apply(
  p_batch_id uuid,
  p_rows jsonb,
  p_failed_ids text[] default '{}',
  p_status text default 'ok',
  p_stopped_reason text default null,
  p_returned_count integer default null,
  p_detail_count integer default null
)
returns table (rows_upserted integer, rows_removed integer, rows_changed integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_upserted integer := 0;
  v_changed integer := 0;
  v_removed integer := 0;
  v_failed_ids text[] := coalesce(p_failed_ids, '{}'::text[]);
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
    order by external_reservation_id
  ),
  -- Alteração REAL: linha nova ou campo funcional diferente do armazenado.
  -- Avaliada no estado ANTERIOR ao upsert (mesmo statement). Campos técnicos
  -- (batch_id, last_seen_at, updated_at) não entram.
  changed as (
    select d.external_reservation_id
    from dedup d
    left join public.hits_reservas_snapshot s on s.external_reservation_id = d.external_reservation_id
    where s.external_reservation_id is null
       or s.apartamento is distinct from d.apartamento
       or s.hospede_principal is distinct from d.hospede_principal
       or s.check_in is distinct from d.check_in
       or s.check_out is distinct from d.check_out
       or s.status_reserva is distinct from d.status_reserva
       or s.ciclo_hits is distinct from d.ciclo_hits
       or s.total_hospedes is distinct from d.total_hospedes
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
  select (select count(*) from ins), (select count(*) from changed)
  into v_upserted, v_changed;

  -- Leitura completa: o que não veio neste lote e não falhou deixou de existir.
  delete from public.hits_reservas_snapshot s
  where s.batch_id <> p_batch_id
    and not (s.external_reservation_id = any (v_failed_ids));
  get diagnostics v_removed = row_count;

  update public.hits_snapshot_sync_state
  set last_finished_at = v_now,
      last_status = p_status,
      last_error = null,
      last_stopped_reason = left(p_stopped_reason, 40),
      last_rows_count = v_upserted,
      last_failed_count = coalesce(array_length(v_failed_ids, 1), 0),
      last_returned_count = p_returned_count,
      last_detail_count = p_detail_count,
      last_upserted_count = v_upserted,
      last_changed_count = v_changed,
      last_removed_count = v_removed,
      last_success_at = v_now,
      last_success_batch_id = p_batch_id,
      last_success_rows_count = v_upserted,
      updated_at = v_now
  where id = true;

  rows_upserted := v_upserted;
  rows_removed := v_removed;
  rows_changed := v_changed;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Apply INCREMENTAL (Type=2): mesma lógica; + changed/returned/detail.
-- ---------------------------------------------------------------------------
drop function if exists public.hits_snapshot_sync_apply_incremental(uuid, jsonb, text[], text[], text, text, timestamptz);

create or replace function public.hits_snapshot_sync_apply_incremental(
  p_batch_id uuid,
  p_rows jsonb,
  p_failed_ids text[] default '{}',
  p_cancelled_ids text[] default '{}',
  p_status text default 'ok',
  p_stopped_reason text default null,
  p_cursor_at timestamptz default null,
  p_returned_count integer default null,
  p_detail_count integer default null
)
returns table (rows_upserted integer, rows_removed integer, rows_changed integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_upserted integer := 0;
  v_changed integer := 0;
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
  changed as (
    select d.external_reservation_id
    from dedup d
    left join public.hits_reservas_snapshot s on s.external_reservation_id = d.external_reservation_id
    where s.external_reservation_id is null
       or s.apartamento is distinct from d.apartamento
       or s.hospede_principal is distinct from d.hospede_principal
       or s.check_in is distinct from d.check_in
       or s.check_out is distinct from d.check_out
       or s.status_reserva is distinct from d.status_reserva
       or s.ciclo_hits is distinct from d.ciclo_hits
       or s.total_hospedes is distinct from d.total_hospedes
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
  select (select count(*) from ins), (select count(*) from changed)
  into v_upserted, v_changed;

  -- Incremental: remove SÓ canceladas explícitas; nunca por ausência.
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
      last_returned_count = p_returned_count,
      last_detail_count = p_detail_count,
      last_upserted_count = v_upserted,
      last_changed_count = v_changed,
      last_removed_count = v_removed,
      last_success_at = v_now,
      last_success_batch_id = p_batch_id,
      last_success_rows_count = v_upserted,
      last_cursor_at = case when p_status = 'ok' and p_cursor_at is not null then p_cursor_at else last_cursor_at end,
      updated_at = v_now
  where id = true;

  rows_upserted := v_upserted;
  rows_removed := v_removed;
  rows_changed := v_changed;
  return next;
end;
$$;

revoke all on function public.hits_snapshot_sync_apply(uuid, jsonb, text[], text, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.hits_snapshot_sync_apply_incremental(uuid, jsonb, text[], text[], text, text, timestamptz, integer, integer)
  from public, anon, authenticated;
grant execute on function public.hits_snapshot_sync_apply(uuid, jsonb, text[], text, text, integer, integer)
  to service_role;
grant execute on function public.hits_snapshot_sync_apply_incremental(uuid, jsonb, text[], text[], text, text, timestamptz, integer, integer)
  to service_role;
