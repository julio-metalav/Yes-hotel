-- Fundação Demandas — Manutenção Predial (ciclo manual).
-- NÃO aplicar nesta etapa. Sem geração automática, cron, DigiSac ou Meta Lav.

-- ---------------------------------------------------------------------------
-- 1) usuarios_internos.telefone_whatsapp (nullable)
-- ---------------------------------------------------------------------------
alter table public.usuarios_internos
  add column if not exists telefone_whatsapp text;

alter table public.usuarios_internos
  drop constraint if exists usuarios_internos_telefone_whatsapp_format_check;

alter table public.usuarios_internos
  add constraint usuarios_internos_telefone_whatsapp_format_check
  check (
    telefone_whatsapp is null
    or telefone_whatsapp ~ '^\+55[0-9]{10,11}$'
  );

comment on column public.usuarios_internos.telefone_whatsapp is
  'WhatsApp/telefone operacional E.164 BR (+55…). Nullable para usuários existentes.';

create or replace function public.demandas_normalize_telefone_whatsapp(p_value text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_digits text;
  v_local text;
begin
  if p_value is null or btrim(p_value) = '' then
    return null;
  end if;

  v_digits := regexp_replace(p_value, '\D', '', 'g');
  if left(v_digits, 2) = '00' then
    v_digits := substr(v_digits, 3);
  end if;

  if length(v_digits) in (10, 11) then
    v_digits := '55' || v_digits;
  end if;

  if length(v_digits) not in (12, 13) or left(v_digits, 2) <> '55' then
    raise exception 'demandas_telefone_invalido';
  end if;

  v_local := substr(v_digits, 3);
  if length(v_local) = 11 and substr(v_local, 3, 1) <> '9' then
    raise exception 'demandas_telefone_invalido';
  end if;

  return '+' || v_digits;
end;
$$;

create or replace function public.demandas_today_campo_grande()
returns date
language sql
stable
set search_path = public
as $$
  select (timezone('America/Campo_Grande', now()))::date;
$$;

create or replace function public.demandas_haversine_meters(
  p_lat1 double precision,
  p_lon1 double precision,
  p_lat2 double precision,
  p_lon2 double precision
)
returns double precision
language plpgsql
immutable
set search_path = public
as $$
declare
  v_dlat double precision;
  v_dlon double precision;
  v_a double precision;
begin
  if p_lat1 is null or p_lon1 is null or p_lat2 is null or p_lon2 is null then
    raise exception 'demandas_coordenada_invalida';
  end if;
  if p_lat1 < -90 or p_lat1 > 90 or p_lat2 < -90 or p_lat2 > 90 then
    raise exception 'demandas_latitude_invalida';
  end if;
  if p_lon1 < -180 or p_lon1 > 180 or p_lon2 < -180 or p_lon2 > 180 then
    raise exception 'demandas_longitude_invalida';
  end if;

  v_dlat := radians(p_lat2 - p_lat1);
  v_dlon := radians(p_lon2 - p_lon1);
  v_a := sin(v_dlat / 2) ^ 2
    + cos(radians(p_lat1)) * cos(radians(p_lat2)) * sin(v_dlon / 2) ^ 2;
  return 2 * 6371000 * asin(least(1::double precision, sqrt(v_a)));
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) hotel_geo_config (singleton)
-- ---------------------------------------------------------------------------
create table if not exists public.hotel_geo_config (
  id boolean primary key default true check (id),
  latitude double precision not null,
  longitude double precision not null,
  raio_metros numeric not null default 200,
  updated_by uuid references public.usuarios_internos (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hotel_geo_config_latitude_check check (latitude >= -90 and latitude <= 90),
  constraint hotel_geo_config_longitude_check check (longitude >= -180 and longitude <= 180),
  constraint hotel_geo_config_raio_check check (raio_metros > 0)
);

drop trigger if exists hotel_geo_config_updated_at on public.hotel_geo_config;
create trigger hotel_geo_config_updated_at
  before update on public.hotel_geo_config
  for each row execute function public.set_updated_at();

create table if not exists public.hotel_geo_config_historico (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references public.usuarios_internos (id) on delete restrict,
  estado_anterior jsonb,
  estado_novo jsonb not null,
  origem text not null default 'rpc',
  criado_em timestamptz not null default now()
);

create or replace function public.hotel_geo_config_historico_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'hotel_geo_config_historico é append-only: UPDATE/DELETE proibidos';
end;
$$;

drop trigger if exists hotel_geo_config_historico_no_update_trg on public.hotel_geo_config_historico;
create trigger hotel_geo_config_historico_no_update_trg
  before update on public.hotel_geo_config_historico
  for each row execute function public.hotel_geo_config_historico_append_only();

drop trigger if exists hotel_geo_config_historico_no_delete_trg on public.hotel_geo_config_historico;
create trigger hotel_geo_config_historico_no_delete_trg
  before delete on public.hotel_geo_config_historico
  for each row execute function public.hotel_geo_config_historico_append_only();

-- ---------------------------------------------------------------------------
-- 3) Catálogo programado (fundação, sem geração)
-- ---------------------------------------------------------------------------
create table if not exists public.demandas_modelos_programados (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  descricao text not null default '',
  periodicidade_unidade text not null
    check (periodicidade_unidade in ('dias', 'semanas', 'meses', 'anos')),
  periodicidade_intervalo integer not null check (periodicidade_intervalo > 0),
  primeira_data date not null,
  prazo_conclusao_dias integer not null check (prazo_conclusao_dias > 0),
  prioridade text not null check (prioridade in ('baixa', 'media', 'alta')),
  supervisor_id uuid references public.usuarios_internos (id) on delete restrict,
  executor_id uuid references public.usuarios_internos (id) on delete restrict,
  exigir_foto boolean not null default false,
  ativo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.usuarios_internos (id) on delete restrict,
  constraint demandas_modelos_programados_nome_key unique (nome),
  constraint demandas_modelos_programados_ativo_atribuicao_check check (
    not ativo
    or (
      supervisor_id is not null
      and executor_id is not null
      and supervisor_id <> executor_id
    )
  )
);

drop trigger if exists demandas_modelos_programados_updated_at on public.demandas_modelos_programados;
create trigger demandas_modelos_programados_updated_at
  before update on public.demandas_modelos_programados
  for each row execute function public.set_updated_at();

create table if not exists public.demandas_ocorrencias_programadas (
  id uuid primary key default gen_random_uuid(),
  modelo_id uuid not null
    references public.demandas_modelos_programados (id) on delete restrict,
  data_programada_inicio date not null,
  demanda_id uuid,
  created_at timestamptz not null default now(),
  constraint demandas_ocorrencias_programadas_modelo_data_key
    unique (modelo_id, data_programada_inicio)
);

