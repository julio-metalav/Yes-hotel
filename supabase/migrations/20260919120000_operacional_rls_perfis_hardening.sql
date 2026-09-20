-- Segurança Nível 3 — etapa 1: RLS por perfil nas tabelas núcleo do painel
-- operacional (reservas, hóspedes, eventos, FNRH, credenciais).
--
-- Problema corrigido: as migrations 0005, 0006 e 0015 criaram policies
-- genéricas `to authenticated using (true)` / `with check (true)` — qualquer
-- usuário autenticado (independente de estar ativo em usuarios_internos, ou
-- de ter perfil admin/recepcao/cafe) podia ler e escrever livremente nessas
-- tabelas. Esta migration substitui essas policies por autorização real,
-- baseada em public.usuarios_internos por auth.uid(), exigindo ativo = true.
--
-- Fora de escopo nesta etapa (ver instruções da tarefa): perfil
-- hits_homologacao, cron, Status HITS, FNRH/PAX EX, tabela legada
-- public.acessos_senhas, sync HITS, UI, deploy.
--
-- Reaproveita is_yes_hotel_ops_reader() e is_yes_hotel_cafe_reader(), já
-- criadas em 20260803233625/20260803233835 e 20260809005734 respectivamente,
-- com o mesmo desenho (SECURITY DEFINER, search_path fixo, sem confiar em
-- user_metadata). Redeclaradas aqui de forma idempotente (corpo idêntico)
-- só para reafirmar a definição esperada e endurecer os grants de EXECUTE.
--
-- Correção pós-auditoria (achado bloqueante): a primeira versão desta
-- migration dava SELECT direto a is_yes_hotel_cafe_reader() em
-- operacional_reservas/operacional_hospedes — sem filtro de linha, um
-- usuário cafe podia ler a tabela inteira via PostgREST (PII, dados
-- comerciais/financeiros). Agora o SELECT dessas duas tabelas exige
-- is_yes_hotel_ops_reader() (só admin/recepcao); o café passa a usar
-- exclusivamente a RPC public.operacional_cafe_listar_hospedagens(),
-- definida no fim desta migration, que devolve só a janela de data e as
-- colunas que ui/cafe-da-manha-mvp.js realmente consome.

-- -----------------------------------------------------------------------
-- 0) Funções auxiliares de autorização (reafirmação idempotente + grants)
-- -----------------------------------------------------------------------

create or replace function public.is_yes_hotel_ops_reader()
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
      and lower(u.perfil_usuario) in ('admin', 'recepcao')
  );
$$;

comment on function public.is_yes_hotel_ops_reader() is
  'True se o JWT atual pertence a usuario interno ativo admin ou recepcao. '
  'Usada como gate de leitura e escrita nas tabelas núcleo do painel operacional.';

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

comment on function public.is_yes_hotel_cafe_reader() is
  'True se o JWT atual pertence a usuario interno ativo admin, recepcao ou '
  'cafe. NÃO é mais usada em nenhuma policy de operacional_reservas/'
  'operacional_hospedes (achado bloqueante corrigido — cafe não tem SELECT '
  'direto nessas tabelas). Segue em uso em operacional_cafe_atendimentos/'
  'operacional_cafe_atendimento_auditoria (fora do escopo desta migration) '
  'e na RPC operacional_cafe_listar_hospedagens() definida abaixo.';

-- Nenhuma das duas confia em auth.jwt()/user_metadata: ambas resolvem o
-- perfil consultando a linha correspondente em usuarios_internos.
-- EXECUTE por padrão do Postgres é concedido a PUBLIC ao criar a função;
-- revoga aqui e concede só a authenticated (anon nunca precisa chamá-las).
revoke all on function public.is_yes_hotel_ops_reader() from public, anon;
grant execute on function public.is_yes_hotel_ops_reader() to authenticated;

revoke all on function public.is_yes_hotel_cafe_reader() from public, anon;
grant execute on function public.is_yes_hotel_cafe_reader() to authenticated;

-- -----------------------------------------------------------------------
-- 1) public.operacional_reservas
-- -----------------------------------------------------------------------
-- Uso real (verificado no código): admin/recepcao leem e escrevem via
-- ui/checkin-operacional-mvp.js e ui/importar-reservas-mvp.js (select,
-- insert, update — nunca delete client-side). DELETE só ocorre via
-- supabase/functions/pms-hospedin-sync (service_role).
--
-- A tela do café NÃO tem mais SELECT direto aqui (achado bloqueante da
-- auditoria: is_yes_hotel_cafe_reader() sem filtro de linha expunha a tabela
-- inteira — todas as colunas e todas as reservas — a qualquer usuário cafe
-- via PostgREST, não só o que a UI mostra). A listagem do café passa a vir
-- exclusivamente de public.operacional_cafe_listar_hospedagens(), definida
-- mais abaixo nesta migration, que devolve só as colunas e a janela de data
-- que ui/cafe-da-manha-mvp.js realmente usa.

