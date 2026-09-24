-- Snapshot operacional das reservas HITS (projeção local, somente leitura para a UI).
--
-- Por quê: a tela de Check-in lia o HITS ao vivo pela Edge hits-reservations-preview
-- (dezenas de GETs sequenciais no gateway). Em PROD isso leva 100–160 s e o gateway
-- de funções do Supabase corta em 150 s → a UI recebia 504 e mostrava "0 reservas".
-- O scheduler (pg_cron, migration 20260922100000) já lê o HITS a cada 10 min e
-- descartava a resposta. Agora a mesma leitura grava esta projeção e a UI lê daqui.
--
-- Escopo estrito:
--   * SOMENTE campos exibidos pela área HITS da tela (id HITS, apto, nome do
--     hóspede principal, datas, status, ciclo, total de hóspedes). Nada de
--     documento, telefone, e-mail, valores, pagamento, payload bruto.
--   * Escrita apenas via as 3 RPCs abaixo (EXECUTE só para service_role, chamadas
--     pela Edge). Usuário do navegador é somente leitura (RLS por perfil).
--   * Nenhuma escrita no HITS. Nenhuma relação com operacional_reservas.
--   * Atualização atômica: uma transação por lote (batch_id). Falha no meio do
--     ciclo nunca apaga a fotografia anterior (hits_snapshot_sync_fail só marca).
--
-- Idempotente (create if not exists / create or replace / drop policy if exists).
-- Aplicar primeiro em HOMO (kzprrnbafamuozhyikgb). Não aplicar em PROD nesta etapa.

-- -----------------------------------------------------------------------
-- 1) Projeção
-- -----------------------------------------------------------------------
create table if not exists public.hits_reservas_snapshot (
  external_reservation_id text primary key,
  apartamento text not null default '',
  hospede_principal text not null default '',
  check_in date,
  check_out date,
  status_reserva text not null default 'ativa'
    check (status_reserva in ('ativa', 'cancelada')),
  ciclo_hits text not null default 'confirmada'
    check (ciclo_hits in ('confirmada', 'hospedada')),
  total_hospedes integer not null default 1
    check (total_hospedes >= 1),
  source text not null default 'hits'
    check (source = 'hits'),
  batch_id uuid not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.hits_reservas_snapshot is
  'Projeção local (somente leitura para a UI) das reservas lidas do HITS pelo '
  'scheduler via hits-reservations-preview. Só campos exibidos pela área HITS do '
  'Check-in: sem documento, contato, financeiro ou payload bruto. Escrita apenas '
  'pelas RPCs hits_snapshot_sync_* (service_role). Nunca escreve no HITS.';

create index if not exists hits_reservas_snapshot_check_in_idx
  on public.hits_reservas_snapshot (check_in);
create index if not exists hits_reservas_snapshot_batch_id_idx
  on public.hits_reservas_snapshot (batch_id);

-- -----------------------------------------------------------------------
-- 2) Controle de execução (linha única)
-- -----------------------------------------------------------------------
create table if not exists public.hits_snapshot_sync_state (
  id boolean primary key default true check (id),
  last_started_at timestamptz,
  last_started_batch_id uuid,
  last_finished_at timestamptz,
  last_status text
    check (last_status in ('running', 'ok', 'partial', 'error')),
  last_error text,
  last_stopped_reason text,
  last_rows_count integer,
  last_failed_count integer,
  last_success_at timestamptz,
  last_success_batch_id uuid,
  last_success_rows_count integer,
  updated_at timestamptz not null default now()
);

comment on table public.hits_snapshot_sync_state is
  'Linha única com o estado do último ciclo de sync do snapshot HITS: iniciado, '
  'concluído, bem-sucedido (ok/partial), erro do último ciclo e contagens. '
  'A UI usa last_success_at/last_status para o indicador de saúde.';

insert into public.hits_snapshot_sync_state (id)
values (true)
on conflict (id) do nothing;

-- -----------------------------------------------------------------------
-- 3) RLS: negar anon; SELECT só para perfis que veem a área HITS da tela
--    (admin/recepcao via is_yes_hotel_ops_reader; hits_consulta via
--    is_yes_hotel_hits_consulta_reader — mesmos gates já existentes).
--    Nenhuma policy de INSERT/UPDATE/DELETE: escrita só por service_role
--    (bypassa RLS) através das RPCs abaixo.
-- -----------------------------------------------------------------------
alter table public.hits_reservas_snapshot enable row level security;
alter table public.hits_snapshot_sync_state enable row level security;

revoke all on table public.hits_reservas_snapshot from public, anon;
revoke all on table public.hits_snapshot_sync_state from public, anon;
revoke insert, update, delete, truncate, references, trigger
  on table public.hits_reservas_snapshot from authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.hits_snapshot_sync_state from authenticated;
