-- Snapshot HITS — sincronização incremental (Type=2, data de atualização).
--
-- Por quê: o ciclo completo relê ~75 requisições a cada 10 min. Com Type=2 a
-- Edge lista só o que mudou desde o último cursor e busca detalhe só desses ids.
-- Zero alterações → zero detalhes.
--
-- Por que precisa de migration (justificativa):
--   * cursor: hits_snapshot_sync_state não tinha onde guardar "até quando o HITS
--     já foi lido" (last_success_at é o FIM do ciclo e é sobrescrito por ciclos
--     parciais; o cursor precisa avançar só em ciclo completo/ok). Coluna nova.
--   * apply incremental: hits_snapshot_sync_apply REMOVE tudo que não veio no
--     lote (semântica de leitura completa). Na incremental nada pode ser
--     removido por ausência — só canceladas explícitas (status 2). RPC nova;
--     a RPC existente fica intocada.
--
-- Escopo: só estado/RPCs do snapshot. Não toca operacional_reservas, UI,
-- gateway, scheduler, secrets. Escrita só por service_role. Idempotente.
-- Aplicar em HOMO (kzprrnbafamuozhyikgb) primeiro; PROD só após validação.

-- -----------------------------------------------------------------------
-- 1) Cursor e modo do último ciclo
-- -----------------------------------------------------------------------
alter table public.hits_snapshot_sync_state
  add column if not exists last_cursor_at timestamptz,
  add column if not exists last_mode text
    check (last_mode is null or last_mode in ('full', 'incremental'));

comment on column public.hits_snapshot_sync_state.last_cursor_at is
  'Início (UTC) do último ciclo que leu o HITS por completo e sem falhas '
  '(ou incremental ok). A próxima incremental lista Type=2 a partir de '
  '(cursor − 1 dia). NULL → próximo ciclo é completo.';

-- Bootstrap: onde já existe snapshot válido, o próximo ciclo pode ser
-- incremental a partir do último sucesso (a janela de 1 dia cobre a diferença).
update public.hits_snapshot_sync_state
set last_cursor_at = last_success_at,
    last_mode = 'full'
where id = true
  and last_cursor_at is null
  and last_success_at is not null
  and exists (select 1 from public.hits_reservas_snapshot);

-- -----------------------------------------------------------------------
-- 2) RPC: fixar o cursor após uma leitura COMPLETA bem-sucedida
--    (a RPC hits_snapshot_sync_apply existente continua igual)
-- -----------------------------------------------------------------------
create or replace function public.hits_snapshot_sync_set_cursor(
  p_batch_id uuid,
  p_cursor_at timestamptz,
  p_mode text default 'full'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_batch_id is null or p_cursor_at is null then
    raise exception 'hits_snapshot_cursor_required' using errcode = '22023';
  end if;
  if p_mode not in ('full', 'incremental') then
    raise exception 'hits_snapshot_mode_invalid' using errcode = '22023';
  end if;
  -- Só o lote que acabou de ser aplicado com sucesso pode fixar o cursor.
  update public.hits_snapshot_sync_state
  set last_cursor_at = p_cursor_at,
      last_mode = p_mode,
      updated_at = now()
  where id = true
    and last_success_batch_id = p_batch_id;
end;
$$;

comment on function public.hits_snapshot_sync_set_cursor(uuid, timestamptz, text) is
  'Fixa last_cursor_at/last_mode após um apply bem-sucedido do mesmo batch. '
  'Não altera linhas do snapshot. Só service_role.';

-- -----------------------------------------------------------------------
-- 3) RPC: aplicação INCREMENTAL, atômica
--    p_rows: reservas alteradas (allowlist de campos, igual à completa)
--    p_failed_ids: detalhes que falharam (fotografia anterior preservada)
--    p_cancelled_ids: status 2 no detalhe → removidas do snapshot (sinal
--                     explícito do HITS; nunca por ausência)
--    p_status: 'ok' | 'partial'
--    p_cursor_at: novo cursor; NULL = não avançar (ciclo partial)
-- -----------------------------------------------------------------------
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
      case
        when (r ->> 'check_in') ~ '^\d{4}-\d{2}-\d{2}'
          then left(r ->> 'check_in', 10)::date
      end as check_in,
      case
        when (r ->> 'check_out') ~ '^\d{4}-\d{2}-\d{2}'
          then left(r ->> 'check_out', 10)::date
      end as check_out,
      case when (r ->> 'status_reserva') = 'cancelada' then 'cancelada' else 'ativa' end
        as status_reserva,
      case when (r ->> 'ciclo_hits') = 'hospedada' then 'hospedada' else 'confirmada' end
        as ciclo_hits,
      case
        when (r ->> 'total_hospedes') ~ '^\d{1,4}$'
          then greatest(1, (r ->> 'total_hospedes')::integer)
        else 1
      end as total_hospedes
    from jsonb_array_elements(p_rows) as r
  ),
  dedup as (
    select distinct on (external_reservation_id) *
    from src
    where external_reservation_id is not null
      and external_reservation_id ~ '^[A-Za-z0-9._-]{1,128}$'
      -- cancelada nunca entra/permanece como linha do snapshot
      and status_reserva <> 'cancelada'
    order by external_reservation_id
  ),
  ins as (
    insert into public.hits_reservas_snapshot as s (
      external_reservation_id, apartamento, hospede_principal, check_in, check_out,
      status_reserva, ciclo_hits, total_hospedes, source, batch_id,
      first_seen_at, last_seen_at, updated_at
    )
    select
      d.external_reservation_id, d.apartamento, d.hospede_principal, d.check_in, d.check_out,
      d.status_reserva, d.ciclo_hits, d.total_hospedes, 'hits', p_batch_id,
      v_now, v_now, v_now
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

  -- Remoção SÓ de canceladas explícitas (status 2 confirmado no detalhe).
  -- Ausência no incremental nunca remove.
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
      last_mode = 'incremental',
      -- cursor só avança em ciclo ok (sem detalhe falho); partial mantém o anterior
      last_cursor_at = case
        when p_status = 'ok' and p_cursor_at is not null then p_cursor_at
        else last_cursor_at
      end,
      updated_at = v_now
  where id = true;

  rows_upserted := v_upserted;
  rows_removed := v_removed;
  return next;
end;
$$;

comment on function public.hits_snapshot_sync_apply_incremental(uuid, jsonb, text[], text[], text, text, timestamptz) is
  'Aplica atomicamente um lote INCREMENTAL (Type=2): upsert das alteradas, remoção '
  'apenas de canceladas explícitas, nunca por ausência; cursor avança só em ok. '
  'Só service_role. Nunca escreve no HITS.';

-- Grants mínimos: nada para PUBLIC/anon/authenticated; EXECUTE só service_role.
revoke all on function public.hits_snapshot_sync_set_cursor(uuid, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.hits_snapshot_sync_apply_incremental(uuid, jsonb, text[], text[], text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.hits_snapshot_sync_set_cursor(uuid, timestamptz, text)
  to service_role;
grant execute on function public.hits_snapshot_sync_apply_incremental(uuid, jsonb, text[], text[], text, text, timestamptz)
  to service_role;
