-- Scheduler: despacho automático da operacional_acesso_outbox (~1 min).
-- Consome a outbox (mode=dispatch). NÃO liga o processador de tolerâncias/suspensão.
-- Secrets NÃO ficam no Git: lidos do Vault (nomes abaixo).
-- Pré-requisito operacional (fora desta migration):
--   vault secrets:
--     access_tolerance_processor_token
--     yes_hotel_edge_anon_key
--   Edge secrets:
--     ACCESS_TOLERANCE_PROCESSOR_TOKEN (mesmo valor do vault)
--     YES_HOTEL_ACCESS_OUTBOX_DISPATCH_ENABLED=true
--     YES_HOTEL_ACCESS_DIGISAC_REAL_ENABLED=true
--     YES_HOTEL_DIGISAC_INTERNAL_NUMBER=556721800225
--     DIGISAC_USE_MOCK=false

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

do $$
declare
  jid bigint;
begin
  for jid in
    select jobid from cron.job where jobname = 'yes-hotel-access-outbox-dispatch'
  loop
    perform cron.unschedule(jid);
  end loop;
end $$;

select cron.schedule(
  'yes-hotel-access-outbox-dispatch',
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
    body := '{"mode":"dispatch","limit":20}'::jsonb,
    timeout_milliseconds := 15000
  ) as request_id;
  $cron$
);

comment on extension pg_cron is
  'Job scheduler; yes-hotel-access-outbox-dispatch invoca access-tolerance-processor mode=dispatch a cada minuto.';