-- ---------------------------------------------------------------------------
-- 4) demandas + satélites
-- ---------------------------------------------------------------------------
create table if not exists public.demandas (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  descricao text not null,
  tipo text not null check (tipo in ('corretiva', 'programada')),
  prioridade text not null check (prioridade in ('baixa', 'media', 'alta')),
  data_programada_inicio date not null,
  data_prevista_conclusao date not null,
  criador_id uuid not null references public.usuarios_internos (id) on delete restrict,
  supervisor_id uuid not null references public.usuarios_internos (id) on delete restrict,
  executor_id uuid not null references public.usuarios_internos (id) on delete restrict,
  exigir_foto boolean not null default false,
  sem_local_especifico boolean not null default false,
  status text not null check (status in (
    'agendada',
    'nao_iniciada',
    'em_andamento',
    'pausada',
    'aguardando_validacao',
    'em_correcao',
    'concluida',
    'cancelada'
  )),
  modelo_programado_id uuid references public.demandas_modelos_programados (id) on delete restrict,
  ocorrencia_programada_data date,
  row_version integer not null default 1 check (row_version >= 1),
  iniciada_em timestamptz,
  validacao_enviada_em timestamptz,
  concluida_em timestamptz,
  cancelada_em timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint demandas_titulo_check check (btrim(titulo) <> ''),
  constraint demandas_descricao_check check (btrim(descricao) <> ''),
  constraint demandas_datas_check check (data_prevista_conclusao >= data_programada_inicio),
  constraint demandas_supervisor_executor_diff_check check (supervisor_id <> executor_id)
);

drop trigger if exists demandas_updated_at on public.demandas;
create trigger demandas_updated_at
  before update on public.demandas
  for each row execute function public.set_updated_at();

create or replace function public.demandas_forbid_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'demandas_delete_proibido';
end;
$$;

drop trigger if exists demandas_no_delete_trg on public.demandas;
create trigger demandas_no_delete_trg
  before delete on public.demandas
  for each row execute function public.demandas_forbid_delete();

create index if not exists demandas_status_idx on public.demandas (status);
create index if not exists demandas_criador_idx on public.demandas (criador_id);
create index if not exists demandas_supervisor_idx on public.demandas (supervisor_id);
create index if not exists demandas_executor_idx on public.demandas (executor_id);
create index if not exists demandas_prevista_idx on public.demandas (data_prevista_conclusao);

alter table public.demandas_ocorrencias_programadas
  drop constraint if exists demandas_ocorrencias_programadas_demanda_fkey;
alter table public.demandas_ocorrencias_programadas
  add constraint demandas_ocorrencias_programadas_demanda_fkey
  foreign key (demanda_id) references public.demandas (id) on delete restrict;

create table if not exists public.demandas_pausas (
  id uuid primary key default gen_random_uuid(),
  demanda_id uuid not null references public.demandas (id) on delete restrict,
  usuario_id uuid not null references public.usuarios_internos (id) on delete restrict,
  inicio timestamptz not null default now(),
  fim timestamptz,
  motivo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint demandas_pausas_intervalo_check check (fim is null or fim >= inicio)
);

drop trigger if exists demandas_pausas_updated_at on public.demandas_pausas;
create trigger demandas_pausas_updated_at
  before update on public.demandas_pausas
  for each row execute function public.set_updated_at();

create unique index if not exists demandas_pausas_aberta_uidx
  on public.demandas_pausas (demanda_id)
  where fim is null;

create table if not exists public.demandas_historico (
  id uuid primary key default gen_random_uuid(),
  demanda_id uuid not null references public.demandas (id) on delete restrict,
  usuario_id uuid not null references public.usuarios_internos (id) on delete restrict,
  acao text not null,
  estado_anterior jsonb,
  estado_novo jsonb,
  justificativa text,
  origem text not null default 'rpc',
  criado_em timestamptz not null default now()
);

create index if not exists demandas_historico_demanda_idx
  on public.demandas_historico (demanda_id, criado_em desc);

create or replace function public.demandas_historico_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'demandas_historico é append-only: UPDATE/DELETE proibidos';
end;
$$;

drop trigger if exists demandas_historico_no_update_trg on public.demandas_historico;
create trigger demandas_historico_no_update_trg
  before update on public.demandas_historico
  for each row execute function public.demandas_historico_append_only();

drop trigger if exists demandas_historico_no_delete_trg on public.demandas_historico;
create trigger demandas_historico_no_delete_trg
  before delete on public.demandas_historico
  for each row execute function public.demandas_historico_append_only();

create table if not exists public.demandas_anexos (
  id uuid primary key default gen_random_uuid(),
  demanda_id uuid not null references public.demandas (id) on delete restrict,
  storage_path text not null,
  etapa text not null check (etapa in ('antes', 'durante', 'finalizacao', 'correcao')),
  usuario_id uuid not null references public.usuarios_internos (id) on delete restrict,
  mime text not null,
  tamanho_bytes integer not null check (tamanho_bytes > 0 and tamanho_bytes <= 2097152),
  created_at timestamptz not null default now(),
  constraint demandas_anexos_storage_path_key unique (storage_path),
  constraint demandas_anexos_mime_check check (
    mime in ('image/jpeg', 'image/jpg', 'image/png', 'image/webp')
  )
);

create index if not exists demandas_anexos_demanda_idx
  on public.demandas_anexos (demanda_id, created_at desc);

create or replace function public.demandas_anexos_forbid_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'demandas_anexos_delete_proibido';
end;
$$;

drop trigger if exists demandas_anexos_no_delete_trg on public.demandas_anexos;
create trigger demandas_anexos_no_delete_trg
  before delete on public.demandas_anexos
  for each row execute function public.demandas_anexos_forbid_delete();

create table if not exists public.demandas_geo_checks (
  id uuid primary key default gen_random_uuid(),
  demanda_id uuid not null references public.demandas (id) on delete restrict,
  usuario_id uuid not null references public.usuarios_internos (id) on delete restrict,
  etapa text not null check (etapa in ('inicio', 'envio_validacao')),
  latitude double precision,
  longitude double precision,
  precisao_metros double precision,
  distancia_metros double precision,
  raio_permitido_metros numeric,
  resultado text not null check (resultado in (
    'dispensada', 'aprovada', 'recusada', 'nao_configurada', 'coordenada_invalida'
  )),
  criado_em timestamptz not null default now()
);

create index if not exists demandas_geo_checks_demanda_idx
  on public.demandas_geo_checks (demanda_id, criado_em desc);

create or replace function public.demandas_geo_checks_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'demandas_geo_checks é append-only: UPDATE/DELETE proibidos';
end;
$$;

drop trigger if exists demandas_geo_checks_no_update_trg on public.demandas_geo_checks;
create trigger demandas_geo_checks_no_update_trg
  before update on public.demandas_geo_checks
  for each row execute function public.demandas_geo_checks_append_only();

