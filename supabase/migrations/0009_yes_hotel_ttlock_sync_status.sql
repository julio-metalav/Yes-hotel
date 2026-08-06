-- Fase TTLock 3.1: estado de sincronização local x remoto (pendência explícita).
-- Permite distinguir sucesso total, falha parcial e pendência de retry.

alter table public.operacional_credenciais_acesso
  add column if not exists sync_status text
    check (sync_status is null or sync_status in ('ok', 'pending', 'partial', 'failed')),
  add column if not exists last_sync_attempt_at timestamptz,
  add column if not exists last_sync_error text;
comment on column public.operacional_credenciais_acesso.sync_status is
  'Estado da sincronização com TTLock: ok=sincronizado, pending=aguardando retry, partial=sucesso parcial, failed=falha.';
comment on column public.operacional_credenciais_acesso.last_sync_attempt_at is
  'Data/hora da última tentativa de sincronização remota.';
comment on column public.operacional_credenciais_acesso.last_sync_error is
  'Mensagem do último erro de sincronização (resumida).';