grant select on table public.hits_reservas_snapshot to authenticated;
grant select on table public.hits_snapshot_sync_state to authenticated;

drop policy if exists hits_reservas_snapshot_select_perfis on public.hits_reservas_snapshot;
create policy hits_reservas_snapshot_select_perfis
  on public.hits_reservas_snapshot
  for select
  to authenticated
  using (public.is_yes_hotel_ops_reader() or public.is_yes_hotel_hits_consulta_reader());

drop policy if exists hits_snapshot_sync_state_select_perfis on public.hits_snapshot_sync_state;
create policy hits_snapshot_sync_state_select_perfis
  on public.hits_snapshot_sync_state
  for select
  to authenticated
  using (public.is_yes_hotel_ops_reader() or public.is_yes_hotel_hits_consulta_reader());

-- -----------------------------------------------------------------------
-- 4) RPCs de escrita (service_role apenas). SECURITY DEFINER com search_path
--    vazio e tudo schema-qualificado.
-- -----------------------------------------------------------------------

-- 4a) Início do ciclo: só marca. Não toca nas linhas do snapshot.
create or replace function public.hits_snapshot_sync_start(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_batch_id is null then
    raise exception 'hits_snapshot_batch_required' using errcode = '22023';
  end if;
  update public.hits_snapshot_sync_state
  set last_started_at = now(),
      last_started_batch_id = p_batch_id,
      last_status = 'running',
      updated_at = now()
  where id = true;
end;
$$;

comment on function public.hits_snapshot_sync_start(uuid) is
  'Marca o início de um ciclo de sync do snapshot HITS (batch_id). Não altera linhas.';

-- 4b) Aplicação atômica do lote completo.
--   p_rows: array JSON com o shape da Edge (external_reservation_id, apartamento,
--           hospede_principal, check_in, check_out, status_reserva, ciclo_hits,
--           total_hospedes). Qualquer outro campo é ignorado (allowlist).
--   p_failed_ids: ids cujo detalhe falhou neste ciclo — a última fotografia válida
--           deles é MANTIDA (não são removidos por não terem vindo no lote).
--   p_status: 'ok' (lote completo) ou 'partial' (houve p_failed_ids).
--   Remoção: linhas de lotes anteriores que não vieram neste lote e não estão em
--   p_failed_ids saíram da janela/status lido pelo scheduler → removidas.
--   Tudo na mesma transação: a UI nunca vê snapshot parcialmente reconstruído.
create or replace function public.hits_snapshot_sync_apply(
  p_batch_id uuid,
  p_rows jsonb,
  p_failed_ids text[] default '{}',
  p_status text default 'ok',
  p_stopped_reason text default null
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
      last_success_at = v_now,
      last_success_batch_id = p_batch_id,
      last_success_rows_count = v_upserted,
      updated_at = v_now
  where id = true;

  rows_upserted := v_upserted;
  rows_removed := v_removed;
  return next;
end;
$$;

comment on function public.hits_snapshot_sync_apply(uuid, jsonb, text[], text, text) is
  'Aplica atomicamente um lote completo do snapshot HITS: upsert das linhas (allowlist '
  'de campos), remoção do que saiu da janela (exceto ids com detalhe falho) e '
  'atualização do estado. Só service_role. Nunca escreve no HITS.';

-- 4c) Falha do ciclo: só registra. Nenhuma linha do snapshot é tocada.
create or replace function public.hits_snapshot_sync_fail(p_batch_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.hits_snapshot_sync_state
  set last_finished_at = now(),
      last_status = 'error',
      last_error = left(coalesce(nullif(btrim(p_error), ''), 'erro'), 300),
      updated_at = now()
  where id = true;
end;
$$;

comment on function public.hits_snapshot_sync_fail(uuid, text) is
  'Registra falha de um ciclo de sync do snapshot HITS. Não altera linhas: a última '
  'fotografia válida permanece para a UI.';

-- Grants mínimos: nada para PUBLIC/anon/authenticated; EXECUTE só service_role.
revoke all on function public.hits_snapshot_sync_start(uuid) from public, anon, authenticated;
revoke all on function public.hits_snapshot_sync_apply(uuid, jsonb, text[], text, text)
  from public, anon, authenticated;
revoke all on function public.hits_snapshot_sync_fail(uuid, text) from public, anon, authenticated;
grant execute on function public.hits_snapshot_sync_start(uuid) to service_role;
grant execute on function public.hits_snapshot_sync_apply(uuid, jsonb, text[], text, text)
  to service_role;
grant execute on function public.hits_snapshot_sync_fail(uuid, text) to service_role;
