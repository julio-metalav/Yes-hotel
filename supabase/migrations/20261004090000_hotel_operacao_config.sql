-- Configuracao operacional do hotel: horario de check-out e telefone da recepcao.
--
-- Ate aqui esses dois valores viviam como constantes em
-- src/lib/infrastructure/supabase/yes-hotel/index.ts (CHECKOUT_HORARIO = '11h'
-- e TELEFONE_RECEPCAO). Trocar o telefone da recepcao exigia deploy de Edge.
--
-- Eles passam a viver aqui, no mesmo lugar conceitual do Wi-Fi e da
-- geolocalizacao: configuracao do hotel, editavel em Configuracoes.
--
-- Fronteira que esta migration protege: o TEXTO da mensagem e editavel na tela
-- de Mensagens automaticas; o VALOR de check-out e de telefone e editavel aqui.
-- Sao duas tabelas, duas telas e duas RPCs diferentes de proposito -- editar o
-- texto nao pode mudar o horario de check-out do hotel, e vice-versa. O
-- template so cita {{checkout_horario}} e {{telefone_recepcao}}; quem resolve o
-- valor e o codigo, lendo esta tabela.
--
-- Escopo: so esta tabela, seu historico e sua RPC. Nao toca tolerancia, FNRH,
-- pagamento, TTLock, credenciais, HITS, comissionamento, scheduler nem outbox.
-- Em especial, NAO altera a janela de validade da credencial (check-out 11:00
-- em America/Campo_Grande), que e regra de fechadura e continua no codigo.

-- ---------------------------------------------------------------------------
-- 1. Tabela (singleton, mesmo padrao de hotel_geo_config)
-- ---------------------------------------------------------------------------
create table if not exists public.hotel_operacao_config (
  id boolean primary key default true check (id),
  checkout_horario text not null,
  telefone_recepcao text not null,
  atualizado_por_usuario_interno_id uuid
    references public.usuarios_internos (id) on delete set null,
  atualizado_por_nome text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Aceita '11h', '11h30' ou '11:00'. O valor vai literalmente para o texto
  -- que o hospede recebe, entao nao pode ser frase livre.
  constraint hotel_operacao_config_checkout_check
    check (checkout_horario ~ '^[0-9]{1,2}(h[0-9]{0,2}|:[0-9]{2})$'),
  -- Digitos, espaco, parenteses, + e hifen. Sem texto livre.
  constraint hotel_operacao_config_telefone_check
    check (telefone_recepcao ~ '^[0-9()+ -]{8,24}$')
);

comment on table public.hotel_operacao_config is
  'Configuracao operacional do hotel exibida ao hospede (horario de check-out '
  'e telefone da recepcao). Fonte unica: o template so cita o parametro.';
comment on column public.hotel_operacao_config.checkout_horario is
  'Horario de saida como aparece no texto ao hospede (ex.: 11h). Valor '
  'informativo: a janela civil que vale para a senha continua no codigo.';
comment on column public.hotel_operacao_config.telefone_recepcao is
  'Telefone da recepcao divulgado ao hospede. Nao e o numero interno DigiSac.';

drop trigger if exists hotel_operacao_config_updated_at on public.hotel_operacao_config;
create trigger hotel_operacao_config_updated_at
  before update on public.hotel_operacao_config
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Historico append-only. Dado que chega ao hospede merece rastro.
-- ---------------------------------------------------------------------------
create table if not exists public.hotel_operacao_config_historico (
  id uuid primary key default gen_random_uuid(),
  estado_anterior jsonb,
  estado_novo jsonb not null,
  usuario_interno_id uuid
    references public.usuarios_internos (id) on delete set null,
  auth_user_id uuid,
  usuario_nome text,
  origem text not null default 'rpc',
  criado_em timestamptz not null default now()
);

create index if not exists hotel_operacao_config_hist_criado_idx
  on public.hotel_operacao_config_historico (criado_em desc);

create or replace function public.hotel_operacao_config_historico_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'hotel_operacao_config_historico e append-only: UPDATE/DELETE proibidos';
end;
$$;

drop trigger if exists hotel_operacao_config_hist_no_update on public.hotel_operacao_config_historico;
create trigger hotel_operacao_config_hist_no_update
  before update on public.hotel_operacao_config_historico
  for each row execute function public.hotel_operacao_config_historico_append_only();

drop trigger if exists hotel_operacao_config_hist_no_delete on public.hotel_operacao_config_historico;
create trigger hotel_operacao_config_hist_no_delete
  before delete on public.hotel_operacao_config_historico
  for each row execute function public.hotel_operacao_config_historico_append_only();

-- ---------------------------------------------------------------------------
-- 3. RLS: le quem opera, escreve so pela RPC.
-- ---------------------------------------------------------------------------
alter table public.hotel_operacao_config enable row level security;
alter table public.hotel_operacao_config_historico enable row level security;

drop policy if exists hotel_operacao_config_select on public.hotel_operacao_config;
create policy hotel_operacao_config_select
  on public.hotel_operacao_config
  for select to authenticated
  using (public.is_yes_hotel_ops_reader());

