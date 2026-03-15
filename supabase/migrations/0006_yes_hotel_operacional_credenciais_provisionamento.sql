-- Fase TTLock 1: persistência e domínio de provisionamento de acesso.
-- Tabelas de credenciais operacionais e itens de provisionamento, vinculadas a operacional_reservas.
-- Trigger: ao liberar acesso (acesso_liberado = true), cria credencial principal e itens.

-- Tipos de status da credencial operacional
create type public.operacional_credencial_status as enum (
  'pendente',
  'pronta',
  'provisionando',
  'provisionada',
  'parcial',
  'falhou',
  'revogada'
);

-- Motivo de origem da credencial
create type public.operacional_credencial_motivo_origem as enum (
  'checkin_normal',
  'early_checkin',
  'late_checkout',
  'room_change',
  'manual_adjustment',
  'cancelamento'
);

-- Status do item de provisionamento
create type public.operacional_item_provisionamento_status as enum (
  'pendente',
  'provisionando',
  'provisionado',
  'falhou',
  'revogado'
);

-- Tipo de destino (espelho de fechaduras.tipo_fechadura para conveniência)
create type public.operacional_tipo_destino as enum (
  'apartamento',
  'portao_externo',
  'portao_interno'
);

-- Credenciais operacionais de acesso (uma por reserva operacional, tipo principal)
create table public.operacional_credenciais_acesso (
  id uuid primary key default gen_random_uuid(),
  reserva_id uuid not null references public.operacional_reservas (id) on delete cascade,
  tipo_credencial text not null default 'principal' check (tipo_credencial in ('principal')),
  status public.operacional_credencial_status not null default 'pendente',
  valido_de timestamptz not null,
  valido_ate timestamptz not null,
  motivo_origem public.operacional_credencial_motivo_origem not null default 'checkin_normal',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operacional_credenciais_validade_check check (valido_ate >= valido_de)
);

create unique index operacional_credenciais_acesso_reserva_principal_uidx
  on public.operacional_credenciais_acesso (reserva_id)
  where tipo_credencial = 'principal';

create index operacional_credenciais_acesso_reserva_id_idx
  on public.operacional_credenciais_acesso (reserva_id);

-- Itens de provisionamento (uma linha por fechadura a provisionar)
create table public.operacional_credencial_itens (
  id uuid primary key default gen_random_uuid(),
  credencial_id uuid not null references public.operacional_credenciais_acesso (id) on delete cascade,
  fechadura_id uuid not null references public.fechaduras (id),
  lock_id_ttlock text not null,
  tipo_destino public.operacional_tipo_destino not null,
  codigo_logico_destino text not null,
  status_provisionamento public.operacional_item_provisionamento_status not null default 'pendente',
  ultimo_erro text,
  provisionado_em timestamptz,
  revogado_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operacional_credencial_itens_credencial_fechadura_key unique (credencial_id, fechadura_id)
);

create index operacional_credencial_itens_credencial_id_idx
  on public.operacional_credencial_itens (credencial_id);

create index operacional_credencial_itens_fechadura_id_idx
  on public.operacional_credencial_itens (fechadura_id);

-- RLS
alter table public.operacional_credenciais_acesso enable row level security;
alter table public.operacional_credencial_itens enable row level security;

create policy operacional_credenciais_acesso_select
  on public.operacional_credenciais_acesso for select to authenticated using (true);
create policy operacional_credenciais_acesso_insert
  on public.operacional_credenciais_acesso for insert to authenticated with check (true);
create policy operacional_credenciais_acesso_update
  on public.operacional_credenciais_acesso for update to authenticated using (true);
create policy operacional_credenciais_acesso_delete
  on public.operacional_credenciais_acesso for delete to authenticated using (true);

create policy operacional_credencial_itens_select
  on public.operacional_credencial_itens for select to authenticated using (true);
create policy operacional_credencial_itens_insert
  on public.operacional_credencial_itens for insert to authenticated with check (true);
create policy operacional_credencial_itens_update
  on public.operacional_credencial_itens for update to authenticated using (true);
create policy operacional_credencial_itens_delete
  on public.operacional_credencial_itens for delete to authenticated using (true);

-- Trigger updated_at
create trigger operacional_credenciais_acesso_updated_at
  before update on public.operacional_credenciais_acesso
  for each row execute function public.set_updated_at();

create trigger operacional_credencial_itens_updated_at
  before update on public.operacional_credencial_itens
  for each row execute function public.set_updated_at();

-- Função auxiliar: normaliza número do apartamento (texto -> 01 a 40)
create or replace function public.operacional_apartamento_normalizado(apartamento text)
returns text
language plpgsql
immutable
as $$
declare
  num_str text;
  num_int int;
begin
  if apartamento is null or trim(apartamento) = '' then
    return null;
  end if;
  num_str := lpad(trim(regexp_replace(trim(apartamento), '[^0-9]', '', 'g')), 2, '0');
  num_int := nullif(num_str, '')::int;
  if num_int is null or num_int < 1 or num_int > 40 then
    return null;
  end if;
  return lpad(num_int::text, 2, '0');
end;
$$;

-- Função: cria credencial principal e itens quando acesso é liberado
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
  -- Só reage quando acesso_liberado passa a true
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

  -- Janela: check-in 13:00, check-out 11:00
  v_valido_de := (new.check_in_previsto::date + time '13:00')::timestamptz;
  v_valido_ate := (new.check_out_previsto::date + time '11:00')::timestamptz;

  if v_valido_ate < v_valido_de then
    v_valido_ate := v_valido_de + interval '1 day';
  end if;

  -- Evita duplicar credencial para a mesma reserva
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

  -- Itens: fechadura do apartamento + fechaduras dos portões do bloco
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

create trigger operacional_reservas_credencial_ao_liberar
  after update on public.operacional_reservas
  for each row
  execute function public.operacional_criar_credencial_ao_liberar_acesso();

-- Consulta para inspeção/debug após liberar acesso (substituir :reserva_id):
-- select c.id as credencial_id, c.reserva_id, c.status, c.valido_de, c.valido_ate, c.motivo_origem,
--        i.id as item_id, i.lock_id_ttlock, i.tipo_destino, i.codigo_logico_destino, i.status_provisionamento
-- from operacional_credenciais_acesso c
-- left join operacional_credencial_itens i on i.credencial_id = c.id
-- where c.reserva_id = :reserva_id
-- order by c.created_at desc, i.tipo_destino;
