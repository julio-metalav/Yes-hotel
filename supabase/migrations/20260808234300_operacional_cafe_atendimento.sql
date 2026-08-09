-- Café da manhã operacional: atendimento por reserva sincronizada + auditoria.
-- Homologação autorizada: projeto Yes_Hotel_automação (ref minmmecajnmjqlgacfoz).
-- NÃO aplicar em Meta Lav nem em deploy de produção Vercel nesta rodada.
-- FK em operacional_reservas (não no legado public.reservas / cafe_presencas).

-- ---------------------------------------------------------------------------
-- Colunas de projeção HITS (sem interpretar incluído/avulso)
-- ---------------------------------------------------------------------------
alter table public.operacional_reservas
  add column if not exists total_hospedes_hits integer,
  add column if not exists meal_plan_desc text,
  add column if not exists cafe_avulso_pago_qtd integer not null default 0;

comment on column public.operacional_reservas.total_hospedes_hits is
  'Quantidade oficial sincronizada do HITS (rooms[].pax → totalGuests). Não usar FNRH.';
comment on column public.operacional_reservas.meal_plan_desc is
  'Texto bruto HITS rooms[].mealPlanDesc. Sem mapeamento de negócio até homologação.';
comment on column public.operacional_reservas.cafe_avulso_pago_qtd is
  'Quantidade oficial de café avulso pago sincronizada do HITS. Default 0 até contrato homologado; nunca aceitar do navegador.';

alter table public.operacional_reservas
  drop constraint if exists operacional_reservas_total_hospedes_hits_check;

alter table public.operacional_reservas
  add constraint operacional_reservas_total_hospedes_hits_check
  check (total_hospedes_hits is null or total_hospedes_hits >= 0);

alter table public.operacional_reservas
  drop constraint if exists operacional_reservas_cafe_avulso_pago_qtd_check;

alter table public.operacional_reservas
  add constraint operacional_reservas_cafe_avulso_pago_qtd_check
  check (cafe_avulso_pago_qtd >= 0);

-- ---------------------------------------------------------------------------
-- Atendimento do café (chave estável: data + reserva operacional)
-- ---------------------------------------------------------------------------
create table if not exists public.operacional_cafe_atendimentos (
  id uuid primary key default gen_random_uuid(),
  data_cafe date not null,
  operacional_reserva_id uuid not null
    references public.operacional_reservas (id) on delete cascade,
  external_reservation_id text,
  apartamento text not null default '',
  quantidade_atendida integer not null default 0,
  quantidade_direito integer not null default 0,
  cafe_kind text not null default 'nao_mapeado'
    check (cafe_kind in ('incluido', 'sem_cafe', 'avulso_pago', 'nao_mapeado')),
  updated_by_usuario_interno_id uuid
    references public.usuarios_internos (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operacional_cafe_atendimentos_unique_reserva_data
    unique (operacional_reserva_id, data_cafe),
  constraint operacional_cafe_atendimentos_qty_check
    check (
      quantidade_atendida >= 0
      and quantidade_direito >= 0
      and quantidade_atendida <= quantidade_direito
    )
);

create index if not exists operacional_cafe_atendimentos_data_idx
  on public.operacional_cafe_atendimentos (data_cafe);

create index if not exists operacional_cafe_atendimentos_reserva_idx
  on public.operacional_cafe_atendimentos (operacional_reserva_id);

drop trigger if exists operacional_cafe_atendimentos_updated_at
  on public.operacional_cafe_atendimentos;
create trigger operacional_cafe_atendimentos_updated_at
  before update on public.operacional_cafe_atendimentos
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Auditoria
-- ---------------------------------------------------------------------------
create table if not exists public.operacional_cafe_atendimento_auditoria (
  id uuid primary key default gen_random_uuid(),
  atendimento_id uuid
    references public.operacional_cafe_atendimentos (id) on delete set null,
  data_cafe date not null,
  operacional_reserva_id uuid not null
    references public.operacional_reservas (id) on delete cascade,
  external_reservation_id text,
  apartamento text not null default '',
  usuario_interno_id uuid
    references public.usuarios_internos (id) on delete set null,
  auth_user_id uuid,
  acao text not null
    check (acao in ('set', 'increment', 'decrement', 'marcar_todos')),
  quantidade_anterior integer not null,
  quantidade_nova integer not null,
  criado_em timestamptz not null default now()
);

create index if not exists operacional_cafe_auditoria_data_idx
  on public.operacional_cafe_atendimento_auditoria (data_cafe, criado_em desc);

create index if not exists operacional_cafe_auditoria_reserva_idx
  on public.operacional_cafe_atendimento_auditoria (operacional_reserva_id);

-- ---------------------------------------------------------------------------
-- Helpers de perfil
-- ---------------------------------------------------------------------------
create or replace function public.is_yes_hotel_cafe_writer()
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
      and lower(u.perfil_usuario) = 'cafe'
  );
