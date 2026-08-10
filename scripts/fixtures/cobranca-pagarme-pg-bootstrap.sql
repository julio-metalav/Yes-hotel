-- Bootstrap mínimo para testar a migration de cobrança Pagar.me em Postgres efêmero.
-- Não é schema de produção completo — só o necessário para o índice/constraints.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create table if not exists public.usuarios_internos (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid,
  nome text not null default '',
  email_login text not null default '',
  perfil_usuario text not null default 'admin',
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.operacional_reservas (
  id uuid primary key default gen_random_uuid(),
  apartamento text not null default '',
  hospede_principal text not null default '',
  check_in_previsto date not null default current_date,
  check_out_previsto date not null default current_date,
  pagamento_status text not null default 'pendente'
    check (pagamento_status in ('pendente', 'pago')),
  acesso_liberado boolean not null default false,
  entrou_no_apto boolean not null default false,
  veiculo_placa text not null default '',
  veiculo_cor text not null default '',
  origem_externa text not null default 'manual',
  external_reservation_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Stubs usados por RLS helpers da migration (não exercitados neste teste SQL).
create or replace function public.is_yes_hotel_ops_reader()
returns boolean language sql stable as $$ select true $$;

create schema if not exists auth;
create or replace function auth.uid()
returns uuid
language sql
stable
as $$ select null::uuid $$;

do $$ begin
  create role authenticated;
exception when duplicate_object then null;
end $$;
do $$ begin
  create role anon;
exception when duplicate_object then null;
end $$;
do $$ begin
  create role service_role;
exception when duplicate_object then null;
end $$;