drop policy if exists operacional_reservas_select on public.operacional_reservas;
drop policy if exists operacional_reservas_insert on public.operacional_reservas;
drop policy if exists operacional_reservas_update on public.operacional_reservas;
drop policy if exists operacional_reservas_delete on public.operacional_reservas;

create policy operacional_reservas_select_ops
  on public.operacional_reservas
  for select
  to authenticated
  using (public.is_yes_hotel_ops_reader());

create policy operacional_reservas_insert_ops
  on public.operacional_reservas
  for insert
  to authenticated
  with check (public.is_yes_hotel_ops_reader());

create policy operacional_reservas_update_ops
  on public.operacional_reservas
  for update
  to authenticated
  using (public.is_yes_hotel_ops_reader())
  with check (public.is_yes_hotel_ops_reader());

revoke all on public.operacional_reservas from anon;
revoke delete on public.operacional_reservas from authenticated;
grant select, insert, update on public.operacional_reservas to authenticated;

-- -----------------------------------------------------------------------
-- 2) public.operacional_hospedes
-- -----------------------------------------------------------------------
-- Uso real: admin/recepcao fazem select/insert/update/delete via
-- ui/checkin-operacional-mvp.js.
--
-- A tela do café NÃO tem mais SELECT direto aqui (mesmo achado bloqueante
-- acima). A contagem de hóspedes por reserva (reserva_id,
-- removed_from_reservation) passa a ser calculada dentro de
-- operacional_cafe_listar_hospedagens(), como total_guests já agregado —
-- nunca a lista de hóspedes.

drop policy if exists operacional_hospedes_select on public.operacional_hospedes;
drop policy if exists operacional_hospedes_insert on public.operacional_hospedes;
drop policy if exists operacional_hospedes_update on public.operacional_hospedes;
drop policy if exists operacional_hospedes_delete on public.operacional_hospedes;

create policy operacional_hospedes_select_ops
  on public.operacional_hospedes
  for select
  to authenticated
  using (public.is_yes_hotel_ops_reader());

create policy operacional_hospedes_insert_ops
  on public.operacional_hospedes
  for insert
  to authenticated
  with check (public.is_yes_hotel_ops_reader());

create policy operacional_hospedes_update_ops
  on public.operacional_hospedes
  for update
  to authenticated
  using (public.is_yes_hotel_ops_reader())
  with check (public.is_yes_hotel_ops_reader());

create policy operacional_hospedes_delete_ops
  on public.operacional_hospedes
  for delete
  to authenticated
  using (public.is_yes_hotel_ops_reader());

revoke all on public.operacional_hospedes from anon;
grant select, insert, update, delete on public.operacional_hospedes to authenticated;

-- -----------------------------------------------------------------------
-- 3) public.operacional_reserva_eventos
-- -----------------------------------------------------------------------
-- Uso real: só select + insert (trilha de eventos do painel). Nenhum código
-- faz update/delete — a migration original (0005) também nunca criou essas
-- policies, então não há regressão em mantê-las ausentes.

drop policy if exists operacional_reserva_eventos_select on public.operacional_reserva_eventos;
drop policy if exists operacional_reserva_eventos_insert on public.operacional_reserva_eventos;

create policy operacional_reserva_eventos_select_ops
  on public.operacional_reserva_eventos
  for select
  to authenticated
  using (public.is_yes_hotel_ops_reader());

create policy operacional_reserva_eventos_insert_ops
  on public.operacional_reserva_eventos
  for insert
  to authenticated
  with check (public.is_yes_hotel_ops_reader());

revoke all on public.operacional_reserva_eventos from anon;
revoke update, delete on public.operacional_reserva_eventos from authenticated;
grant select, insert on public.operacional_reserva_eventos to authenticated;

