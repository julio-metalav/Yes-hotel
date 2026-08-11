-- Scheduler: polling TTLock lockRecord/list (~1 min).
-- NÃO processa tolerâncias. NÃO reprocessa evento seed 18:39:51 (watermark na migration de checkpoint).
-- Pré-requisito operacional:
--   vault: access_tolerance_processor_token, yes_hotel_edge_anon_key
--   Edge secrets: ACCESS_TOLERANCE_PROCESSOR_TOKEN, YES_HOTEL_TTLOCK_ACCESS_POLL_ENABLED=true
--   TTLock creds + TTLOCK_ACCESS_IDEMPOTENCY_SECRET já existentes

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

do $$
declare
  jid bigint;
begin
  for jid in
    select jobid from cron.job where jobname = 'yes-hotel-ttlock-access-poll'
  loop
    perform cron.unschedule(jid);
  end loop;
end $$;

select cron.schedule(
  'yes-hotel-ttlock-access-poll',
  '* * * * *',
  $cron$
  select net.http_post(
    url := 'https://minmmecajnmjqlgacfoz.supabase.co/functions/v1/ttlock-access-poller',
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
    body := '{"limitLocks":50}'::jsonb,
    timeout_milliseconds := 55000
  ) as request_id;
  $cron$
);

comment on extension pg_cron is
  'Job scheduler; yes-hotel-ttlock-access-poll + yes-hotel-access-outbox-dispatch.';
