-- Recovered from remote schema_migrations (minmmecajnmjqlgacfoz)
-- version=20260803205229 name=fix_credencial_validity_campo_grande
-- DO NOT re-apply; already applied remotely.

create or replace function public.operacional_criar_credencial_ao_liberar_acesso()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reserva_id uuid;
  v_apartamento_norm text;
  v_apartamento_id uuid;
  v_bloco_id uuid;
  v_valido_de timestamptz;
  v_valido_ate timestamptz;
  v_credencial_id uuid;
  v_fechadura record;
begin
  if not (old.acesso_liberado = false and new.acesso_liberado = true) then
    return new;
  end if;

  v_reserva_id := new.id;
  v_apartamento_norm := public.operacional_apartamento_normalizado(new.apartamento);

  if v_apartamento_norm is null then
    return new;
  end if;

  select id, bloco_id into v_apartamento_id, v_bloco_id
  from public.apartamentos
  where numero = v_apartamento_norm
  limit 1;

  if v_apartamento_id is null or v_bloco_id is null then
    return new;
  end if;

  v_valido_de := ((new.check_in_previsto::date + time '13:00') at time zone 'America/Campo_Grande');
  v_valido_ate := ((new.check_out_previsto::date + time '11:00') at time zone 'America/Campo_Grande');

  if v_valido_ate < v_valido_de then
    v_valido_ate := v_valido_de + interval '1 day';
  end if;

  if exists (
    select 1 from public.operacional_credenciais_acesso
    where reserva_id = v_reserva_id and tipo_credencial = 'principal'
  ) then
    return new;
  end if;

  insert into public.operacional_credenciais_acesso (
    reserva_id,
    tipo_credencial,
    status,
    valido_de,
    valido_ate,
    motivo_origem
  ) values (
    v_reserva_id,
    'principal',
    'pendente',
    v_valido_de,
    v_valido_ate,
    'checkin_normal'
  )
  returning id into v_credencial_id;

  for v_fechadura in
    select f.id, f.identificador_externo_ttlock, f.tipo_fechadura, f.portao_id
    from public.fechaduras f
    where f.ativo = true
      and (
        (f.apartamento_id = v_apartamento_id and f.tipo_fechadura = 'apartamento')
        or
        (f.portao_id in (select id from public.portoes where bloco_id = v_bloco_id)
         and f.tipo_fechadura in ('portao_externo', 'portao_interno'))
      )
  loop
    insert into public.operacional_credencial_itens (
      credencial_id,
      fechadura_id,
      lock_id_ttlock,
      tipo_destino,
      codigo_logico_destino,
      status_provisionamento
    ) values (
      v_credencial_id,
      v_fechadura.id,
      v_fechadura.identificador_externo_ttlock,
      v_fechadura.tipo_fechadura::public.operacional_tipo_destino,
      case v_fechadura.tipo_fechadura
        when 'apartamento' then 'APT-' || v_apartamento_norm
        when 'portao_externo' then 'GATE-' || (select identificador_operacional from public.portoes where id = v_fechadura.portao_id limit 1) || '-EXTERNAL'
        when 'portao_interno' then 'GATE-' || (select identificador_operacional from public.portoes where id = v_fechadura.portao_id limit 1) || '-INTERNAL'
        else 'UNKNOWN'
      end,
      'pendente'
    );
  end loop;

  return new;
end;
$$;