drop policy if exists hotel_operacao_config_write_deny on public.hotel_operacao_config;
create policy hotel_operacao_config_write_deny
  on public.hotel_operacao_config
  for all to authenticated
  using (false) with check (false);

drop policy if exists hotel_operacao_config_hist_select on public.hotel_operacao_config_historico;
create policy hotel_operacao_config_hist_select
  on public.hotel_operacao_config_historico
  for select to authenticated
  using (public.is_yes_hotel_ops_reader());

drop policy if exists hotel_operacao_config_hist_write_deny on public.hotel_operacao_config_historico;
create policy hotel_operacao_config_hist_write_deny
  on public.hotel_operacao_config_historico
  for all to authenticated
  using (false) with check (false);

revoke insert, update, delete on public.hotel_operacao_config from authenticated, anon;
revoke insert, update, delete on public.hotel_operacao_config_historico from authenticated, anon;
grant select on public.hotel_operacao_config to authenticated;
grant select on public.hotel_operacao_config_historico to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Escrita. So os dois valores; nada de texto de mensagem aqui.
-- ---------------------------------------------------------------------------
create or replace function public.hotel_operacao_config_salvar(
  p_checkout_horario text,
  p_telefone_recepcao text
)
returns public.hotel_operacao_config
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.usuarios_internos%rowtype;
  v_anterior jsonb;
  v_row public.hotel_operacao_config%rowtype;
  v_checkout text := btrim(coalesce(p_checkout_horario, ''));
  v_telefone text := btrim(coalesce(p_telefone_recepcao, ''));
begin
  if auth.uid() is null then
    raise exception 'hotel_operacao_config_unauthenticated' using errcode = '42501';
  end if;

  select * into v_user
  from public.usuarios_internos u
  where u.auth_user_id = auth.uid()
    and u.ativo = true
  limit 1;

  -- Dado divulgado ao hospede: so admin e recepcao editam.
  if v_user.id is null or lower(v_user.perfil_usuario) not in ('admin', 'recepcao') then
    raise exception 'hotel_operacao_config_forbidden_role' using errcode = '42501';
  end if;

  if v_checkout !~ '^[0-9]{1,2}(h[0-9]{0,2}|:[0-9]{2})$' then
    raise exception 'hotel_operacao_config_checkout_invalido' using errcode = '22023';
  end if;
  if v_telefone !~ '^[0-9()+ -]{8,24}$' then
    raise exception 'hotel_operacao_config_telefone_invalido' using errcode = '22023';
  end if;

  select to_jsonb(c) into v_anterior
  from public.hotel_operacao_config c
  where c.id = true
  for update;

  insert into public.hotel_operacao_config (
    id, checkout_horario, telefone_recepcao,
    atualizado_por_usuario_interno_id, atualizado_por_nome
  ) values (
    true, v_checkout, v_telefone, v_user.id, v_user.nome
  )
  on conflict (id) do update
  set checkout_horario = excluded.checkout_horario,
      telefone_recepcao = excluded.telefone_recepcao,
      atualizado_por_usuario_interno_id = excluded.atualizado_por_usuario_interno_id,
      atualizado_por_nome = excluded.atualizado_por_nome,
      updated_at = now()
  returning * into v_row;

  insert into public.hotel_operacao_config_historico (
    estado_anterior, estado_novo, usuario_interno_id, auth_user_id, usuario_nome
  ) values (
    v_anterior, to_jsonb(v_row), v_user.id, auth.uid(), v_user.nome
  );

  return v_row;
end;
$$;

comment on function public.hotel_operacao_config_salvar(text, text) is
  'Salva horario de check-out e telefone da recepcao. Nao aceita texto de '
  'mensagem: conteudo e configuracao operacional sao telas diferentes.';

revoke all on function public.hotel_operacao_config_salvar(text, text) from public, anon;
grant execute on function public.hotel_operacao_config_salvar(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Seed com os valores praticados hoje, para que nada mude no envio.
--
-- `on conflict do nothing`: reaplicar a migration nao pode sobrescrever o que
-- a recepcao ja ajustou.
-- ---------------------------------------------------------------------------
insert into public.hotel_operacao_config (id, checkout_horario, telefone_recepcao)
values (true, '11h', '(67) 99668-8886')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 6. Autoverificacao: a linha unica existe e esta preenchida.
-- ---------------------------------------------------------------------------
do $$
declare
  v_row public.hotel_operacao_config%rowtype;
begin
  select * into v_row from public.hotel_operacao_config where id = true;
  if v_row.id is null then
    raise exception 'hotel_operacao_config sem linha singleton apos o seed';
  end if;
  if btrim(v_row.checkout_horario) = '' or btrim(v_row.telefone_recepcao) = '' then
    raise exception 'hotel_operacao_config com valor vazio';
  end if;
  raise notice 'hotel_operacao_config pronto (check-out %)', v_row.checkout_horario;
end $$;
