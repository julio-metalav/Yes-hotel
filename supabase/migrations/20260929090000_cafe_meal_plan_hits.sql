-- Café da manhã — plano de refeição do HITS percorre a cadeia até a tela.
--
-- O HITS já entrega `rooms[].mealPlanDesc` e o normalizador já lê. O campo
-- morria antes do snapshot, então o direito ao café era sempre `nao_mapeado`
-- com quantidade 0. Aqui ele passa a ser persistido e classificado.
--
-- HOMOLOGAÇÃO (lista fechada, observação real em PROD por GET, 83 reservas
-- amostradas em janela de ±45 dias, 25/09/2026 — só dois valores existem):
--     "Café da Manhã"  (79 ocorrências)  -> incluido
--     "Nenhum"         ( 4 ocorrências)  -> sem_cafe
-- Qualquer outro valor, NULL ou vazio -> nao_mapeado (a tela mostra NÃO
-- IDENTIFICADO). Ausência de informação NUNCA vira "sem café", e não existe
-- heurística por substring ("contém cafe") — um plano novo como "Meia pensão"
-- cairia nela por engano. A comparação normaliza só espaços, caixa e acento; o
-- texto bruto é preservado.
--
-- Espelhos que precisam andar juntos: src/lib/domain/yes-hotel/cafe-meal-plan.ts
-- e ui/yes-cafe-policy.js.
--
-- Preservado: RLS, grants, security definer, search_path, auditoria do café e a
-- RPC de atendimento do controle operacional. O teto
-- `quantidade_atendida <= quantidade_direito` NÃO volta.

-- ---------------------------------------------------------------------------
-- 1. Snapshot HITS ganha o plano de refeição (aditivo, nullable).
-- ---------------------------------------------------------------------------
alter table public.hits_reservas_snapshot
  add column if not exists meal_plan_desc text;

comment on column public.hits_reservas_snapshot.meal_plan_desc is
  'Texto bruto de rooms[].mealPlanDesc do HITS. Fonte do direito ao café; '
  'classificado por operacional_cafe_resolve_entitlement. NULL = não declarado.';

-- ---------------------------------------------------------------------------
-- 2. Apply COMPLETO: carrega meal_plan_desc e conta como alteração funcional.
-- ---------------------------------------------------------------------------
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
      case when (r ->> 'total_hospedes') ~ '^\d{1,4}$' then greatest(1, (r ->> 'total_hospedes')::integer) else 1 end as total_hospedes,
      nullif(left(btrim(coalesce(r ->> 'meal_plan_desc', '')), 160), '') as meal_plan_desc
    from jsonb_array_elements(p_rows) as r
  ),
  dedup as (
    select distinct on (external_reservation_id) *
    from src
    where external_reservation_id is not null
      and external_reservation_id ~ '^[A-Za-z0-9._-]{1,128}$'
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
       or s.meal_plan_desc is distinct from d.meal_plan_desc
  ),
  ins as (
    insert into public.hits_reservas_snapshot as s (
      external_reservation_id, apartamento, hospede_principal, check_in, check_out,
      status_reserva, ciclo_hits, total_hospedes, meal_plan_desc, source, batch_id,
      first_seen_at, last_seen_at, updated_at
    )
    select d.external_reservation_id, d.apartamento, d.hospede_principal, d.check_in, d.check_out,
           d.status_reserva, d.ciclo_hits, d.total_hospedes, d.meal_plan_desc, 'hits', p_batch_id, v_now, v_now, v_now
    from dedup d
    on conflict (external_reservation_id) do update
      set apartamento = excluded.apartamento,
          hospede_principal = excluded.hospede_principal,
          check_in = excluded.check_in,
          check_out = excluded.check_out,
          status_reserva = excluded.status_reserva,
          ciclo_hits = excluded.ciclo_hits,
          total_hospedes = excluded.total_hospedes,
          meal_plan_desc = excluded.meal_plan_desc,
          batch_id = excluded.batch_id,
          last_seen_at = v_now,
          updated_at = v_now
    returning 1
  )
  select (select count(*) from ins), (select count(*) from changed)
  into v_upserted, v_changed;

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
-- 3. Apply INCREMENTAL: idem.
-- ---------------------------------------------------------------------------
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
      case when (r ->> 'total_hospedes') ~ '^\d{1,4}$' then greatest(1, (r ->> 'total_hospedes')::integer) else 1 end as total_hospedes,
      nullif(left(btrim(coalesce(r ->> 'meal_plan_desc', '')), 160), '') as meal_plan_desc
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
       or s.meal_plan_desc is distinct from d.meal_plan_desc
  ),
  ins as (
    insert into public.hits_reservas_snapshot as s (
      external_reservation_id, apartamento, hospede_principal, check_in, check_out,
      status_reserva, ciclo_hits, total_hospedes, meal_plan_desc, source, batch_id,
      first_seen_at, last_seen_at, updated_at
    )
    select d.external_reservation_id, d.apartamento, d.hospede_principal, d.check_in, d.check_out,
           d.status_reserva, d.ciclo_hits, d.total_hospedes, d.meal_plan_desc, 'hits', p_batch_id, v_now, v_now, v_now
    from dedup d
    on conflict (external_reservation_id) do update
      set apartamento = excluded.apartamento,
          hospede_principal = excluded.hospede_principal,
          check_in = excluded.check_in,
          check_out = excluded.check_out,
          status_reserva = excluded.status_reserva,
          ciclo_hits = excluded.ciclo_hits,
          total_hospedes = excluded.total_hospedes,
          meal_plan_desc = excluded.meal_plan_desc,
          batch_id = excluded.batch_id,
          last_seen_at = v_now,
          updated_at = v_now
    returning 1
  )
  select (select count(*) from ins), (select count(*) from changed)
  into v_upserted, v_changed;

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