$$;

create or replace function public.is_yes_hotel_cafe_reader()
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
      and lower(u.perfil_usuario) in ('admin', 'recepcao', 'cafe')
  );
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.operacional_cafe_atendimentos enable row level security;
alter table public.operacional_cafe_atendimento_auditoria enable row level security;

drop policy if exists operacional_cafe_atendimentos_select on public.operacional_cafe_atendimentos;
create policy operacional_cafe_atendimentos_select
  on public.operacional_cafe_atendimentos
  for select
  to authenticated
  using (public.is_yes_hotel_cafe_reader());

-- Escrita direta bloqueada: somente via RPC security definer.
drop policy if exists operacional_cafe_atendimentos_write_deny on public.operacional_cafe_atendimentos;
create policy operacional_cafe_atendimentos_write_deny
  on public.operacional_cafe_atendimentos
  for all
  to authenticated
  using (false)
  with check (false);

drop policy if exists operacional_cafe_auditoria_select on public.operacional_cafe_atendimento_auditoria;
create policy operacional_cafe_auditoria_select
  on public.operacional_cafe_atendimento_auditoria
  for select
  to authenticated
  using (public.is_yes_hotel_cafe_reader());

drop policy if exists operacional_cafe_auditoria_write_deny on public.operacional_cafe_atendimento_auditoria;
create policy operacional_cafe_auditoria_write_deny
  on public.operacional_cafe_atendimento_auditoria
  for all
  to authenticated
  using (false)
  with check (false);

revoke insert, update, delete on public.operacional_cafe_atendimentos from authenticated, anon;
revoke insert, update, delete on public.operacional_cafe_atendimento_auditoria from authenticated, anon;
grant select on public.operacional_cafe_atendimentos to authenticated;
grant select on public.operacional_cafe_atendimento_auditoria to authenticated;

-- ---------------------------------------------------------------------------
-- Direito oficial (somente dados persistidos; nunca parâmetros do cliente)
-- ---------------------------------------------------------------------------
-- Contrato HITS de meal_plan_desc / avulso ainda NÃO homologado.
-- Sem tabela de códigos aprovada: qualquer meal_plan_desc → nao_mapeado.
-- Não interpretar texto (ex.: "Cafe da manha").
-- cafe_avulso_pago_qtd só libera após sync oficial homologado (hoje: 0).
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
set search_path = public
as $$
begin
  -- Assinatura recebe os campos persistidos da reserva para futura homologação
  -- (meal_plan_desc / total_hospedes_hits / cafe_avulso_pago_qtd).
  -- Hoje: sem códigos oficiais → sempre nao_mapeado; zero direito.
  -- NÃO interpretar texto de meal_plan_desc (ex.: "Cafe da manha").
  cafe_kind := 'nao_mapeado';
  quantidade_direito := 0;
  return next;
end;
$$;

revoke all on function public.operacional_cafe_resolve_entitlement(text, integer, integer)
  from public, anon;
grant execute on function public.operacional_cafe_resolve_entitlement(text, integer, integer)
  to authenticated;

-- ---------------------------------------------------------------------------
-- RPC atômica de gravação
-- Cliente envia SOMENTE: data, id estável da reserva, quantidade/ação.
-- Direito (kind + limite) é calculado no servidor a partir da reserva sincronizada.
-- ---------------------------------------------------------------------------
drop function if exists public.operacional_cafe_set_atendimento(date, uuid, integer, integer, text, text);
drop function if exists public.operacional_cafe_set_atendimento(date, uuid, integer, text);

create or replace function public.operacional_cafe_set_atendimento(
  p_data_cafe date,
  p_operacional_reserva_id uuid,
  p_quantidade_atendida integer default null,
  p_acao text default 'set'
)
returns public.operacional_cafe_atendimentos
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.usuarios_internos%rowtype;
  v_reserva public.operacional_reservas%rowtype;
  v_today date;
  v_prev integer := 0;
  v_next integer;
  v_kind text;
  v_entitled integer;
  v_row public.operacional_cafe_atendimentos%rowtype;
