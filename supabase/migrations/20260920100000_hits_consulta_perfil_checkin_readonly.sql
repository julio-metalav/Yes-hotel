-- Perfil hits_consulta — acesso somente-leitura ao Check-in Operacional.
--
-- Nasce sem nenhuma permissão geral: nenhum GRANT direto em
-- operacional_reservas/operacional_hospedes/etc. A única leitura permitida é
-- via a RPC dedicada operacional_hits_checkin_consulta(), que devolve apenas
-- os campos operacionais mínimos já usados pela tela de Check-in — sem
-- documento, contato, dados financeiros, veículo, comissionamento ou
-- credenciais/códigos de acesso.
--
-- Idempotente: pode ser reaplicada sem efeito colateral (create or replace /
-- drop-then-add constraint).

-- -----------------------------------------------------------------------
-- 1) Perfil válido
-- -----------------------------------------------------------------------
alter table public.usuarios_internos
  drop constraint if exists usuarios_internos_perfil_usuario_check;

alter table public.usuarios_internos
  add constraint usuarios_internos_perfil_usuario_check
    check (perfil_usuario in ('admin', 'recepcao', 'cafe', 'hits_consulta'));

-- -----------------------------------------------------------------------
-- 2) Gate de autorização (mesmo desenho de is_yes_hotel_ops_reader /
--    is_yes_hotel_cafe_reader da migration 20260919120000): SECURITY
--    DEFINER, search_path fixo, resolve o perfil via usuarios_internos por
--    auth.uid(), nunca via user_metadata/auth.jwt().
-- -----------------------------------------------------------------------
create or replace function public.is_yes_hotel_hits_consulta_reader()
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
      and lower(u.perfil_usuario) = 'hits_consulta'
  );
$$;

comment on function public.is_yes_hotel_hits_consulta_reader() is
  'True se o JWT atual pertence a usuario interno ativo com perfil hits_consulta. '
  'Usada exclusivamente como gate da RPC operacional_hits_checkin_consulta().';

revoke all on function public.is_yes_hotel_hits_consulta_reader() from public, anon;
grant execute on function public.is_yes_hotel_hits_consulta_reader() to authenticated;

-- -----------------------------------------------------------------------
-- 3) RPC dedicada de leitura para o Check-in Operacional (perfil HITS)
-- -----------------------------------------------------------------------
-- Colunas: apartamento, nome do hóspede principal, período da hospedagem,
-- status da reserva, fluxo FNRH agregado e os dois booleans que indicam a
-- próxima etapa operacional (acesso liberado / já entrou no apartamento).
-- Nada de documento, telefone, e-mail, veículo, valores financeiros,
-- comissionamento, credenciais ou payload técnico da HITS.
create or replace function public.operacional_hits_checkin_consulta()
returns table (
  reservation_id uuid,
  apartment_code text,
  main_guest_name text,
  check_in_previsto date,
  check_out_previsto date,
  status_reserva text,
  fnrh_status_agregado text,
  acesso_liberado boolean,
  entrou_no_apto boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- SECURITY DEFINER só porque hits_consulta não tem SELECT direto na
  -- tabela-base; a própria função decide quem pode ler, consultando
  -- usuarios_internos por auth.uid() (nunca user_metadata/auth.jwt()).
  if not public.is_yes_hotel_hits_consulta_reader() then
    raise exception 'hits_consulta_read_forbidden_role' using errcode = '42501';
  end if;

  return query
    select
      r.id as reservation_id,
      r.apartamento as apartment_code,
      r.hospede_principal as main_guest_name,
      r.check_in_previsto,
      r.check_out_previsto,
      r.status_reserva,
      r.fnrh_status_agregado,
      r.acesso_liberado,
      r.entrou_no_apto
    from public.operacional_reservas r
    where r.status_reserva <> 'cancelada'
    order by r.check_in_previsto desc;
end;
$$;

comment on function public.operacional_hits_checkin_consulta() is
  'Única fonte de leitura do perfil hits_consulta para o Check-in Operacional. '
  'SECURITY DEFINER (hits_consulta não tem SELECT direto em operacional_reservas); '
  'search_path vazio, tudo schema-qualificado; autorização via '
  'is_yes_hotel_hits_consulta_reader(); devolve só os 9 campos operacionais '
  'mínimos — sem documento, contato, financeiro, veículo ou credenciais.';

-- Mesmo endurecimento de grants das demais RPCs de leitura por perfil desta
-- base de código: EXECUTE fora de PUBLIC/anon, só authenticated (a policy
-- dentro da função ainda decide por perfil — isto é só a primeira barreira).
-- Nenhuma permissão de escrita é concedida em lugar nenhum desta migration.
revoke all on function public.operacional_hits_checkin_consulta() from public, anon;
grant execute on function public.operacional_hits_checkin_consulta() to authenticated;
