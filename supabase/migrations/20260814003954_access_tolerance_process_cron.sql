-- Scheduler: processamento automático de tolerâncias / PPD (~1 min).
-- Invoca access-tolerance-processor em mode=process.
-- NÃO altera o job yes-hotel-access-outbox-dispatch (mode=dispatch permanece separado).
-- Secrets NÃO ficam no Git: lidos do Vault (nomes abaixo).
-- Pré-requisito operacional (fora desta migration):
--   vault secrets:
--     access_tolerance_processor_token
--     yes_hotel_edge_anon_key
--   Edge secrets:
--     ACCESS_TOLERANCE_PROCESSOR_TOKEN (mesmo valor do vault)
--     YES_HOTEL_ACCESS_TOLERANCE_PROCESSOR_ENABLED=true
--     YES_HOTEL_TTLOCK_SUSPENSION_ENABLED=true
--     YES_HOTEL_TTLOCK_HOMOLOG_LOCK_ID=<lock homologada; efeito físico só nessa lock>
-- dry_run=false no body NÃO relaxa o gate: o Edge ainda exige flag TTLock + homolog lock.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

do $$
declare
  jid bigint;
begin
  for jid in
    select jobid from cron.job where jobname = 'yes-hotel-access-tolerance-process'
  loop
    perform cron.unschedule(jid);
  end loop;
end $$;

select cron.schedule(
  'yes-hotel-access-tolerance-process',
  '* * * * *',
  $cron$
  select net.http_post(
    url := 'https://minmmecajnmjqlgacfoz.supabase.co/functions/v1/access-tolerance-processor',
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
    body := '{"mode":"process","limit":20,"dry_run":false}'::jsonb,
    timeout_milliseconds := 55000
  ) as request_id;
  $cron$
);

comment on extension pg_cron is
  'Job scheduler; yes-hotel-access-outbox-dispatch (mode=dispatch) + yes-hotel-access-tolerance-process (mode=process) + poll/retry TTLock.';
