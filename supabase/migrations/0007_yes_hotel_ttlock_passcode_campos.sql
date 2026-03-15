-- Fase TTLock 2: campos para passcode temporário e identificador remoto.
-- Permite persistir o código gerado na credencial e o id retornado pela TTLock por item.

alter table public.operacional_credenciais_acesso
  add column if not exists codigo_credencial text,
  add column if not exists provider_tipo text default 'ttlock_passcode'
    check (provider_tipo is null or provider_tipo in ('ttlock_passcode', 'ttlock_ekey'));

comment on column public.operacional_credenciais_acesso.codigo_credencial is
  'Passcode temporário gerado (ex.: 6 dígitos); mesmo código usado em todos os itens da credencial.';
comment on column public.operacional_credenciais_acesso.provider_tipo is
  'Tipo de provisionamento: ttlock_passcode (principal nesta fase) ou ttlock_ekey (futuro).';

alter table public.operacional_credencial_itens
  add column if not exists remote_keyboard_pwd_id bigint,
  add column if not exists codigo_enviado text;

comment on column public.operacional_credencial_itens.remote_keyboard_pwd_id is
  'ID do passcode retornado pela TTLock (keyboardPwdId) para este item; usado para alterar/revogar depois.';
comment on column public.operacional_credencial_itens.codigo_enviado is
  'Cópia do passcode enviado a esta fechadura (mesmo valor da credencial); útil para suporte/debug.';
