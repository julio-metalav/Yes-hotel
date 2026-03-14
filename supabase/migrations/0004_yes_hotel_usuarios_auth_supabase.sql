-- Migracao minima para usar Supabase Auth + perfil interno em usuarios_internos.

alter table public.usuarios_internos
    add column if not exists auth_user_id uuid;

update public.usuarios_internos
set perfil_usuario = case
    when perfil_usuario = 'administrativo' then 'admin'
    when perfil_usuario = 'operacional' then 'recepcao'
    else perfil_usuario
end;

alter table public.usuarios_internos
    drop constraint if exists usuarios_internos_perfil_usuario_check;

alter table public.usuarios_internos
    add constraint usuarios_internos_perfil_usuario_check
        check (perfil_usuario in ('admin', 'recepcao', 'cafe'));

create unique index if not exists usuarios_internos_auth_user_id_uidx
    on public.usuarios_internos (auth_user_id)
    where auth_user_id is not null;

alter table public.usuarios_internos enable row level security;

drop policy if exists usuarios_internos_select_own_profile on public.usuarios_internos;

create policy usuarios_internos_select_own_profile
    on public.usuarios_internos
    for select
    to authenticated
    using (auth.uid() = auth_user_id);
