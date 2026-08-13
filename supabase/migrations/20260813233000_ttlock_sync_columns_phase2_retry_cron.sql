-- Colunas sync_* da 0009 constam em schema_migrations mas podem faltar no schema
-- físico. Recria IF NOT EXISTS. Scheduler fase 2: retoma lifecycle_provision + send-senha.

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
  'Mensagem do último erro de sincronização (resumida). Também carrega estado de retry transitório fase 2.';

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

do $$
declare
  jid bigint;
begin
  for jid in
    select jobid from cron.job where jobname = 'yes-hotel-ttlock-provision-retry'
  loop
    perform cron.unschedule(jid);
  end loop;
end $$;

select cron.schedule(
  'yes-hotel-ttlock-provision-retry',
  '* * * * *',
  $cron$
  select net.http_post(
    url := 'https://minmmecajnmjqlgacfoz.supabase.co/functions/v1/ttlock-provision-retry',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'yes_hotel_edge_anon_key'
        limit 1
      ),
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'yes_hotel_edge_anon_key'
        limit 1
      ),
      'x-access-tolerance-token', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'access_tolerance_processor_token'
        limit 1
      )
    ),
    body := '{"limit":5}'::jsonb,
    timeout_milliseconds := 55000
  ) as request_id;
  $cron$
);

comment on extension pg_cron is
  'Job scheduler; yes-hotel-ttlock-provision-retry retoma fase 2 TTLock a cada minuto.';
