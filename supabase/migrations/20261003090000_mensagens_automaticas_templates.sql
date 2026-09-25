-- Mensagens automaticas com texto editavel em Configuracoes.
--
-- Ate aqui todo texto enviado ao hospede vivia hardcoded no codigo. Trocar uma
-- virgula exigia deploy. Esta migration tira o TEXTO do codigo e mantem a
-- REGRA onde ela precisa estar.
--
-- Principio que a modelagem protege: editar o texto NAO pode mudar quando a
-- mensagem sai, para quem sai, nem quantas vezes sai. Por isso a tabela guarda
-- corpo e nada mais. Nao ha coluna de gatilho, horario, canal ou destinatario
-- -- justamente para que a tela nao tenha o que alterar.
--
-- Cada mensagem e uma LINHA propria, com chave unica. Um campo unico com tudo
-- faria uma edicao de boas-vindas derrubar o aviso de tolerancia.
--
-- Escopo: so esta tabela e suas RPCs. Nao toca tolerancia, FNRH, pagamento,
-- TTLock, credenciais, HITS, comissionamento, scheduler nem outbox.

-- ---------------------------------------------------------------------------
-- 1. Tabela
-- ---------------------------------------------------------------------------
create table if not exists public.operacional_mensagens_templates (
  id uuid primary key default gen_random_uuid(),
  chave text not null,
  corpo text not null,
  -- Auditoria minima: quem mexeu no texto que chega ao hospede.
  atualizado_por_usuario_interno_id uuid
    references public.usuarios_internos (id) on delete set null,
  atualizado_por_nome text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operacional_mensagens_templates_chave_uidx unique (chave),
  constraint operacional_mensagens_templates_corpo_check
    check (btrim(corpo) <> '' and length(corpo) <= 4000)
);

comment on table public.operacional_mensagens_templates is
  'Texto editavel das mensagens automaticas. So conteudo: o gatilho de envio '
  'permanece no codigo e nao e configuravel por aqui.';
comment on column public.operacional_mensagens_templates.chave is
  'Identificador estavel da mensagem (ex.: boas_vindas_primeiro_acesso). '
  'Espelha CATALOGO_MENSAGENS em src/lib/domain/yes-hotel/mensagens-catalogo.ts.';
comment on column public.operacional_mensagens_templates.corpo is
  'Texto com parametros {{nome}}. O mesmo corpo alimenta WhatsApp e e-mail.';

drop trigger if exists operacional_mensagens_templates_updated_at
  on public.operacional_mensagens_templates;
create trigger operacional_mensagens_templates_updated_at
  before update on public.operacional_mensagens_templates
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Historico. Texto que chega ao hospede merece rastro de quem mudou.
-- ---------------------------------------------------------------------------
create table if not exists public.operacional_mensagens_templates_historico (
  id uuid primary key default gen_random_uuid(),
  template_id uuid
    references public.operacional_mensagens_templates (id) on delete set null,
  chave text not null,
  corpo_anterior text,
  corpo_novo text not null,
  usuario_interno_id uuid
    references public.usuarios_internos (id) on delete set null,
  auth_user_id uuid,
  usuario_nome text,
  criado_em timestamptz not null default now()
);

create index if not exists operacional_mensagens_templates_hist_chave_idx
  on public.operacional_mensagens_templates_historico (chave, criado_em desc);

-- ---------------------------------------------------------------------------
-- 3. RLS: le quem opera, escreve so pela RPC. Mesmo padrao das demais tabelas
--    operacionais -- nenhuma escrita direta por authenticated.
-- ---------------------------------------------------------------------------
alter table public.operacional_mensagens_templates enable row level security;
alter table public.operacional_mensagens_templates_historico enable row level security;

drop policy if exists operacional_mensagens_templates_select on public.operacional_mensagens_templates;
create policy operacional_mensagens_templates_select
  on public.operacional_mensagens_templates
  for select to authenticated
  using (public.is_yes_hotel_ops_reader());

drop policy if exists operacional_mensagens_templates_write_deny on public.operacional_mensagens_templates;
create policy operacional_mensagens_templates_write_deny
  on public.operacional_mensagens_templates
  for all to authenticated
  using (false) with check (false);