begin
  if auth.uid() is null then
    raise exception 'cafe_unauthenticated' using errcode = '42501';
  end if;

  select * into v_user
  from public.usuarios_internos u
  where u.auth_user_id = auth.uid()
    and u.ativo = true
  limit 1;

  if v_user.id is null or lower(v_user.perfil_usuario) <> 'cafe' then
    raise exception 'cafe_write_forbidden_role' using errcode = '42501';
  end if;

  -- Data civil no fuso America/Campo_Grande.
  v_today := (now() at time zone 'America/Campo_Grande')::date;
  if p_data_cafe > v_today then
    raise exception 'cafe_write_forbidden_future_date' using errcode = '22023';
  end if;

  if p_acao is null or p_acao not in ('set', 'increment', 'decrement', 'marcar_todos') then
    raise exception 'cafe_invalid_action' using errcode = '22023';
  end if;

  select * into v_reserva
  from public.operacional_reservas r
  where r.id = p_operacional_reserva_id
  for update;

  if v_reserva.id is null then
    raise exception 'cafe_reservation_not_found' using errcode = 'P0002';
  end if;

  if lower(coalesce(v_reserva.status_reserva, '')) = 'cancelada' then
    raise exception 'cafe_reservation_cancelled' using errcode = '22023';
  end if;

  -- Direito oficial: somente colunas persistidas da reserva sincronizada.
  select e.cafe_kind, e.quantidade_direito
    into v_kind, v_entitled
  from public.operacional_cafe_resolve_entitlement(
    v_reserva.meal_plan_desc,
    v_reserva.total_hospedes_hits,
    coalesce(v_reserva.cafe_avulso_pago_qtd, 0)
  ) e;

  v_kind := coalesce(v_kind, 'nao_mapeado');
  v_entitled := greatest(0, coalesce(v_entitled, 0));

  if v_kind = 'nao_mapeado' then
    raise exception 'cafe_write_forbidden_unmapped_entitlement' using errcode = '22023';
  end if;

  if v_kind = 'sem_cafe' or v_kind not in ('incluido', 'avulso_pago') or v_entitled <= 0 then
    raise exception 'cafe_write_forbidden_no_entitlement' using errcode = '22023';
  end if;

  select a.quantidade_atendida into v_prev
  from public.operacional_cafe_atendimentos a
  where a.operacional_reserva_id = p_operacional_reserva_id
    and a.data_cafe = p_data_cafe
  for update;

  v_prev := coalesce(v_prev, 0);

  if p_acao = 'increment' then
    v_next := least(v_prev + 1, v_entitled);
  elsif p_acao = 'decrement' then
    v_next := greatest(v_prev - 1, 0);
  elsif p_acao = 'marcar_todos' then
    v_next := v_entitled;
  else
    -- set: rejeita quantidade acima do direito oficial (não confia no cliente).
    if coalesce(p_quantidade_atendida, 0) > v_entitled then
      raise exception 'cafe_write_forbidden_over_entitlement' using errcode = '22023';
    end if;
    if coalesce(p_quantidade_atendida, 0) < 0 then
      raise exception 'cafe_invalid_quantity' using errcode = '22023';
    end if;
    v_next := coalesce(p_quantidade_atendida, 0);
  end if;

  insert into public.operacional_cafe_atendimentos (
    data_cafe,
    operacional_reserva_id,
    external_reservation_id,
    apartamento,
    quantidade_atendida,
    quantidade_direito,
    cafe_kind,
    updated_by_usuario_interno_id
  ) values (
    p_data_cafe,
    p_operacional_reserva_id,
    v_reserva.external_reservation_id,
    coalesce(v_reserva.apartamento, ''),
    v_next,
    v_entitled,
    v_kind,
    v_user.id
  )
  on conflict (operacional_reserva_id, data_cafe)
  do update set
    quantidade_atendida = excluded.quantidade_atendida,
    quantidade_direito = excluded.quantidade_direito,
    cafe_kind = excluded.cafe_kind,
    external_reservation_id = excluded.external_reservation_id,
    apartamento = excluded.apartamento,
    updated_by_usuario_interno_id = excluded.updated_by_usuario_interno_id,
    updated_at = now()
  returning * into v_row;

  insert into public.operacional_cafe_atendimento_auditoria (
    atendimento_id,
    data_cafe,
    operacional_reserva_id,
    external_reservation_id,
    apartamento,
    usuario_interno_id,
    auth_user_id,
    acao,
    quantidade_anterior,
    quantidade_nova
  ) values (
    v_row.id,
    p_data_cafe,
    p_operacional_reserva_id,
    v_reserva.external_reservation_id,
    coalesce(v_reserva.apartamento, ''),
    v_user.id,
    auth.uid(),
    p_acao,
    v_prev,
    v_next
  );

  return v_row;
end;
$$;

revoke all on function public.operacional_cafe_set_atendimento(date, uuid, integer, text)
  from public, anon;
grant execute on function public.operacional_cafe_set_atendimento(date, uuid, integer, text)
  to authenticated;
