-- Scheduler: leitura automática (GET, somente leitura) da hits-reservations-preview.
-- Objetivo: consultar reservas HITS no servidor sem depender de usuário logado,
-- navegador aberto ou botão manual. NÃO existe botão manual de sincronização HITS
-- e esta migration não reintroduz um.
--
-- A Edge hits-reservations-preview só aceita GET/OPTIONS (405 para os demais
-- métodos - ver supabase/functions/hits-reservations-preview/index.ts). Por isso
-- os 5 jobs abaixo usam net.http_get. NÃO usar net.http_post aqui.
--
-- A Edge não recebe parâmetros: reutiliza integralmente a janela default, status
-- (Confirmed/Processed), paginação, cache e retry já implementados no gateway.
-- Nenhuma lógica de negócio HITS é replicada neste SQL.
--
-- Esta função é somente leitura: não persiste reservas, não materializa
-- (hits-reserva-materializar) e não reconcilia (hits-reservation-sync). Nenhum
-- desses alvos é chamado por este scheduler.
--
-- Secrets NÃO ficam no Git: lidos do Vault (yes_hotel_edge_anon_key, já existente
-- e reutilizado pelos demais schedulers do projeto). Nenhum secret novo é criado.
--
-- Conversão de fuso (America/Campo_Grande = UTC-04:00 no desenho atual do projeto,
-- sem horário de verão) para os 5 horários locais acordados:
--   A) 07:00-19:50 local, a cada 10 min -> 11:00-23:50 UTC            => */10 11-23 * * *
--   B) 20:00-21:50 local, a cada 10 min -> 00:00-01:50 UTC (dia seg.) => */10 0-1 * * *
--   C) 22:00 local (extra da janela)    -> 02:00 UTC (dia seguinte)   => 0 2 * * *
--   D) 22:59 local (extra)              -> 02:59 UTC (dia seguinte)   => 59 2 * * *
--   E) 01:00 local (extra)              -> 05:00 UTC                 => 0 5 * * *
--
-- GATE OBRIGATÓRIO ANTES DE APLICAR EM PRODUÇÃO: o pg_cron agenda conforme a
-- configuração `cron.timezone` (não o `TimeZone` da sessão/banco). Confirmar com:
--   select
--     current_setting('TimeZone', true) as database_timezone,
--     current_setting('cron.timezone', true) as cron_timezone;
-- Os crons acima assumem que cron_timezone é GMT/UTC equivalente. Se não for,
-- NÃO aplicar esta migration até recalcular a grade. Esta migration não altera
-- o timezone do banco nem de cron.timezone (não executa ALTER SYSTEM/ALTER DATABASE).
--
-- Os 5 horários (minuto de disparo em UTC) nunca coincidem entre si:
--   */10 11-23  -> minutos 0,10,...,50 nas horas 11-23
--   */10 0-1    -> minutos 0,10,...,50 nas horas 0-1
--   0 2         -> hora 2, minuto 0
--   59 2        -> hora 2, minuto 59
--   0 5         -> hora 5, minuto 0
-- (horas 2 e 5 não aparecem nos dois primeiros jobs; dentro da hora 2, minutos 0 e 59 não colidem)

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

do $$
declare
  jid bigint;
  v_jobname text;
begin
  foreach v_jobname in array array[
    'yes-hotel-hits-preview-0700-1950',
    'yes-hotel-hits-preview-2000-2150',
    'yes-hotel-hits-preview-2200',
    'yes-hotel-hits-preview-2259',
    'yes-hotel-hits-preview-0100'
  ]
  loop
    for jid in select cron.job.jobid from cron.job where cron.job.jobname = v_jobname
    loop
      perform cron.unschedule(jid);
    end loop;
  end loop;
end $$;

-- A) Local 07:00-19:50 (a cada 10 min) => UTC 11:00-23:50
select cron.schedule(
  'yes-hotel-hits-preview-0700-1950',
  '*/10 11-23 * * *',
  $cron$
  select net.http_get(
    url := 'https://minmmecajnmjqlgacfoz.supabase.co/functions/v1/hits-reservations-preview',
    headers := jsonb_build_object(
      'Accept', 'application/json',
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
      )
    ),
    timeout_milliseconds := 55000
  ) as request_id;
  $cron$
);

-- B) Local 20:00-21:50 (a cada 10 min) => UTC 00:00-01:50 (dia seguinte)
select cron.schedule(
  'yes-hotel-hits-preview-2000-2150',
  '*/10 0-1 * * *',
  $cron$
  select net.http_get(
    url := 'https://minmmecajnmjqlgacfoz.supabase.co/functions/v1/hits-reservations-preview',
    headers := jsonb_build_object(
      'Accept', 'application/json',
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
      )
    ),
    timeout_milliseconds := 55000
  ) as request_id;
  $cron$
);

-- C) Local 22:00 (extra) => UTC 02:00 (dia seguinte)
select cron.schedule(
  'yes-hotel-hits-preview-2200',
  '0 2 * * *',
  $cron$
  select net.http_get(
    url := 'https://minmmecajnmjqlgacfoz.supabase.co/functions/v1/hits-reservations-preview',
    headers := jsonb_build_object(
      'Accept', 'application/json',
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
      )
    ),
    timeout_milliseconds := 55000
  ) as request_id;
  $cron$
);

-- D) Local 22:59 (extra) => UTC 02:59 (dia seguinte)
select cron.schedule(
  'yes-hotel-hits-preview-2259',
  '59 2 * * *',
  $cron$
  select net.http_get(
    url := 'https://minmmecajnmjqlgacfoz.supabase.co/functions/v1/hits-reservations-preview',
    headers := jsonb_build_object(
      'Accept', 'application/json',
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
      )
    ),
    timeout_milliseconds := 55000
  ) as request_id;
  $cron$
);

-- E) Local 01:00 (extra) => UTC 05:00
select cron.schedule(
  'yes-hotel-hits-preview-0100',
  '0 5 * * *',
  $cron$
  select net.http_get(
    url := 'https://minmmecajnmjqlgacfoz.supabase.co/functions/v1/hits-reservations-preview',
    headers := jsonb_build_object(
      'Accept', 'application/json',
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
      )
    ),
    timeout_milliseconds := 55000
  ) as request_id;
  $cron$
);

comment on extension pg_cron is
  'Job scheduler; yes-hotel-hits-preview-0700-1950/2000-2150/2200/2259/0100 disparam GET em hits-reservations-preview (somente leitura, sem materializar/reconciliar) além dos jobs TTLock/outbox/tolerância já existentes.';
