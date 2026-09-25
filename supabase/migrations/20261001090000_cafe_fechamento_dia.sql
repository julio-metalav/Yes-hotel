-- Café da manhã — fechamento operacional do SERVIÇO DO DIA.
--
-- Até aqui não existia nenhuma noção de "serviço encerrado": a tela só tinha
-- contadores por apartamento, e conclusão era inferida de atendidos = previstos.
-- Isso é inferência, não fato operacional — e não sobrevive a um dia em que
-- alguém simplesmente não desceu para o café.
--
-- Esta migration cria o fechamento EXPLÍCITO e persistido por DATA (não por
-- reserva): quem encerrou, quando, e se o dia foi reaberto. Depois de
-- concluído, o dia vira consulta: o + / − e o "marcar todos" param de gravar.
-- Só admin reabre.
--
-- Escopo estrito: fechamento diário do café. Não toca mealPlanDesc, snapshot,
-- HITS, FNRH, financeiro, senha, TAG nem scheduler. A única alteração fora da
-- tabela nova é a guarda de dia concluído dentro de
-- `operacional_cafe_set_atendimento` — que é justamente o efeito do fechamento.

-- ---------------------------------------------------------------------------
-- 1. Estado do serviço por data. Chave única: data_cafe.
-- ---------------------------------------------------------------------------
create table if not exists public.operacional_cafe_fechamentos (
  id uuid primary key default gen_random_uuid(),
  data_cafe date not null,
  status text not null default 'aberto'
    check (status in ('aberto', 'concluido')),
  concluido_em timestamptz,
  concluido_por_usuario_interno_id uuid
    references public.usuarios_internos (id) on delete set null,
  concluido_por_auth_user_id uuid,
  -- Nome desnormalizado no momento do fechamento: a tela precisa exibir
  -- "Concluído às 10:32 por Fulano" sem depender de join nem de o usuário
  -- continuar ativo depois.
  concluido_por_nome text,
  reaberto_em timestamptz,
  reaberto_por_usuario_interno_id uuid
    references public.usuarios_internos (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operacional_cafe_fechamentos_unique_data unique (data_cafe),
  -- Concluído sem carimbo de quando seria um fechamento sem prova.
  constraint operacional_cafe_fechamentos_concluido_check
    check (status <> 'concluido' or concluido_em is not null)
);

comment on table public.operacional_cafe_fechamentos is
  'Fechamento operacional do café por DATA. Explícito e persistido: nunca '
  'inferir conclusão de atendidos = previstos.';
comment on column public.operacional_cafe_fechamentos.status is
  'aberto = permite + / − e marcar todos. concluido = tela em modo consulta.';
comment on column public.operacional_cafe_fechamentos.concluido_por_nome is
  'Nome do usuário no momento do fechamento, para exibição histórica.';

drop trigger if exists operacional_cafe_fechamentos_updated_at
  on public.operacional_cafe_fechamentos;
create trigger operacional_cafe_fechamentos_updated_at
  before update on public.operacional_cafe_fechamentos
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Auditoria mínima: histórico de conclusões e reaberturas.
--    A tabela acima guarda só o estado atual; reabrir e concluir de novo
--    sobrescreveria o rastro anterior.
-- ---------------------------------------------------------------------------
create table if not exists public.operacional_cafe_fechamento_auditoria (
  id uuid primary key default gen_random_uuid(),
  fechamento_id uuid
    references public.operacional_cafe_fechamentos (id) on delete set null,
  data_cafe date not null,
  acao text not null check (acao in ('concluir', 'reabrir')),
  usuario_interno_id uuid
    references public.usuarios_internos (id) on delete set null,
  auth_user_id uuid,
  usuario_nome text,
  criado_em timestamptz not null default now()
);

create index if not exists operacional_cafe_fechamento_auditoria_data_idx
  on public.operacional_cafe_fechamento_auditoria (data_cafe, criado_em desc);

-- ---------------------------------------------------------------------------
-- 3. RLS: leitura para quem opera/consulta o café; escrita só pelas RPCs.
--    Mesmo padrão das tabelas de atendimento.
-- ---------------------------------------------------------------------------
alter table public.operacional_cafe_fechamentos enable row level security;
alter table public.operacional_cafe_fechamento_auditoria enable row level security;

drop policy if exists operacional_cafe_fechamentos_select on public.operacional_cafe_fechamentos;
create policy operacional_cafe_fechamentos_select
  on public.operacional_cafe_fechamentos
  for select
  to authenticated
  using (public.is_yes_hotel_cafe_reader());

drop policy if exists operacional_cafe_fechamentos_write_deny on public.operacional_cafe_fechamentos;
create policy operacional_cafe_fechamentos_write_deny
  on public.operacional_cafe_fechamentos
  for all
  to authenticated
  using (false)
  with check (false);

drop policy if exists operacional_cafe_fechamento_auditoria_select on public.operacional_cafe_fechamento_auditoria;
create policy operacional_cafe_fechamento_auditoria_select
  on public.operacional_cafe_fechamento_auditoria
  for select
  to authenticated
  using (public.is_yes_hotel_cafe_reader());

drop policy if exists operacional_cafe_fechamento_auditoria_write_deny on public.operacional_cafe_fechamento_auditoria;
create policy operacional_cafe_fechamento_auditoria_write_deny
  on public.operacional_cafe_fechamento_auditoria
  for all
  to authenticated
  using (false)
  with check (false);

revoke insert, update, delete on public.operacional_cafe_fechamentos from authenticated, anon;
revoke insert, update, delete on public.operacional_cafe_fechamento_auditoria from authenticated, anon;
grant select on public.operacional_cafe_fechamentos to authenticated;
grant select on public.operacional_cafe_fechamento_auditoria to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Leitura do estado do dia. Sempre devolve uma linha, mesmo sem registro:
--    dia sem fechamento é 'aberto'. Evita a tela ter que interpretar ausência.
-- ---------------------------------------------------------------------------
-- O nome de quem concluiu sai daqui já resolvido. Não dá para a tela buscá-lo
-- por join: a RLS de `usuarios_internos` só deixa cada um ler o próprio
-- perfil. Por isso o nome é gravado no fechamento e devolvido por esta RPC
-- SECURITY DEFINER, mesmo padrão de `demandas_usuario_nome`.
create or replace function public.operacional_cafe_status_dia(p_data_cafe date)
returns table (
  data_cafe date,
  status text,
  concluido_em timestamptz,
  concluido_por_nome text,
  reaberto_em timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_row public.operacional_cafe_fechamentos%rowtype;
begin
  if auth.uid() is null then
    raise exception 'cafe_unauthenticated' using errcode = '42501';
  end if;

  if not public.is_yes_hotel_cafe_reader() then
    raise exception 'cafe_read_forbidden_role' using errcode = '42501';
  end if;

  if p_data_cafe is null then
    raise exception 'cafe_invalid_date' using errcode = '22023';
  end if;

  select * into v_row
  from public.operacional_cafe_fechamentos f
  where f.data_cafe = p_data_cafe;

  data_cafe := p_data_cafe;
  status := coalesce(v_row.status, 'aberto');
  concluido_em := v_row.concluido_em;
  concluido_por_nome := v_row.concluido_por_nome;
  reaberto_em := v_row.reaberto_em;
  return next;
end;
$$;

comment on function public.operacional_cafe_status_dia(date) is
  'Estado do serviço de café na data. Ausência de registro = aberto.';

revoke all on function public.operacional_cafe_status_dia(date) from public, anon;
grant execute on function public.operacional_cafe_status_dia(date) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Concluir o dia. Perfis cafe/recepcao/admin, data não futura.
--    NÃO exige 100% atendidos: o serviço acaba no horário, não na meta.
-- ---------------------------------------------------------------------------
create or replace function public.operacional_cafe_fechar_dia(p_data_cafe date)
returns public.operacional_cafe_fechamentos
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.usuarios_internos%rowtype;
  v_today date;
  v_row public.operacional_cafe_fechamentos%rowtype;
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

  if p_data_cafe is null then
    raise exception 'cafe_invalid_date' using errcode = '22023';
  end if;

  v_today := (now() at time zone 'America/Campo_Grande')::date;
  if p_data_cafe > v_today then
    raise exception 'cafe_write_forbidden_future_date' using errcode = '22023';
  end if;

  -- Trava a linha da data contra clique duplo / dois operadores simultâneos.
  select * into v_row
  from public.operacional_cafe_fechamentos f
  where f.data_cafe = p_data_cafe
  for update;

  -- Idempotente: já concluído devolve o fechamento existente, sem novo
  -- carimbo e sem nova linha de auditoria. Reconcluir não reescreve história.
  if v_row.id is not null and v_row.status = 'concluido' then
    return v_row;
  end if;

  insert into public.operacional_cafe_fechamentos (
    data_cafe,
    status,
    concluido_em,
    concluido_por_usuario_interno_id,
    concluido_por_auth_user_id,
    concluido_por_nome
  ) values (
    p_data_cafe,
    'concluido',
    now(),
    v_user.id,
    auth.uid(),
    v_user.nome
  )
  on conflict (data_cafe)
  do update set
    status = 'concluido',
    concluido_em = now(),
    concluido_por_usuario_interno_id = excluded.concluido_por_usuario_interno_id,
    concluido_por_auth_user_id = excluded.concluido_por_auth_user_id,
    concluido_por_nome = excluded.concluido_por_nome,
    updated_at = now()
  returning * into v_row;

  insert into public.operacional_cafe_fechamento_auditoria (
    fechamento_id, data_cafe, acao, usuario_interno_id, auth_user_id, usuario_nome
  ) values (
    v_row.id, p_data_cafe, 'concluir', v_user.id, auth.uid(), v_user.nome
  );

  return v_row;
end;
$$;

comment on function public.operacional_cafe_fechar_dia(date) is
  'Encerra o serviço de café da data. Explícito, idempotente e auditado. '
  'Não depende de atendidos = previstos.';

revoke all on function public.operacional_cafe_fechar_dia(date) from public, anon;
grant execute on function public.operacional_cafe_fechar_dia(date) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Reabrir o dia. SOMENTE admin — café e recepção não desfazem fechamento.
-- ---------------------------------------------------------------------------
create or replace function public.operacional_cafe_reabrir_dia(p_data_cafe date)
returns public.operacional_cafe_fechamentos
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.usuarios_internos%rowtype;
  v_row public.operacional_cafe_fechamentos%rowtype;
begin
  if auth.uid() is null then
    raise exception 'cafe_unauthenticated' using errcode = '42501';
  end if;

  select * into v_user
  from public.usuarios_internos u
  where u.auth_user_id = auth.uid()
    and u.ativo = true
  limit 1;

  if v_user.id is null or lower(v_user.perfil_usuario) <> 'admin' then
    raise exception 'cafe_reopen_forbidden_role' using errcode = '42501';
  end if;

  select * into v_row
  from public.operacional_cafe_fechamentos f
  where f.data_cafe = p_data_cafe
  for update;

  if v_row.id is null then
    raise exception 'cafe_dia_nao_concluido' using errcode = 'P0002';
  end if;

  -- Idempotente no outro sentido: já aberto não gera novo rastro.
  if v_row.status = 'aberto' then
    return v_row;
  end if;

  update public.operacional_cafe_fechamentos
  set status = 'aberto',
      reaberto_em = now(),
      reaberto_por_usuario_interno_id = v_user.id,
      updated_at = now()
  where id = v_row.id
  returning * into v_row;

  insert into public.operacional_cafe_fechamento_auditoria (
    fechamento_id, data_cafe, acao, usuario_interno_id, auth_user_id, usuario_nome
  ) values (
    v_row.id, p_data_cafe, 'reabrir', v_user.id, auth.uid(), v_user.nome
  );

  return v_row;
end;
$$;

comment on function public.operacional_cafe_reabrir_dia(date) is
  'Reabre o serviço de café da data. Exclusivo de admin; cafe/recepcao não reabrem.';

revoke all on function public.operacional_cafe_reabrir_dia(date) from public, anon;
grant execute on function public.operacional_cafe_reabrir_dia(date) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Efeito do fechamento na gravação de atendimento.
--    Única mudança em operacional_cafe_set_atendimento: dia concluído recusa.
--    Todo o resto — perfis, data futura, FOR UPDATE, upsert, auditoria, piso 0
--    e ausência de teto pelo direito — fica idêntico à versão vigente
--    (20260928090000_cafe_controle_operacional).
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
  v_dia_status text;
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

  -- NOVO: serviço encerrado não recebe mais lançamento. Só admin reabre.
  select f.status into v_dia_status
  from public.operacional_cafe_fechamentos f
  where f.data_cafe = p_data_cafe;

  if coalesce(v_dia_status, 'aberto') = 'concluido' then
    raise exception 'cafe_write_forbidden_dia_concluido' using errcode = '22023';
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
  -- sincronizada e continua sendo GRAVADO. Segue sem limitar o atendimento.
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
  'com perfil cafe/recepcao/admin. Recusa se o dia já foi concluído. O direito '
  'é gravado, não limita: só marcar_todos exige direito real.';

-- Assinatura inalterada: revoke/grant reafirmados (idempotente).
revoke all on function public.operacional_cafe_set_atendimento(date, uuid, integer, text)
  from public, anon;
grant execute on function public.operacional_cafe_set_atendimento(date, uuid, integer, text)
  to authenticated;