drop trigger if exists demandas_geo_checks_no_delete_trg on public.demandas_geo_checks;
create trigger demandas_geo_checks_no_delete_trg
  before delete on public.demandas_geo_checks
  for each row execute function public.demandas_geo_checks_append_only();

-- ---------------------------------------------------------------------------
-- 5) Helpers de autorização / auditoria
-- ---------------------------------------------------------------------------
create or replace function public.is_yes_hotel_demandas_reader()
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

create or replace function public.demandas_require_actor()
returns public.usuarios_internos
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user public.usuarios_internos%rowtype;
begin
  if auth.uid() is null then
    raise exception 'demandas_unauthenticated' using errcode = '42501';
  end if;

  select * into v_user
  from public.usuarios_internos u
  where u.auth_user_id = auth.uid();

  if not found or v_user.ativo is not true then
    raise exception 'demandas_usuario_inativo';
  end if;

  if lower(v_user.perfil_usuario) not in ('admin', 'recepcao', 'cafe') then
    raise exception 'demandas_forbidden';
  end if;

  return v_user;
end;
$$;

create or replace function public.demandas_lock(p_id uuid, p_row_version integer)
returns public.demandas
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.demandas%rowtype;
begin
  select * into v_row
  from public.demandas
  where id = p_id
  for update;

  if not found then
    raise exception 'demandas_nao_encontrada';
  end if;

  if v_row.row_version is distinct from p_row_version then
    raise exception 'demandas_concurrency';
  end if;

  return v_row;
end;
$$;

