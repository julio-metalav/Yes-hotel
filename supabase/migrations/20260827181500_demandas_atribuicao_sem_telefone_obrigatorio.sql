-- Demandas: atribuição por user_id sem exigir WhatsApp.
-- telefone_whatsapp permanece no cadastro do usuário interno (E.164 BR, opcional).
-- A RPC de atribuíveis não devolve telefone.
-- DigiSac (futuro) resolve o número atual por user_id; sem telefone = pendente_sem_telefone.
-- Remove o bloqueio de apagar WhatsApp com demanda aberta.

comment on column public.usuarios_internos.telefone_whatsapp is
  'WhatsApp/telefone operacional E.164 BR (+55…). Opcional. Demandas atribuem por user_id; DigiSac resolve o telefone atual no envio.';

drop trigger if exists usuarios_internos_proteger_telefone_demandas
  on public.usuarios_internos;
drop function if exists public.demandas_proteger_telefone_atribuido();

create or replace function public.demandas_assert_usuario_atribuivel(p_user_id uuid)
returns public.usuarios_internos
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user public.usuarios_internos%rowtype;
begin
  select * into v_user from public.usuarios_internos where id = p_user_id;
  if not found or v_user.ativo is not true then
    raise exception 'demandas_usuario_inativo';
  end if;
  if lower(v_user.perfil_usuario) not in ('admin', 'recepcao', 'cafe') then
    raise exception 'demandas_usuario_inativo';
  end if;
  return v_user;
end;
$$;

create or replace function public.demandas_listar_usuarios_atribuiveis()
returns table (
  id uuid,
  nome text,
  perfil_usuario text
)
language sql
stable
security definer
set search_path = public
as $$
  select u.id, u.nome, u.perfil_usuario
  from public.usuarios_internos u
  where public.is_yes_hotel_demandas_reader()
    and u.ativo = true
    and lower(u.perfil_usuario) in ('admin', 'recepcao', 'cafe')
  order by u.nome;
$$;

-- Status de notificação DigiSac. Nunca devolve o número.
create or replace function public.demandas_digisac_notificacao_status(p_user_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tel text;
begin
  select u.telefone_whatsapp
    into v_tel
  from public.usuarios_internos u
  where u.id = p_user_id;

  if not found or v_tel is null or btrim(v_tel) = '' then
    return 'pendente_sem_telefone';
  end if;
  return 'disponivel';
end;
$$;

revoke all on function public.demandas_assert_usuario_atribuivel(uuid) from public, anon, authenticated;
revoke all on function public.demandas_listar_usuarios_atribuiveis() from public, anon;
grant execute on function public.demandas_listar_usuarios_atribuiveis() to authenticated;
revoke all on function public.demandas_digisac_notificacao_status(uuid) from public, anon, authenticated;
