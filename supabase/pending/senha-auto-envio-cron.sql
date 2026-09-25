-- =============================================================================
-- APLICADO. Este arquivo deixou de ser a fonte de verdade.
-- =============================================================================
-- O agendamento das 13h virou migration canonica:
--
--   supabase/migrations/20261002090000_senha_auto_envio_13h_cron.sql
--
-- Jobs criados la:
--   yes-hotel-senha-auto-envio-13h     '5 17 * * *'        (13:05 Campo Grande)
--   yes-hotel-senha-auto-envio-retry   '*/30 17-23 * * *'  (13:00-19:30 local)
--
-- Nao reintroduzir o agendamento aqui: duas fontes de verdade para o mesmo job
-- foi exatamente o motivo de a regra das 13h nunca ter rodado em producao.
-- =============================================================================

select 'APLICADO: ver supabase/migrations/20261002090000_senha_auto_envio_13h_cron.sql' as status;
