-- Bootstrap mínimo para aplicar a migration financeira em Postgres efêmero.
-- Não é o schema de produção. Sem PII real. Sem remoto.

create extension if not exists pgcrypto;

create schema if not exists auth;
create schema if not exists storage;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

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

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid
);

alter table storage.objects enable row level security;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema storage to anon, authenticated, service_role;
grant usage on schema auth to authenticated, service_role;
grant select on public.usuarios_internos to authenticated, service_role;
grant select, insert, update, delete on storage.buckets to service_role;
grant select on storage.objects to authenticated;
grant select, insert, update, delete on storage.objects to service_role;