-- -----------------------------------------------------------------------
-- 4) public.fnrh_hospedes
-- -----------------------------------------------------------------------
-- Uso real: o painel (ui/checkin-operacional-mvp.js) só faz select (cadastro
-- confirmado, colunas restritas via FNRH_PAINEL_SELECT). Toda escrita real —
-- formulário público, fnrh-submit, send-fnrh-links, fnrh-document-upload,
-- fnrh-auto-reenvio, pms-hospedin-sync — usa a service_role key, nunca o JWT
-- do usuário; e o trigger fnrh_hospedes_block_frontend_lifecycle_write já
-- bloqueia authenticated nos campos de lifecycle mesmo com policy aberta.
-- Não existe hoje nenhum caminho legítimo de insert/update autenticado
-- direto: as policies antigas de insert/update eram permissão morta e
-- perigosa, não capacidade em uso. fnrh_hospedes_all_service (service_role)
-- é preservada sem alteração.

drop policy if exists fnrh_hospedes_select_auth on public.fnrh_hospedes;
drop policy if exists fnrh_hospedes_insert_auth on public.fnrh_hospedes;
drop policy if exists fnrh_hospedes_update_auth on public.fnrh_hospedes;
-- fnrh_hospedes_all_service (service_role) não é tocada.

create policy fnrh_hospedes_select_ops
  on public.fnrh_hospedes
  for select
  to authenticated
  using (public.is_yes_hotel_ops_reader());

revoke all on public.fnrh_hospedes from anon;
revoke insert, update, delete on public.fnrh_hospedes from authenticated;
grant select on public.fnrh_hospedes to authenticated;

-- -----------------------------------------------------------------------
-- 5) public.operacional_credenciais_acesso / operacional_credencial_itens
--    ("credenciais" no escopo desta tarefa)
-- -----------------------------------------------------------------------
-- Uso real: leitura em ui/checkin-operacional-mvp.js e ui/comunicacao-mvp.js
-- (status de provisionamento TTLock). Toda escrita (criação, provisionamento,
-- revogação) acontece via supabase/functions/yes-hotel-lifecycle,
-- send-senha, senha-auto-envio, ttlock-provision-retry (todas service_role)
-- ou via o trigger SECURITY DEFINER
-- operacional_criar_credencial_ao_liberar_acesso(). Nenhum caminho legítimo
-- de escrita autenticada direta existe hoje.
-- Achado registrado à parte (não tratado nesta etapa): a tabela legada
-- public.acessos_senhas guarda senha_operacional em texto claro
-- (0001_yes_hotel_schema_inicial.sql) e não tem nenhum uso encontrado no
-- código atual (nenhum supabase.from("acessos_senhas") em ui/ ou
-- supabase/functions/) — candidata a descomissionamento, fora do escopo
-- desta etapa.

drop policy if exists operacional_credenciais_acesso_select on public.operacional_credenciais_acesso;
drop policy if exists operacional_credenciais_acesso_insert on public.operacional_credenciais_acesso;
drop policy if exists operacional_credenciais_acesso_update on public.operacional_credenciais_acesso;
drop policy if exists operacional_credenciais_acesso_delete on public.operacional_credenciais_acesso;

drop policy if exists operacional_credencial_itens_select on public.operacional_credencial_itens;
drop policy if exists operacional_credencial_itens_insert on public.operacional_credencial_itens;
drop policy if exists operacional_credencial_itens_update on public.operacional_credencial_itens;
drop policy if exists operacional_credencial_itens_delete on public.operacional_credencial_itens;

create policy operacional_credenciais_acesso_select_ops
  on public.operacional_credenciais_acesso
  for select
  to authenticated
  using (public.is_yes_hotel_ops_reader());

create policy operacional_credencial_itens_select_ops
  on public.operacional_credencial_itens
  for select
  to authenticated
  using (public.is_yes_hotel_ops_reader());

revoke all on public.operacional_credenciais_acesso from anon;
revoke insert, update, delete on public.operacional_credenciais_acesso from authenticated;
grant select on public.operacional_credenciais_acesso to authenticated;

revoke all on public.operacional_credencial_itens from anon;
revoke insert, update, delete on public.operacional_credencial_itens from authenticated;
grant select on public.operacional_credencial_itens to authenticated;