create or replace function public.demandas_append_historico(
  p_demanda_id uuid,
  p_usuario_id uuid,
  p_acao text,
  p_estado_anterior jsonb,
  p_estado_novo jsonb,
  p_justificativa text,
  p_origem text default 'rpc'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.demandas_historico (
    demanda_id, usuario_id, acao, estado_anterior, estado_novo, justificativa, origem
  ) values (
    p_demanda_id, p_usuario_id, p_acao, p_estado_anterior, p_estado_novo, p_justificativa,
    coalesce(nullif(btrim(p_origem), ''), 'rpc')
  );
exception
  when others then
    raise exception 'demandas_auditoria_falhou: %', sqlerrm;
end;
$$;

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
  if v_user.telefone_whatsapp is null or btrim(v_user.telefone_whatsapp) = '' then
    raise exception 'demandas_telefone_obrigatorio';
  end if;
  return v_user;
end;
$$;

create or replace function public.demandas_is_admin(p_user public.usuarios_internos)
returns boolean
language sql
immutable
as $$
  select lower(p_user.perfil_usuario) = 'admin' and p_user.ativo;
$$;

create or replace function public.demandas_close_open_pause(p_demanda_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.demandas_pausas
  set fim = now()
  where demanda_id = p_demanda_id
    and fim is null;
end;
$$;

create or replace function public.demandas_enforce_geo(
  p_demanda public.demandas,
  p_actor public.usuarios_internos,
  p_etapa text,
  p_latitude double precision,
  p_longitude double precision,
  p_precisao_metros double precision
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg public.hotel_geo_config%rowtype;
  v_dist double precision;
  v_result text;
begin
  if p_demanda.sem_local_especifico then
    insert into public.demandas_geo_checks (
      demanda_id, usuario_id, etapa, latitude, longitude, precisao_metros,
      distancia_metros, raio_permitido_metros, resultado
    ) values (
      p_demanda.id, p_actor.id, p_etapa, p_latitude, p_longitude, p_precisao_metros,
      null, null, 'dispensada'
    );
    return;
  end if;

  select * into v_cfg from public.hotel_geo_config where id = true;
  if not found then
    insert into public.demandas_geo_checks (
      demanda_id, usuario_id, etapa, latitude, longitude, precisao_metros,
      distancia_metros, raio_permitido_metros, resultado
    ) values (
      p_demanda.id, p_actor.id, p_etapa, p_latitude, p_longitude, p_precisao_metros,
      null, null, 'nao_configurada'
    );
    raise exception 'demandas_geo_nao_configurada';
  end if;

  if p_latitude is null or p_longitude is null
     or p_latitude < -90 or p_latitude > 90
     or p_longitude < -180 or p_longitude > 180 then
    insert into public.demandas_geo_checks (
      demanda_id, usuario_id, etapa, latitude, longitude, precisao_metros,
      distancia_metros, raio_permitido_metros, resultado
    ) values (
      p_demanda.id, p_actor.id, p_etapa, p_latitude, p_longitude, p_precisao_metros,
      null, v_cfg.raio_metros, 'coordenada_invalida'
    );
    raise exception 'demandas_coordenada_invalida';
  end if;

  v_dist := public.demandas_haversine_meters(
    p_latitude, p_longitude, v_cfg.latitude, v_cfg.longitude
  );

  if v_dist <= v_cfg.raio_metros then
    v_result := 'aprovada';
  else
    v_result := 'recusada';
  end if;

  insert into public.demandas_geo_checks (
    demanda_id, usuario_id, etapa, latitude, longitude, precisao_metros,
    distancia_metros, raio_permitido_metros, resultado
  ) values (
    p_demanda.id, p_actor.id, p_etapa, p_latitude, p_longitude, p_precisao_metros,
    v_dist, v_cfg.raio_metros, v_result
  );

  if v_result <> 'aprovada' then
    raise exception 'demandas_geo_recusada';
  end if;
end;
$$;

create or replace function public.demandas_assert_foto_envio(p_demanda public.demandas)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_since timestamptz;
  v_count integer;
begin
  if not p_demanda.exigir_foto then
    return;
  end if;

  select max(criado_em) into v_since
  from public.demandas_historico
  where demanda_id = p_demanda.id
    and acao in ('rejeitar', 'reabrir');

  select count(*) into v_count
  from public.demandas_anexos a
  where a.demanda_id = p_demanda.id
    and (v_since is null or a.created_at > v_since);

  if coalesce(v_count, 0) < 1 then
    raise exception 'demandas_foto_obrigatoria';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) RPCs atômicas (sem RPC genérica de status)
-- ---------------------------------------------------------------------------
create or replace function public.demandas_liberar_agendadas()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.usuarios_internos%rowtype;
  v_row public.demandas%rowtype;
  v_count integer := 0;
  v_today date := public.demandas_today_campo_grande();
begin
  v_actor := public.demandas_require_actor();

  for v_row in
    select * from public.demandas
    where status = 'agendada'
      and data_programada_inicio <= v_today
    for update
  loop
    update public.demandas
    set status = 'nao_iniciada',
        row_version = v_row.row_version + 1
    where id = v_row.id;
    perform public.demandas_append_historico(
      v_row.id, v_actor.id, 'liberar_agendada',
      jsonb_build_object('status', v_row.status),
      jsonb_build_object('status', 'nao_iniciada'),
      null, 'rpc'
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

create or replace function public.demandas_criar(
  p_titulo text,
  p_descricao text,
  p_tipo text,
  p_prioridade text,
  p_data_programada_inicio date,
  p_data_prevista_conclusao date,
  p_supervisor_id uuid,
  p_executor_id uuid,
  p_exigir_foto boolean default false,
  p_sem_local_especifico boolean default false
)
returns public.demandas
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.usuarios_internos%rowtype;
  v_sup public.usuarios_internos%rowtype;
  v_exe public.usuarios_internos%rowtype;
  v_status text;
  v_row public.demandas%rowtype;
  v_today date := public.demandas_today_campo_grande();
begin
  v_actor := public.demandas_require_actor();
  if btrim(coalesce(p_titulo, '')) = '' or btrim(coalesce(p_descricao, '')) = '' then
    raise exception 'demandas_titulo_descricao_obrigatorios';
  end if;
  if p_data_programada_inicio is null or p_data_prevista_conclusao is null then
    raise exception 'demandas_datas_obrigatorias';
  end if;
  if p_data_prevista_conclusao < p_data_programada_inicio then
    raise exception 'demandas_conclusao_antes_inicio';
  end if;
  if p_tipo not in ('corretiva', 'programada') then
    raise exception 'demandas_tipo_invalido';
  end if;
  if p_prioridade not in ('baixa', 'media', 'alta') then
    raise exception 'demandas_prioridade_invalida';
  end if;
  if p_supervisor_id = p_executor_id then
    raise exception 'demandas_supervisor_igual_executor';
  end if;

  v_sup := public.demandas_assert_usuario_atribuivel(p_supervisor_id);
  v_exe := public.demandas_assert_usuario_atribuivel(p_executor_id);

  if p_data_programada_inicio > v_today then
    v_status := 'agendada';
  else
    v_status := 'nao_iniciada';
  end if;

  insert into public.demandas (
    titulo, descricao, tipo, prioridade,
    data_programada_inicio, data_prevista_conclusao,
    criador_id, supervisor_id, executor_id,
    exigir_foto, sem_local_especifico, status
  ) values (
    btrim(p_titulo), btrim(p_descricao), p_tipo, p_prioridade,
    p_data_programada_inicio, p_data_prevista_conclusao,
    v_actor.id, v_sup.id, v_exe.id,
    coalesce(p_exigir_foto, false), coalesce(p_sem_local_especifico, false), v_status
  )
  returning * into v_row;

  perform public.demandas_append_historico(
    v_row.id, v_actor.id, 'criar', null,
    jsonb_build_object('status', v_row.status, 'id', v_row.id),
    null, 'rpc'
  );

  return v_row;
end;
$$;

create or replace function public.demandas_editar(
  p_demanda_id uuid,
  p_row_version integer,
  p_titulo text,
  p_descricao text,
  p_tipo text,
  p_prioridade text,
  p_data_programada_inicio date,
  p_data_prevista_conclusao date,
  p_supervisor_id uuid,
  p_executor_id uuid,
  p_exigir_foto boolean,
  p_sem_local_especifico boolean
)
returns public.demandas
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.usuarios_internos%rowtype;
  v_row public.demandas%rowtype;
  v_sup public.usuarios_internos%rowtype;
  v_exe public.usuarios_internos%rowtype;
  v_prev jsonb;
begin
  v_actor := public.demandas_require_actor();
  v_row := public.demandas_lock(p_demanda_id, p_row_version);

  if v_row.criador_id <> v_actor.id and not public.demandas_is_admin(v_actor) then
    raise exception 'demandas_forbidden';
  end if;
  if v_row.status in ('concluida', 'cancelada') then
    raise exception 'demandas_transicao_invalida';
  end if;
  if btrim(coalesce(p_titulo, '')) = '' or btrim(coalesce(p_descricao, '')) = '' then
    raise exception 'demandas_titulo_descricao_obrigatorios';
  end if;
  if p_data_prevista_conclusao < p_data_programada_inicio then
    raise exception 'demandas_conclusao_antes_inicio';
  end if;
  if p_supervisor_id = p_executor_id then
    raise exception 'demandas_supervisor_igual_executor';
  end if;

  v_sup := public.demandas_assert_usuario_atribuivel(p_supervisor_id);
  v_exe := public.demandas_assert_usuario_atribuivel(p_executor_id);
  v_prev := to_jsonb(v_row);

  update public.demandas
  set titulo = btrim(p_titulo),
      descricao = btrim(p_descricao),
      tipo = p_tipo,
      prioridade = p_prioridade,
      data_programada_inicio = p_data_programada_inicio,
      data_prevista_conclusao = p_data_prevista_conclusao,
      supervisor_id = v_sup.id,
      executor_id = v_exe.id,
      exigir_foto = coalesce(p_exigir_foto, false),
      sem_local_especifico = coalesce(p_sem_local_especifico, false),
      row_version = v_row.row_version + 1
  where id = v_row.id
  returning * into v_row;

  perform public.demandas_append_historico(
    v_row.id, v_actor.id, 'editar', v_prev, to_jsonb(v_row), null, 'rpc'
  );
  return v_row;
end;
$$;

create or replace function public.demandas_iniciar(
  p_demanda_id uuid,
  p_row_version integer,
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_precisao_metros double precision default null
)
returns public.demandas
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.usuarios_internos%rowtype;
  v_row public.demandas%rowtype;
  v_today date := public.demandas_today_campo_grande();
  v_prev text;
begin
  v_actor := public.demandas_require_actor();
  v_row := public.demandas_lock(p_demanda_id, p_row_version);

  if v_row.executor_id <> v_actor.id and not public.demandas_is_admin(v_actor) then
    raise exception 'demandas_forbidden';
  end if;

  if v_row.status = 'agendada' then
    if v_row.data_programada_inicio > v_today then
      raise exception 'demandas_ainda_agendada';
    end if;
    v_prev := v_row.status;
    update public.demandas
    set status = 'nao_iniciada',
        row_version = v_row.row_version + 1
    where id = v_row.id
    returning * into v_row;
    perform public.demandas_append_historico(
      v_row.id, v_actor.id, 'liberar_agendada',
      jsonb_build_object('status', v_prev),
      jsonb_build_object('status', 'nao_iniciada'),
      null, 'rpc'
    );
  end if;

  if v_row.status not in ('nao_iniciada', 'em_correcao') then
    raise exception 'demandas_transicao_invalida';
  end if;

  perform public.demandas_enforce_geo(
    v_row, v_actor, 'inicio', p_latitude, p_longitude, p_precisao_metros
  );

  v_prev := v_row.status;
  update public.demandas
  set status = 'em_andamento',
      iniciada_em = coalesce(iniciada_em, now()),
      row_version = v_row.row_version + 1
  where id = v_row.id
  returning * into v_row;

  perform public.demandas_append_historico(
    v_row.id, v_actor.id, 'iniciar',
    jsonb_build_object('status', v_prev),
    jsonb_build_object('status', v_row.status),
    null, 'rpc'
  );
  return v_row;
end;
$$;

create or replace function public.demandas_pausar(
  p_demanda_id uuid,
  p_row_version integer,
  p_motivo text default null
)
returns public.demandas
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.usuarios_internos%rowtype;
  v_row public.demandas%rowtype;
  v_prev text;
begin
  v_actor := public.demandas_require_actor();
  v_row := public.demandas_lock(p_demanda_id, p_row_version);

  if v_row.executor_id <> v_actor.id and not public.demandas_is_admin(v_actor) then
    raise exception 'demandas_forbidden';
  end if;
  if v_row.status <> 'em_andamento' then
    raise exception 'demandas_transicao_invalida';
  end if;
  if exists (select 1 from public.demandas_pausas where demanda_id = v_row.id and fim is null) then
    raise exception 'demandas_pausa_aberta';
  end if;

  insert into public.demandas_pausas (demanda_id, usuario_id, motivo)
  values (v_row.id, v_actor.id, nullif(btrim(p_motivo), ''));

  v_prev := v_row.status;
  update public.demandas
  set status = 'pausada',
      row_version = v_row.row_version + 1
  where id = v_row.id
  returning * into v_row;

  perform public.demandas_append_historico(
    v_row.id, v_actor.id, 'pausar',
    jsonb_build_object('status', v_prev),
    jsonb_build_object('status', v_row.status),
    nullif(btrim(p_motivo), ''), 'rpc'
  );
  return v_row;
end;
$$;

create or replace function public.demandas_retomar(
  p_demanda_id uuid,
  p_row_version integer
)
returns public.demandas
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.usuarios_internos%rowtype;
  v_row public.demandas%rowtype;
  v_prev text;
begin
  v_actor := public.demandas_require_actor();
  v_row := public.demandas_lock(p_demanda_id, p_row_version);

  if v_row.executor_id <> v_actor.id and not public.demandas_is_admin(v_actor) then
    raise exception 'demandas_forbidden';
  end if;
  if v_row.status <> 'pausada' then
    raise exception 'demandas_transicao_invalida';
  end if;

  perform public.demandas_close_open_pause(v_row.id);

  v_prev := v_row.status;
  update public.demandas
  set status = 'em_andamento',
      row_version = v_row.row_version + 1
  where id = v_row.id
  returning * into v_row;

  perform public.demandas_append_historico(
    v_row.id, v_actor.id, 'retomar',
    jsonb_build_object('status', v_prev),
    jsonb_build_object('status', v_row.status),
    null, 'rpc'
  );
  return v_row;
end;
$$;

create or replace function public.demandas_enviar_validacao(
  p_demanda_id uuid,
  p_row_version integer,
  p_latitude double precision default null,
  p_longitude double precision default null,
  p_precisao_metros double precision default null
)
returns public.demandas
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.usuarios_internos%rowtype;
  v_row public.demandas%rowtype;
  v_prev text;
begin
  v_actor := public.demandas_require_actor();
  v_row := public.demandas_lock(p_demanda_id, p_row_version);

  if v_row.executor_id <> v_actor.id and not public.demandas_is_admin(v_actor) then
    raise exception 'demandas_forbidden';
  end if;
  if v_row.status <> 'em_andamento' then
    raise exception 'demandas_transicao_invalida';
  end if;

  perform public.demandas_close_open_pause(v_row.id);
  perform public.demandas_enforce_geo(
    v_row, v_actor, 'envio_validacao', p_latitude, p_longitude, p_precisao_metros
  );
  perform public.demandas_assert_foto_envio(v_row);

  v_prev := v_row.status;
  update public.demandas
  set status = 'aguardando_validacao',
      validacao_enviada_em = now(),
      row_version = v_row.row_version + 1
  where id = v_row.id
  returning * into v_row;

  perform public.demandas_append_historico(
    v_row.id, v_actor.id, 'enviar_validacao',
    jsonb_build_object('status', v_prev),
    jsonb_build_object('status', v_row.status),
    null, 'rpc'
  );
  return v_row;
end;
$$;

create or replace function public.demandas_aprovar(
  p_demanda_id uuid,
  p_row_version integer
)
returns public.demandas
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.usuarios_internos%rowtype;
  v_row public.demandas%rowtype;
  v_prev text;
begin
  v_actor := public.demandas_require_actor();
  v_row := public.demandas_lock(p_demanda_id, p_row_version);

  if v_row.executor_id = v_actor.id then
    raise exception 'demandas_autoaprovacao_proibida';
  end if;
  if v_row.supervisor_id <> v_actor.id and not public.demandas_is_admin(v_actor) then
    raise exception 'demandas_forbidden';
  end if;
  if v_row.status <> 'aguardando_validacao' then
    raise exception 'demandas_transicao_invalida';
  end if;

  v_prev := v_row.status;
  update public.demandas
  set status = 'concluida',
      concluida_em = now(),
      row_version = v_row.row_version + 1
  where id = v_row.id
  returning * into v_row;

  perform public.demandas_append_historico(
    v_row.id, v_actor.id, 'aprovar',
    jsonb_build_object('status', v_prev),
    jsonb_build_object('status', v_row.status),
    null, 'rpc'
  );
  return v_row;
end;
$$;

create or replace function public.demandas_rejeitar(
  p_demanda_id uuid,
  p_row_version integer,
  p_justificativa text
)
returns public.demandas
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.usuarios_internos%rowtype;
  v_row public.demandas%rowtype;
  v_prev text;
  v_just text := btrim(coalesce(p_justificativa, ''));
begin
  v_actor := public.demandas_require_actor();
  v_row := public.demandas_lock(p_demanda_id, p_row_version);

  if v_row.executor_id = v_actor.id then
    raise exception 'demandas_autoaprovacao_proibida';
  end if;
  if v_row.supervisor_id <> v_actor.id and not public.demandas_is_admin(v_actor) then
    raise exception 'demandas_forbidden';
  end if;
  if v_row.status <> 'aguardando_validacao' then
    raise exception 'demandas_transicao_invalida';
  end if;
  if v_just = '' then
    raise exception 'demandas_justificativa_obrigatoria';
  end if;

  v_prev := v_row.status;
  update public.demandas
  set status = 'em_correcao',
      row_version = v_row.row_version + 1
  where id = v_row.id
  returning * into v_row;

  perform public.demandas_append_historico(
    v_row.id, v_actor.id, 'rejeitar',
    jsonb_build_object('status', v_prev),
    jsonb_build_object('status', v_row.status),
    v_just, 'rpc'
  );
  return v_row;
end;
$$;

create or replace function public.demandas_cancelar(
  p_demanda_id uuid,
  p_row_version integer,
  p_justificativa text
)
returns public.demandas
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.usuarios_internos%rowtype;
  v_row public.demandas%rowtype;
  v_prev text;
  v_just text := btrim(coalesce(p_justificativa, ''));
begin
  v_actor := public.demandas_require_actor();
  v_row := public.demandas_lock(p_demanda_id, p_row_version);

  if v_row.criador_id <> v_actor.id and not public.demandas_is_admin(v_actor) then
    raise exception 'demandas_forbidden';
  end if;
  if v_row.status in ('concluida', 'cancelada') then
    raise exception 'demandas_transicao_invalida';
  end if;
  if v_just = '' then
    raise exception 'demandas_justificativa_obrigatoria';
  end if;

  perform public.demandas_close_open_pause(v_row.id);

  v_prev := v_row.status;
  update public.demandas
  set status = 'cancelada',
      cancelada_em = now(),
      row_version = v_row.row_version + 1
  where id = v_row.id
  returning * into v_row;

  perform public.demandas_append_historico(
    v_row.id, v_actor.id, 'cancelar',
    jsonb_build_object('status', v_prev),
    jsonb_build_object('status', v_row.status),
    v_just, 'rpc'
  );
  return v_row;
end;
$$;

create or replace function public.demandas_reabrir(
  p_demanda_id uuid,
  p_row_version integer,
  p_justificativa text
)
returns public.demandas
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.usuarios_internos%rowtype;
  v_row public.demandas%rowtype;
  v_prev text;
  v_just text := btrim(coalesce(p_justificativa, ''));
begin
  v_actor := public.demandas_require_actor();
  v_row := public.demandas_lock(p_demanda_id, p_row_version);

  if v_row.criador_id <> v_actor.id and not public.demandas_is_admin(v_actor) then
    raise exception 'demandas_forbidden';
  end if;
  if v_row.status <> 'concluida' then
    raise exception 'demandas_transicao_invalida';
  end if;
  if v_just = '' then
    raise exception 'demandas_justificativa_obrigatoria';
  end if;

  v_prev := v_row.status;
  update public.demandas
  set status = 'em_correcao',
      concluida_em = null,
      row_version = v_row.row_version + 1
  where id = v_row.id
  returning * into v_row;

  perform public.demandas_append_historico(
    v_row.id, v_actor.id, 'reabrir',
    jsonb_build_object('status', v_prev),
    jsonb_build_object('status', v_row.status),
    v_just, 'rpc'
  );
  return v_row;
end;
$$;

create or replace function public.demandas_atualizar_geo_config(
  p_latitude double precision,
  p_longitude double precision,
  p_raio_metros numeric default 200
)
returns public.hotel_geo_config
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.usuarios_internos%rowtype;
  v_prev jsonb;
  v_row public.hotel_geo_config%rowtype;
begin
  v_actor := public.demandas_require_actor();
  if not public.demandas_is_admin(v_actor) then
    raise exception 'demandas_forbidden';
  end if;
  if p_latitude is null or p_latitude < -90 or p_latitude > 90 then
    raise exception 'demandas_latitude_invalida';
  end if;
  if p_longitude is null or p_longitude < -180 or p_longitude > 180 then
    raise exception 'demandas_longitude_invalida';
  end if;
  if p_raio_metros is null or p_raio_metros <= 0 then
    raise exception 'demandas_raio_invalido';
  end if;

  select to_jsonb(g) into v_prev from public.hotel_geo_config g where id = true;

  insert into public.hotel_geo_config (id, latitude, longitude, raio_metros, updated_by)
  values (true, p_latitude, p_longitude, p_raio_metros, v_actor.id)
  on conflict (id) do update set
    latitude = excluded.latitude,
    longitude = excluded.longitude,
    raio_metros = excluded.raio_metros,
    updated_by = excluded.updated_by
  returning * into v_row;

  insert into public.hotel_geo_config_historico (usuario_id, estado_anterior, estado_novo, origem)
  values (v_actor.id, v_prev, to_jsonb(v_row), 'rpc');

  return v_row;
end;
$$;

create or replace function public.demandas_registrar_anexo(
  p_demanda_id uuid,
  p_storage_path text,
  p_etapa text,
  p_mime text,
  p_tamanho_bytes integer
)
returns public.demandas_anexos
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.usuarios_internos%rowtype;
  v_row public.demandas%rowtype;
  v_anexo public.demandas_anexos%rowtype;
begin
  v_actor := public.demandas_require_actor();

  select * into v_row from public.demandas where id = p_demanda_id for update;
  if not found then
    raise exception 'demandas_nao_encontrada';
  end if;
  if v_row.status = 'cancelada' then
    raise exception 'demandas_transicao_invalida';
  end if;
  if v_row.executor_id <> v_actor.id
     and v_row.criador_id <> v_actor.id
     and not public.demandas_is_admin(v_actor) then
    raise exception 'demandas_forbidden';
  end if;
  if p_etapa not in ('antes', 'durante', 'finalizacao', 'correcao') then
    raise exception 'demandas_etapa_invalida';
  end if;
  if p_mime not in ('image/jpeg', 'image/jpg', 'image/png', 'image/webp') then
    raise exception 'demandas_mime_invalido';
  end if;
  if p_tamanho_bytes is null or p_tamanho_bytes <= 0 or p_tamanho_bytes > 2097152 then
    raise exception 'demandas_arquivo_grande';
  end if;
  if p_storage_path is null or position(v_row.id::text in p_storage_path) <> 1 then
    raise exception 'demandas_storage_path_invalido';
  end if;

  insert into public.demandas_anexos (
    demanda_id, storage_path, etapa, usuario_id, mime, tamanho_bytes
  ) values (
    v_row.id, p_storage_path, p_etapa, v_actor.id, p_mime, p_tamanho_bytes
  )
  returning * into v_anexo;

  perform public.demandas_append_historico(
    v_row.id, v_actor.id, 'incluir_foto', null,
    jsonb_build_object('storage_path', v_anexo.storage_path, 'etapa', v_anexo.etapa),
    null, 'rpc'
  );
  return v_anexo;
end;
$$;

create or replace function public.demandas_listar_usuarios_atribuiveis()
returns table (
  id uuid,
  nome text,
  telefone_whatsapp text
)
language sql
stable
security definer
set search_path = public
as $$
  select u.id, u.nome, u.telefone_whatsapp
  from public.usuarios_internos u
  where public.is_yes_hotel_demandas_reader()
    and u.ativo = true
    and u.telefone_whatsapp is not null
    and btrim(u.telefone_whatsapp) <> ''
  order by u.nome;
$$;

-- ---------------------------------------------------------------------------
-- 7) View de listagem (security_invoker)
-- ---------------------------------------------------------------------------
create or replace view public.demandas_lista
with (security_invoker = true) as
select
  d.*,
  (d.data_prevista_conclusao < public.demandas_today_campo_grande()
    and d.status not in ('concluida', 'cancelada')) as vencida,
  c.nome as criador_nome,
  s.nome as supervisor_nome,
  e.nome as executor_nome,
  s.telefone_whatsapp as supervisor_telefone,
  e.telefone_whatsapp as executor_telefone
from public.demandas d
join public.usuarios_internos c on c.id = d.criador_id
join public.usuarios_internos s on s.id = d.supervisor_id
join public.usuarios_internos e on e.id = d.executor_id;

-- ---------------------------------------------------------------------------
-- 8) RLS / grants
-- ---------------------------------------------------------------------------
alter table public.hotel_geo_config enable row level security;
alter table public.hotel_geo_config_historico enable row level security;
alter table public.demandas enable row level security;
alter table public.demandas_pausas enable row level security;
alter table public.demandas_historico enable row level security;
alter table public.demandas_anexos enable row level security;
alter table public.demandas_geo_checks enable row level security;
alter table public.demandas_modelos_programados enable row level security;
alter table public.demandas_ocorrencias_programadas enable row level security;

drop policy if exists hotel_geo_config_select on public.hotel_geo_config;
create policy hotel_geo_config_select on public.hotel_geo_config
  for select to authenticated using (public.is_yes_hotel_demandas_reader());

drop policy if exists hotel_geo_config_write_deny on public.hotel_geo_config;
create policy hotel_geo_config_write_deny on public.hotel_geo_config
  for all to authenticated using (false) with check (false);

drop policy if exists hotel_geo_config_historico_select on public.hotel_geo_config_historico;
create policy hotel_geo_config_historico_select on public.hotel_geo_config_historico
  for select to authenticated using (public.is_yes_hotel_demandas_reader());

drop policy if exists hotel_geo_config_historico_write_deny on public.hotel_geo_config_historico;
create policy hotel_geo_config_historico_write_deny on public.hotel_geo_config_historico
  for all to authenticated using (false) with check (false);

drop policy if exists demandas_select on public.demandas;
create policy demandas_select on public.demandas
  for select to authenticated using (public.is_yes_hotel_demandas_reader());
drop policy if exists demandas_write_deny on public.demandas;
create policy demandas_write_deny on public.demandas
  for all to authenticated using (false) with check (false);

drop policy if exists demandas_pausas_select on public.demandas_pausas;
create policy demandas_pausas_select on public.demandas_pausas
  for select to authenticated using (public.is_yes_hotel_demandas_reader());
drop policy if exists demandas_pausas_write_deny on public.demandas_pausas;
create policy demandas_pausas_write_deny on public.demandas_pausas
  for all to authenticated using (false) with check (false);

drop policy if exists demandas_historico_select on public.demandas_historico;
create policy demandas_historico_select on public.demandas_historico
  for select to authenticated using (public.is_yes_hotel_demandas_reader());
drop policy if exists demandas_historico_write_deny on public.demandas_historico;
create policy demandas_historico_write_deny on public.demandas_historico
  for all to authenticated using (false) with check (false);

drop policy if exists demandas_anexos_select on public.demandas_anexos;
create policy demandas_anexos_select on public.demandas_anexos
  for select to authenticated using (public.is_yes_hotel_demandas_reader());
drop policy if exists demandas_anexos_write_deny on public.demandas_anexos;
create policy demandas_anexos_write_deny on public.demandas_anexos
  for all to authenticated using (false) with check (false);

drop policy if exists demandas_geo_checks_select on public.demandas_geo_checks;
create policy demandas_geo_checks_select on public.demandas_geo_checks
  for select to authenticated using (public.is_yes_hotel_demandas_reader());
drop policy if exists demandas_geo_checks_write_deny on public.demandas_geo_checks;
create policy demandas_geo_checks_write_deny on public.demandas_geo_checks
  for all to authenticated using (false) with check (false);

drop policy if exists demandas_modelos_select on public.demandas_modelos_programados;
create policy demandas_modelos_select on public.demandas_modelos_programados
  for select to authenticated using (public.is_yes_hotel_demandas_reader());
drop policy if exists demandas_modelos_write_deny on public.demandas_modelos_programados;
create policy demandas_modelos_write_deny on public.demandas_modelos_programados
  for all to authenticated using (false) with check (false);

drop policy if exists demandas_ocorrencias_select on public.demandas_ocorrencias_programadas;
create policy demandas_ocorrencias_select on public.demandas_ocorrencias_programadas
  for select to authenticated using (public.is_yes_hotel_demandas_reader());
drop policy if exists demandas_ocorrencias_write_deny on public.demandas_ocorrencias_programadas;
create policy demandas_ocorrencias_write_deny on public.demandas_ocorrencias_programadas
  for all to authenticated using (false) with check (false);

revoke insert, update, delete on public.hotel_geo_config from authenticated, anon;
revoke insert, update, delete on public.hotel_geo_config_historico from authenticated, anon;
revoke insert, update, delete on public.demandas from authenticated, anon;
revoke insert, update, delete on public.demandas_pausas from authenticated, anon;
revoke insert, update, delete on public.demandas_historico from authenticated, anon;
revoke insert, update, delete on public.demandas_anexos from authenticated, anon;
revoke insert, update, delete on public.demandas_geo_checks from authenticated, anon;
revoke insert, update, delete on public.demandas_modelos_programados from authenticated, anon;
revoke insert, update, delete on public.demandas_ocorrencias_programadas from authenticated, anon;

grant select on public.hotel_geo_config to authenticated;
grant select on public.hotel_geo_config_historico to authenticated;
grant select on public.demandas to authenticated;
grant select on public.demandas_pausas to authenticated;
grant select on public.demandas_historico to authenticated;
grant select on public.demandas_anexos to authenticated;
grant select on public.demandas_geo_checks to authenticated;
grant select on public.demandas_modelos_programados to authenticated;
grant select on public.demandas_ocorrencias_programadas to authenticated;
grant select on public.demandas_lista to authenticated;

grant select, insert, update, delete on public.hotel_geo_config to service_role;
grant select, insert on public.hotel_geo_config_historico to service_role;
grant select, insert, update on public.demandas to service_role;
grant select, insert, update on public.demandas_pausas to service_role;
grant select, insert on public.demandas_historico to service_role;
grant select, insert on public.demandas_anexos to service_role;
grant select, insert on public.demandas_geo_checks to service_role;
grant select, insert, update on public.demandas_modelos_programados to service_role;
grant select, insert, update on public.demandas_ocorrencias_programadas to service_role;

revoke all on function public.demandas_require_actor() from public, anon, authenticated;
revoke all on function public.demandas_lock(uuid, integer) from public, anon, authenticated;
revoke all on function public.demandas_append_historico(uuid, uuid, text, jsonb, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.demandas_assert_usuario_atribuivel(uuid) from public, anon, authenticated;
revoke all on function public.demandas_enforce_geo(public.demandas, public.usuarios_internos, text, double precision, double precision, double precision) from public, anon, authenticated;
revoke all on function public.demandas_assert_foto_envio(public.demandas) from public, anon, authenticated;
revoke all on function public.demandas_close_open_pause(uuid) from public, anon, authenticated;

grant execute on function public.is_yes_hotel_demandas_reader() to authenticated;
grant execute on function public.demandas_normalize_telefone_whatsapp(text) to authenticated;
grant execute on function public.demandas_today_campo_grande() to authenticated;
grant execute on function public.demandas_haversine_meters(double precision, double precision, double precision, double precision) to authenticated;
grant execute on function public.demandas_criar(text, text, text, text, date, date, uuid, uuid, boolean, boolean) to authenticated;
grant execute on function public.demandas_editar(uuid, integer, text, text, text, text, date, date, uuid, uuid, boolean, boolean) to authenticated;
grant execute on function public.demandas_iniciar(uuid, integer, double precision, double precision, double precision) to authenticated;
grant execute on function public.demandas_pausar(uuid, integer, text) to authenticated;
grant execute on function public.demandas_retomar(uuid, integer) to authenticated;
grant execute on function public.demandas_enviar_validacao(uuid, integer, double precision, double precision, double precision) to authenticated;
grant execute on function public.demandas_aprovar(uuid, integer) to authenticated;
grant execute on function public.demandas_rejeitar(uuid, integer, text) to authenticated;
grant execute on function public.demandas_cancelar(uuid, integer, text) to authenticated;
grant execute on function public.demandas_reabrir(uuid, integer, text) to authenticated;
grant execute on function public.demandas_atualizar_geo_config(double precision, double precision, numeric) to authenticated;
grant execute on function public.demandas_registrar_anexo(uuid, text, text, text, integer) to authenticated;
grant execute on function public.demandas_liberar_agendadas() to authenticated;
grant execute on function public.demandas_listar_usuarios_atribuiveis() to authenticated;

-- ---------------------------------------------------------------------------
-- 9) Storage privado demandas-fotos
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'demandas-fotos',
  'demandas-fotos',
  false,
  2097152,
  array['image/jpeg', 'image/jpg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists demandas_fotos_select_readers on storage.objects;
create policy demandas_fotos_select_readers
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'demandas-fotos'
    and public.is_yes_hotel_demandas_reader()
  );

-- Sem INSERT/UPDATE/DELETE autenticado: upload via Edge/service_role.

-- ---------------------------------------------------------------------------
-- 10) Seed 18 modelos desativados — sem gerar ocorrências
-- ---------------------------------------------------------------------------
insert into public.demandas_modelos_programados (
  nome, descricao, periodicidade_unidade, periodicidade_intervalo,
  primeira_data, prazo_conclusao_dias, prioridade, exigir_foto, ativo
)
values
  ('Higienização das sete caixas-d’água da laje', 'Manutenção programada predial. Local na descrição da ocorrência futura.', 'meses', 6, '2026-09-01', 7, 'alta', true, false),
  ('Limpeza e desobstrução dos chuveiros e arejadores', 'Manutenção programada predial. Local na descrição da ocorrência futura.', 'meses', 1, '2026-09-01', 5, 'media', false, false),
  ('Limpeza das caixas de gordura', 'Manutenção programada predial. Local na descrição da ocorrência futura.', 'meses', 3, '2026-09-01', 5, 'alta', true, false),
  ('Inspeção e desobstrução preventiva da rede de esgoto', 'Manutenção programada predial. Local na descrição da ocorrência futura.', 'meses', 3, '2026-09-01', 7, 'alta', false, false),
  ('Limpeza de calhas e condutores de chuva', 'Manutenção programada predial. Local na descrição da ocorrência futura.', 'meses', 6, '2026-09-01', 5, 'media', true, false),
  ('Limpeza dos filtros dos aparelhos de ar-condicionado', 'Manutenção programada predial. Local na descrição da ocorrência futura.', 'meses', 2, '2026-09-01', 7, 'media', false, false),
  ('Higienização completa e revisão dos aparelhos de ar-condicionado', 'Manutenção programada predial. Local na descrição da ocorrência futura.', 'meses', 6, '2026-09-01', 10, 'alta', true, false),
  ('Conferência da automação dos ar-condicionados', 'Manutenção programada predial. Local na descrição da ocorrência futura.', 'meses', 1, '2026-09-01', 3, 'media', false, false),
  ('Inspeção de portas, dobradiças, fechaduras e maçanetas', 'Manutenção programada predial. Local na descrição da ocorrência futura.', 'meses', 3, '2026-09-01', 7, 'media', false, false),
  ('Revisão das fechaduras TTLock e substituição preventiva de pilhas', 'Manutenção programada predial. Local na descrição da ocorrência futura.', 'meses', 3, '2026-09-01', 7, 'alta', false, false),
  ('Revisão de rejuntes e silicones dos banheiros', 'Manutenção programada predial. Local na descrição da ocorrência futura.', 'meses', 6, '2026-09-01', 7, 'media', true, false),
  ('Inspeção de infiltração, umidade, mofo e pintura', 'Manutenção programada predial. Local na descrição da ocorrência futura.', 'meses', 3, '2026-09-01', 7, 'media', true, false),
  ('Teste da iluminação de emergência', 'Manutenção programada predial. Local na descrição da ocorrência futura.', 'meses', 3, '2026-09-01', 3, 'alta', false, false),
  ('Conferência dos extintores', 'Manutenção programada predial. Local na descrição da ocorrência futura.', 'meses', 6, '2026-09-01', 3, 'alta', false, false),
  ('Teste dos gateways TTLock', 'Manutenção programada predial. Local na descrição da ocorrência futura.', 'meses', 3, '2026-09-01', 5, 'alta', false, false),
  ('Inspeção das câmeras, fontes e conexões', 'Manutenção programada predial. Local na descrição da ocorrência futura.', 'meses', 3, '2026-09-01', 5, 'media', false, false),
  ('Dedetização e controle de pragas', 'Manutenção programada predial. Local na descrição da ocorrência futura.', 'anos', 1, '2026-09-01', 7, 'alta', false, false),
  ('Limpeza e manutenção da coifa e exaustão', 'Manutenção programada predial. Local na descrição da ocorrência futura.', 'meses', 6, '2026-09-01', 7, 'media', true, false)
on conflict (nome) do update set
  descricao = excluded.descricao,
  periodicidade_unidade = excluded.periodicidade_unidade,
  periodicidade_intervalo = excluded.periodicidade_intervalo,
  primeira_data = excluded.primeira_data,
  prazo_conclusao_dias = excluded.prazo_conclusao_dias,
  prioridade = excluded.prioridade,
  exigir_foto = excluded.exigir_foto,
  ativo = false;
