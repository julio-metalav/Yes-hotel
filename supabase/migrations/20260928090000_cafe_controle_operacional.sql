-- Café da manhã — controle operacional: o direito deixa de ser TETO do atendimento.
--
-- Problema: enquanto o contrato de meal_plan_desc não está homologado,
-- `operacional_cafe_resolve_entitlement` devolve sempre `nao_mapeado` com
-- direito 0. Com isso o atendimento ficava impossível em duas camadas:
--   1. o CHECK da tabela exigia `quantidade_atendida <= quantidade_direito`;
--   2. a RPC recusava `nao_mapeado`/`sem_cafe`/direito 0 e ainda limitava o
--      incremento a `least(v_prev + 1, v_entitled)`.
-- Resultado prático: a tela inteira parecia "somente consulta".
--
-- Aqui o direito passa a ser REGISTRO (auditoria/telemetria), não limite. O
-- operador conta quem tomou café; cobrança e direito continuam fora deste
-- caminho. NÃO se presume direito a café em lugar nenhum: `marcar_todos`
-- continua exigindo direito real, porque "marcar todos" só tem significado
-- quando existe um total oficial — a UI desabilita o botão enquanto isso não
-- vier do mealPlanDesc (próxima etapa).
--
-- Tudo o que protegia continua: autenticação obrigatória, perfil autorizado,
-- data não futura, reserva existente e não cancelada, SELECT ... FOR UPDATE
-- (atômico contra clique duplo), upsert idempotente por (reserva, data),
-- auditoria com usuário e quantidades, e RLS negando escrita direta — a
-- gravação só existe por esta RPC.
--
-- Fora de escopo, intocados: meal_plan_desc/HITS, população de apartamentos,
-- FNRH, financeiro, senha, TAG. Nenhuma escrita no HITS.

-- ---------------------------------------------------------------------------
-- 1. Piso continua 0; o teto pelo direito sai.
-- ---------------------------------------------------------------------------
alter table public.operacional_cafe_atendimentos
  drop constraint if exists operacional_cafe_atendimentos_qty_check;

alter table public.operacional_cafe_atendimentos
  add constraint operacional_cafe_atendimentos_qty_check
  check (quantidade_atendida >= 0 and quantidade_direito >= 0);

comment on column public.operacional_cafe_atendimentos.quantidade_direito is
  'Direito calculado no servidor no momento da gravação. REGISTRO, não limite: '
  'o atendimento pode ser maior (inclusive com direito 0) enquanto o contrato '
  'de meal_plan_desc não estiver homologado.';

-- ---------------------------------------------------------------------------
-- 2. Perfis que operam o café: cafe, recepcao e admin.
--    (helper mantido em sincronia com a RPC; hoje nenhuma policy o usa)
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
      and lower(u.perfil_usuario) in ('cafe', 'recepcao', 'admin')
  );
$$;

comment on function public.is_yes_hotel_cafe_writer() is
  'Perfis autorizados a registrar atendimento de café: cafe, recepcao, admin.';

-- ---------------------------------------------------------------------------
-- 3. RPC de gravação — mesma assinatura, mesmas guardas, sem teto por direito.
-- ---------------------------------------------------------------------------
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

  if v_user.id is null or lower(v_user.perfil_usuario) not in ('cafe', 'recepcao', 'admin') then
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

  -- Direito oficial: continua calculado no servidor a partir da reserva
  -- sincronizada e continua sendo GRAVADO. Só deixou de limitar o atendimento.
  select e.cafe_kind, e.quantidade_direito
    into v_kind, v_entitled
  from public.operacional_cafe_resolve_entitlement(
    v_reserva.meal_plan_desc,
    v_reserva.total_hospedes_hits,
    coalesce(v_reserva.cafe_avulso_pago_qtd, 0)
  ) e;

  v_kind := coalesce(v_kind, 'nao_mapeado');
  v_entitled := greatest(0, coalesce(v_entitled, 0));

  select a.quantidade_atendida into v_prev
  from public.operacional_cafe_atendimentos a
  where a.operacional_reserva_id = p_operacional_reserva_id
    and a.data_cafe = p_data_cafe;

  v_prev := coalesce(v_prev, 0);

  if p_acao = 'increment' then
    v_next := v_prev + 1;
  elsif p_acao = 'decrement' then
    v_next := greatest(v_prev - 1, 0);
  elsif p_acao = 'marcar_todos' then
    -- Único caso que ainda exige direito real: sem total oficial não há "todos"
    -- a marcar, e presumir direito a café é justamente o que não se faz.
    if v_kind not in ('incluido', 'avulso_pago') or v_entitled <= 0 then
      raise exception 'cafe_write_forbidden_no_entitlement' using errcode = '22023';
    end if;
    v_next := v_entitled;
  else
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

comment on function public.operacional_cafe_set_atendimento(date, uuid, integer, text) is
  'Grava o atendimento de café de uma reserva na data. Atômica (FOR UPDATE + '
  'upsert por reserva+data), audita toda mudança e exige usuário autenticado '
  'com perfil cafe/recepcao/admin. O direito é gravado, não limita: só '
  'marcar_todos exige direito real.';

-- Assinatura inalterada: revoke/grant reafirmados (idempotente).
revoke all on function public.operacional_cafe_set_atendimento(date, uuid, integer, text)
  from public, anon;
grant execute on function public.operacional_cafe_set_atendimento(date, uuid, integer, text)
  to authenticated;