-- -----------------------------------------------------------------------
-- 6) RPC dedicada de leitura para a tela do café
-- -----------------------------------------------------------------------
-- Substitui os dois SELECT diretos que a tela do café fazia em
-- operacional_reservas/operacional_hospedes (removidos acima). Único ponto
-- de leitura agregada, somente para o que ui/cafe-da-manha-mvp.js realmente
-- usa hoje (mapeado lendo o arquivo inteiro antes de escrever esta função):
--
--   - Colunas: as mesmas do select atual em loadCafeDataset() —
--     id, apartamento, hospede_principal, check_in_previsto,
--     check_out_previsto, status_reserva, external_reservation_id,
--     total_hospedes_hits, meal_plan_desc, pagamento_status e os quatro
--     campos de pagamento_presencial_diferido_* já lidos (autorizado,
--     efetivado, regularizado_em, bloqueado_em, deadline_em). Nenhuma
--     coluna de documento, contato, valor financeiro, comissionamento,
--     veículo ou autorização nominal (pagamento_presencial_diferido_
--     autorizado_por / _por_email não são lidas hoje pela tela — não
--     entram aqui).
--   - Filtro: exatamente o de loadCafeDataset() — status_reserva <>
--     'cancelada' e a janela check_in_previsto < p_data_cafe <=
--     check_out_previsto (estadias que cruzam a data do café). Nenhuma
--     regra HITS nova.
--   - Contagem de hóspedes: substitui countGuestsFallback() — passa a ser
--     calculada dentro da função (total_hospedes_hits quando > 0; senão
--     contagem de operacional_hospedes não removidas, com piso de 1,
--     idêntico ao `Number(r.__guest_count_fallback) || 1` do client).
--   - Parâmetro: só a data do café (p_data_cafe), o mesmo grão que
--     operacional_cafe_set_atendimento() já aceita — uma data por chamada,
--     nunca um intervalo nem "todo o histórico".
--   - operacional_cafe_atendimentos não entra aqui: já tem policy própria
--     (is_yes_hotel_cafe_reader(), fora do escopo deste achado) e continua
--     sendo lida separadamente pela UI, sem mudança.

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
begin
  -- SECURITY DEFINER só porque cafe não tem mais SELECT direto nas tabelas
  -- base; a própria função decide quem pode ler, consultando
  -- usuarios_internos por auth.uid() (nunca user_metadata/auth.jwt()).
  if not public.is_yes_hotel_cafe_reader() then
    raise exception 'cafe_read_forbidden_role' using errcode = '42501';
  end if;

  if p_data_cafe is null then
    raise exception 'cafe_read_missing_date' using errcode = '22023';
  end if;

  return query
    select
      r.id as reservation_id,
      r.apartamento as apartment_code,
      r.hospede_principal as main_guest_name,
      r.external_reservation_id,
      r.check_in_previsto,
      r.check_out_previsto,
      r.status_reserva,
      case
        when coalesce(r.total_hospedes_hits, 0) > 0 then r.total_hospedes_hits
        else greatest(
          1,
          (
            select count(*)::integer
            from public.operacional_hospedes h
            where h.reserva_id = r.id
              and coalesce(h.removed_from_reservation, false) = false
          )
        )
      end as total_guests,
      r.meal_plan_desc,
      r.pagamento_status,
      r.pagamento_presencial_diferido_autorizado,
      r.pagamento_presencial_diferido_efetivado,
      r.pagamento_presencial_diferido_regularizado_em,
      r.pagamento_presencial_diferido_bloqueado_em,
      r.pagamento_presencial_diferido_deadline_em
    from public.operacional_reservas r
    where r.status_reserva <> 'cancelada'
      and r.check_in_previsto < p_data_cafe
      and r.check_out_previsto >= p_data_cafe;
end;
$$;

comment on function public.operacional_cafe_listar_hospedagens(date) is
  'Única fonte de leitura da tela do café para operacional_reservas/'
  'operacional_hospedes. SECURITY DEFINER (cafe não tem SELECT direto nas '
  'tabelas base); search_path vazio, tudo schema-qualificado; autorização '
  'via is_yes_hotel_cafe_reader() (admin/recepcao/cafe ativos); devolve só '
  'as colunas e a janela de uma data que ui/cafe-da-manha-mvp.js consome — '
  'sem documento, contato, valores financeiros ou dados comerciais.';

-- Mesmo endurecimento de grants das outras funções auxiliares desta
-- migration: EXECUTE fora de PUBLIC/anon, só authenticated (a policy dentro
-- da função ainda decide por perfil — isto é só a primeira barreira).
revoke all on function public.operacional_cafe_listar_hospedagens(date) from public, anon;
grant execute on function public.operacional_cafe_listar_hospedagens(date) to authenticated;

-- -----------------------------------------------------------------------
-- Confirmação: RLS permanece habilitada (já estava, desde 0005/0006/0015).
-- -----------------------------------------------------------------------
alter table public.operacional_reservas enable row level security;
alter table public.operacional_hospedes enable row level security;
alter table public.operacional_reserva_eventos enable row level security;
alter table public.fnrh_hospedes enable row level security;
alter table public.operacional_credenciais_acesso enable row level security;
alter table public.operacional_credencial_itens enable row level security;
