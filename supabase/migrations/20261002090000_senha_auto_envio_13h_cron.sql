-- Scheduler: liberacao automatica de credenciais as 13h (Campo Grande/MS).
--
-- Ate aqui a Edge `senha-auto-envio` existia, funcionava e era testada, mas
-- NINGUEM a chamava: o SQL de agendamento vivia comentado em
-- supabase/pending/senha-auto-envio-cron.sql, fora de migrations. Na pratica a
-- regra das 13h nunca rodava sozinha em producao.
--
-- Regra canonica preservada: as 13h o acesso pode ser liberado mesmo sem FNRH
-- e sem pagamento. A Edge decide; esta migration apenas a aciona no horario.
--
-- Fuso: America/Campo_Grande = UTC-4 o ano todo (sem horario de verao).
--   13:05 local = 17:05 UTC  -> '5 17 * * *'
-- A propria Edge revalida a hora local (AUTO_HOUR = 13) e ignora reservas com
-- senha_enviada_em, entao reexecucao e inofensiva.
--
-- `senha-auto-envio` tem verify_jwt = false (config.toml): a gateway nao pede
-- JWT e quem autentica e a propria funcao, por service_role no Authorization
-- OU pelo header x-senha-scheduler-token. Usamos o token dedicado, que e menos
-- privilegiado que a service_role.
--
-- Fora de escopo: nada de TTLock, tolerancia de 1h, pagamento, FNRH, HITS,
-- comissionamento ou qualquer outro job. O job de tolerancia
-- (yes-hotel-access-tolerance-process) nao e tocado.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

-- ---------------------------------------------------------------------------
-- Pre-requisito: sem o token no Vault o cron dispararia e tomaria 401 em
-- silencio, todo dia, sem ninguem perceber. Falhar aqui e melhor que agendar
-- um job quebrado.
--
-- Antes de aplicar:
--   1. Edge secret  SENHA_SCHEDULER_TOKEN = <valor>
--   2. Vault secret senha_scheduler_token = <mesmo valor>
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from vault.decrypted_secrets where name = 'senha_scheduler_token'
  ) then
    raise exception using
      message = 'vault secret "senha_scheduler_token" ausente',
      hint = 'Crie a Edge secret SENHA_SCHEDULER_TOKEN e a vault secret senha_scheduler_token com o MESMO valor antes de aplicar esta migration.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Idempotencia: remove qualquer agendamento anterior com o mesmo nome antes de
-- criar. Sem isto, reaplicar a migration duplicaria o job e o envio.
-- Mesmo padrao de 20260814003954_access_tolerance_process_cron.sql.
-- ---------------------------------------------------------------------------
do $$
declare
  jid bigint;
begin
  for jid in
    select jobid from cron.job
    where jobname in (
      'yes-hotel-senha-auto-envio-13h',
      'yes-hotel-senha-auto-envio-retry'
    )
  loop
    perform cron.unschedule(jid);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 13:05 local, uma vez por dia.
-- ---------------------------------------------------------------------------
select cron.schedule(
  'yes-hotel-senha-auto-envio-13h',
  '5 17 * * *',
  $cron$
  select net.http_post(
    url := 'https://minmmecajnmjqlgacfoz.supabase.co/functions/v1/senha-auto-envio',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-senha-scheduler-token', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'senha_scheduler_token'
        limit 1
      )
    ),
    body := '{"mode":"13h"}'::jsonb,
    timeout_milliseconds := 55000
  ) as request_id;
  $cron$
);

-- ---------------------------------------------------------------------------
-- Retry: a cada 30 min entre 13:00 e 19:30 locais, para reserva cuja geracao
-- ou envio falhou no disparo das 13h. A Edge ignora quem ja recebeu senha, e
-- `lastOpenFailure` limita a reprocessar so o que ficou em falha aberta.
-- ---------------------------------------------------------------------------
select cron.schedule(
  'yes-hotel-senha-auto-envio-retry',
  '*/30 17-23 * * *',
  $cron$
  select net.http_post(
    url := 'https://minmmecajnmjqlgacfoz.supabase.co/functions/v1/senha-auto-envio',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-senha-scheduler-token', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'senha_scheduler_token'
        limit 1
      )
    ),
    body := '{"mode":"retry","limit":20}'::jsonb,
    timeout_milliseconds := 55000
  ) as request_id;
  $cron$
);

-- ---------------------------------------------------------------------------
-- Autoverificacao: exatamente um job de cada, nos horarios esperados.
-- ---------------------------------------------------------------------------
do $$
declare
  v_13h integer;
  v_retry integer;
  v_sched text;
begin
  select count(*) into v_13h from cron.job where jobname = 'yes-hotel-senha-auto-envio-13h';
  select count(*) into v_retry from cron.job where jobname = 'yes-hotel-senha-auto-envio-retry';
  if v_13h <> 1 or v_retry <> 1 then
    raise exception 'agendamento duplicado ou ausente: 13h=% retry=%', v_13h, v_retry;
  end if;

  select schedule into v_sched from cron.job where jobname = 'yes-hotel-senha-auto-envio-13h';
  if v_sched <> '5 17 * * *' then
    raise exception 'horario das 13h incorreto: % (esperado 5 17 * * * = 13:05 em Campo Grande)', v_sched;
  end if;

  raise notice 'cron das 13h ativo: 13:05 local + retry a cada 30 min ate 19:30 local';
end $$;

comment on extension pg_cron is
  'Job scheduler; yes-hotel-access-outbox-dispatch (mode=dispatch) + yes-hotel-access-tolerance-process (mode=process) + yes-hotel-senha-auto-envio-13h/retry + poll/retry TTLock.';