-- ---------------------------------------------------------------------------
-- 4. Direito ao café: lista fechada homologada.
-- ---------------------------------------------------------------------------
create or replace function public.operacional_cafe_normalizar_meal_plan(p_desc text)
returns text
language sql
immutable
set search_path = ''
as $$
  -- trim + minúsculas + sem acento + espaços colapsados. Só para COMPARAR.
  select btrim(regexp_replace(
    translate(
      lower(coalesce(p_desc, '')),
      'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ',
      'aaaaaeeeeiiiiooooouuuucnaaaaaeeeeiiiiooooouuuucn'
    ),
    '\s+', ' ', 'g'
  ));
$$;

comment on function public.operacional_cafe_normalizar_meal_plan(text) is
  'Normaliza mealPlanDesc só para comparação (espaços, caixa, acento). Espelha normalizeMealPlanDesc em cafe-meal-plan.ts.';

create or replace function public.operacional_cafe_resolve_entitlement(
  p_meal_plan_desc text,
  p_total_hospedes_hits integer,
  p_cafe_avulso_pago_qtd integer
)
returns table (
  cafe_kind text,
  quantidade_direito integer
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_norm text;
  v_hospedes integer;
  v_avulso integer;
begin
  v_norm := public.operacional_cafe_normalizar_meal_plan(p_meal_plan_desc);
  v_hospedes := greatest(0, coalesce(p_total_hospedes_hits, 0));
  v_avulso := greatest(0, coalesce(p_cafe_avulso_pago_qtd, 0));

  -- Lista FECHADA, observada no HITS de produção. Nada de "contém cafe".
  if v_norm = 'cafe da manha' then
    cafe_kind := 'incluido';
    quantidade_direito := v_hospedes;
    return next;
    return;
  end if;

  -- Avulso pago só com quantidade oficial (hoje sempre 0); independe do plano.
  if v_avulso > 0 then
    cafe_kind := 'avulso_pago';
    quantidade_direito := v_avulso;
    return next;
    return;
  end if;

  if v_norm = 'nenhum' then
    cafe_kind := 'sem_cafe';
    quantidade_direito := 0;
    return next;
    return;
  end if;

  -- Desconhecido, NULL ou vazio: NÃO IDENTIFICADO. Nunca "sem café".
  cafe_kind := 'nao_mapeado';
  quantidade_direito := 0;
  return next;
end;
$$;

comment on function public.operacional_cafe_resolve_entitlement(text, integer, integer) is
  'Direito ao café pelo mealPlanDesc homologado do HITS: "Café da Manhã" -> incluido '
  '(direito = hóspedes), "Nenhum" -> sem_cafe, avulso pago oficial -> avulso_pago, '
  'qualquer outro/NULL/vazio -> nao_mapeado com direito 0.';

revoke all on function public.operacional_cafe_normalizar_meal_plan(text) from public, anon;
grant execute on function public.operacional_cafe_normalizar_meal_plan(text) to authenticated;
revoke all on function public.operacional_cafe_resolve_entitlement(text, integer, integer)
  from public, anon;
grant execute on function public.operacional_cafe_resolve_entitlement(text, integer, integer)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Universo do café: o plano vem do snapshot (fonte HITS), local é fallback.
--    População do dia INALTERADA: check_in < D <= check_out, ativas, e o gate
--    de 6 h do snapshot continua igual.
-- ---------------------------------------------------------------------------
create or replace function public.operacional_cafe_listar_hospedagens(p_data_cafe date)
returns table (
  reservation_id uuid,
  apartment_code text,
  main_guest_name text,
  external_reservation_id text,
  check_in_previsto date,
  check_out_previsto date,
  status_reserva text,
  total_guests integer,
  meal_plan_desc text,
  pagamento_status text,
  pagamento_presencial_diferido_autorizado boolean,
  pagamento_presencial_diferido_efetivado boolean,
  pagamento_presencial_diferido_regularizado_em timestamptz,
  pagamento_presencial_diferido_bloqueado_em timestamptz,
  pagamento_presencial_diferido_deadline_em timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_last_success timestamptz;
begin
  if not public.is_yes_hotel_cafe_reader() then
    raise exception 'cafe_read_forbidden_role' using errcode = '42501';
  end if;

  if p_data_cafe is null then
    raise exception 'cafe_read_missing_date' using errcode = '22023';
  end if;

  select s.last_success_at into v_last_success
  from public.hits_snapshot_sync_state s
  where s.id = true;
  if v_last_success is null or v_last_success < now() - interval '6 hours' then
    raise exception 'Universo HITS indisponível: snapshot sem sincronização recente. O café não pode listar hospedagens agora.'
      using errcode = 'P0001';
  end if;

  return query
    select
      r.id as reservation_id,
      s.apartamento as apartment_code,
      coalesce(nullif(btrim(r.hospede_principal), ''), s.hospede_principal) as main_guest_name,
      s.external_reservation_id,
      s.check_in as check_in_previsto,
      s.check_out as check_out_previsto,
      s.status_reserva,
      case
        when coalesce(s.total_hospedes, 0) > 0 then s.total_hospedes
        when r.id is not null then greatest(
          1,
          (
            select count(*)::integer
            from public.operacional_hospedes h
            where h.reserva_id = r.id
              and coalesce(h.removed_from_reservation, false) = false
          )
        )
        else 1
      end as total_guests,
      -- Plano vem do HITS; o local é só enrichment quando o snapshot não trouxe.
      -- Assim a reserva que existe apenas no snapshot também é classificada.
      coalesce(nullif(btrim(s.meal_plan_desc), ''), r.meal_plan_desc) as meal_plan_desc,
      r.pagamento_status,
      r.pagamento_presencial_diferido_autorizado,
      r.pagamento_presencial_diferido_efetivado,
      r.pagamento_presencial_diferido_regularizado_em,
      r.pagamento_presencial_diferido_bloqueado_em,
      r.pagamento_presencial_diferido_deadline_em
    from public.hits_reservas_snapshot s
    left join public.operacional_reservas r
      on r.external_reservation_id = s.external_reservation_id
     and r.origem_externa = 'hits'
     and r.status_reserva <> 'cancelada'
    where s.status_reserva <> 'cancelada'
      and s.check_in < p_data_cafe
      and s.check_out >= p_data_cafe
    order by s.apartamento, s.external_reservation_id;
end;
$$;

comment on function public.operacional_cafe_listar_hospedagens(date) is
  'Hospedagens do café da data (check_in < D <= check_out) com população do snapshot HITS '
  '(universo ativo) enriquecida por operacional_reservas; reservation_id NULL quando ainda '
  'não materializada; meal_plan_desc do snapshot com fallback local. Erra se o snapshot não '
  'tem sucesso recente. Só cafe/recepcao/admin.';

revoke all on function public.operacional_cafe_listar_hospedagens(date) from public, anon;
grant execute on function public.operacional_cafe_listar_hospedagens(date) to authenticated;