drop policy if exists operacional_mensagens_templates_hist_select on public.operacional_mensagens_templates_historico;
create policy operacional_mensagens_templates_hist_select
  on public.operacional_mensagens_templates_historico
  for select to authenticated
  using (public.is_yes_hotel_ops_reader());

drop policy if exists operacional_mensagens_templates_hist_write_deny on public.operacional_mensagens_templates_historico;
create policy operacional_mensagens_templates_hist_write_deny
  on public.operacional_mensagens_templates_historico
  for all to authenticated
  using (false) with check (false);

revoke insert, update, delete on public.operacional_mensagens_templates from authenticated, anon;
revoke insert, update, delete on public.operacional_mensagens_templates_historico from authenticated, anon;
grant select on public.operacional_mensagens_templates to authenticated;
grant select on public.operacional_mensagens_templates_historico to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Leitura. Devolve tudo o que a tela precisa listar.
-- ---------------------------------------------------------------------------
create or replace function public.operacional_mensagens_listar()
returns table (
  chave text,
  corpo text,
  atualizado_por_nome text,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'mensagens_unauthenticated' using errcode = '42501';
  end if;
  if not public.is_yes_hotel_ops_reader() then
    raise exception 'mensagens_read_forbidden_role' using errcode = '42501';
  end if;

  return query
    select t.chave, t.corpo, t.atualizado_por_nome, t.updated_at
    from public.operacional_mensagens_templates t
    order by t.chave;
end;
$$;

comment on function public.operacional_mensagens_listar() is
  'Lista os textos editaveis das mensagens automaticas.';

revoke all on function public.operacional_mensagens_listar() from public, anon;
grant execute on function public.operacional_mensagens_listar() to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Escrita. SOMENTE o corpo muda.
--
-- A RPC nao aceita canal, gatilho, horario nem destinatario: nao existe
-- parametro para isso. E a garantia estrutural de que a tela edita conteudo e
-- nunca regra operacional.
--
-- Chave desconhecida e recusada: a tela nao inventa mensagem nova, porque
-- mensagem nova exige codigo que a dispare.
-- ---------------------------------------------------------------------------
create or replace function public.operacional_mensagens_salvar(
  p_chave text,
  p_corpo text
)
returns public.operacional_mensagens_templates
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.usuarios_internos%rowtype;
  v_anterior text;
  v_row public.operacional_mensagens_templates%rowtype;
begin
  if auth.uid() is null then
    raise exception 'mensagens_unauthenticated' using errcode = '42501';
  end if;

  select * into v_user
  from public.usuarios_internos u
  where u.auth_user_id = auth.uid()
    and u.ativo = true
  limit 1;

  -- Texto que chega ao hospede: so admin e recepcao editam.
  if v_user.id is null or lower(v_user.perfil_usuario) not in ('admin', 'recepcao') then
    raise exception 'mensagens_write_forbidden_role' using errcode = '42501';
  end if;

  if p_corpo is null or btrim(p_corpo) = '' then
    raise exception 'mensagens_corpo_vazio' using errcode = '22023';
  end if;
  if length(p_corpo) > 4000 then
    raise exception 'mensagens_corpo_longo' using errcode = '22023';
  end if;

  select t.corpo into v_anterior
  from public.operacional_mensagens_templates t
  where t.chave = p_chave
  for update;

  if v_anterior is null then
    raise exception 'mensagens_chave_desconhecida' using errcode = 'P0002';
  end if;

  update public.operacional_mensagens_templates
  set corpo = p_corpo,
      atualizado_por_usuario_interno_id = v_user.id,
      atualizado_por_nome = v_user.nome,
      updated_at = now()
  where chave = p_chave
  returning * into v_row;

  insert into public.operacional_mensagens_templates_historico (
    template_id, chave, corpo_anterior, corpo_novo,
    usuario_interno_id, auth_user_id, usuario_nome
  ) values (
    v_row.id, p_chave, v_anterior, p_corpo,
    v_user.id, auth.uid(), v_user.nome
  );

  return v_row;
end;
$$;

comment on function public.operacional_mensagens_salvar(text, text) is
  'Salva SOMENTE o corpo da mensagem. Nao ha parametro de gatilho, canal ou '
  'horario: a tela edita conteudo, nunca regra. Audita quem alterou.';

revoke all on function public.operacional_mensagens_salvar(text, text) from public, anon;
grant execute on function public.operacional_mensagens_salvar(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Seed: uma linha por mensagem do catalogo.
--
-- Gerado a partir de CATALOGO_MENSAGENS, para nao existir segunda fonte de
-- verdade. Ha teste que falha se banco e catalogo divergirem.
--
-- `on conflict do nothing` de proposito: reaplicar a migration NAO pode
-- sobrescrever texto que a recepcao ja ajustou. O padrao so entra quando a
-- linha ainda nao existe.
-- ---------------------------------------------------------------------------
insert into public.operacional_mensagens_templates (chave, corpo) values
  ('boas_vindas_primeiro_acesso', 'Olá, {{hospede_nome}}! Seja bem-vindo ao Yes Hotel.

Apartamento: {{apartamento}}

Wi-Fi:
Rede: {{wifi_rede}}
Senha: {{wifi_senha}}

Check-out: {{checkout_horario}}

Em caso de necessidade, fale conosco pelo {{telefone_recepcao}}.'),
  ('senha_de_acesso', 'Olá, {{hospede_nome}}! Sua senha de acesso ao apartamento {{apartamento}} já está ativa.

Qualquer dúvida, fale conosco pelo {{telefone_recepcao}}.'),
  ('pendencia_fnrh', 'Bem-vindo ao Yes Hotel, {{hospede_nome}}.

Ainda existem fichas de hóspedes pendentes nesta reserva.
Regularize em até 1 hora para evitar a suspensão temporária das senhas.'),
  ('pendencia_pagamento', 'Bem-vindo ao Yes Hotel, {{hospede_nome}}.

O pagamento da sua reserva ainda está pendente.
Regularize em até 1 hora para evitar a suspensão temporária das senhas.'),
  ('pendencia_fnrh_e_pagamento', 'Bem-vindo ao Yes Hotel, {{hospede_nome}}.

O pagamento e o preenchimento das fichas de hóspedes ainda estão pendentes.
Regularize em até 1 hora para evitar a suspensão temporária das senhas.'),
  ('aviso_tolerancia_1h', '{{hospede_nome}}, as senhas de acesso do apartamento {{apartamento}} foram
temporariamente suspensas por pendências não regularizadas.

Fale conosco pelo {{telefone_recepcao}} para liberar novamente.'),
  ('pagamento_presencial_diferido', 'Bem-vindo, {{hospede_nome}}!

O café da manhã é servido das 06h às 09h.
Aproveite para regularizar o pagamento com a recepção até às 09h de amanhã.

Qualquer dúvida, fale conosco pelo {{telefone_recepcao}}.'),
  ('check_out', '{{hospede_nome}}, seu check-out está previsto para {{data_saida}}, às {{checkout_horario}}.

Foi um prazer receber você no Yes Hotel.
Qualquer necessidade, fale conosco pelo {{telefone_recepcao}}.')
on conflict (chave) do nothing;

-- ---------------------------------------------------------------------------
-- 7. Autoverificacao: as oito mensagens presentes e nenhuma vazia.
-- ---------------------------------------------------------------------------
do $$
declare
  v_total integer;
  v_vazias integer;
begin
  select count(*) into v_total from public.operacional_mensagens_templates;
  if v_total < 8 then
    raise exception 'seed incompleto: % mensagens (esperado 8)', v_total;
  end if;

  select count(*) into v_vazias
  from public.operacional_mensagens_templates
  where btrim(corpo) = '';
  if v_vazias > 0 then
    raise exception 'ha % mensagem(ns) com corpo vazio', v_vazias;
  end if;

  if not exists (
    select 1 from public.operacional_mensagens_templates
    where chave = 'boas_vindas_primeiro_acesso'
  ) then
    raise exception 'mensagem boas_vindas_primeiro_acesso ausente';
  end if;

  raise notice 'mensagens automaticas: % templates disponiveis', v_total;
end $$;
