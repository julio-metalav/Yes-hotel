-- Verificação do snapshot HITS em HOMO (kzprrnbafamuozhyikgb). Somente leitura,
-- exceto os blocos 5 e 6 (simulação de falha), que tocam APENAS
-- hits_snapshot_sync_state / hits_reservas_snapshot com um batch sintético e
-- nunca o HITS. Rodar no SQL Editor do Supabase HOMO (papel postgres).
-- NÃO rodar em PROD.

-- 1) Objetos criados pela migration 20260924180000_hits_reservas_snapshot.sql
select table_name, row_security_active(('public.' || table_name)::regclass) as rls
from information_schema.tables
where table_schema = 'public'
  and table_name in ('hits_reservas_snapshot', 'hits_snapshot_sync_state')
order by table_name;

select p.proname, p.prosecdef as security_definer, p.proconfig
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname like 'hits_snapshot_sync_%'
order by p.proname;

-- 2) Grants: anon/authenticated sem EXECUTE nas RPCs; authenticated só SELECT nas tabelas
select r.rolname, p.proname, has_function_privilege(r.rolname, p.oid, 'EXECUTE') as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
where n.nspname = 'public'
  and p.proname like 'hits_snapshot_sync_%'
order by p.proname, r.rolname;
-- Esperado: anon=false, authenticated=false, service_role=true (3 funções).

select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('hits_reservas_snapshot', 'hits_snapshot_sync_state')
  and grantee in ('anon', 'authenticated')
order by table_name, grantee, privilege_type;
-- Esperado: apenas authenticated/SELECT nas duas tabelas; nenhuma linha para anon.

select schemaname, tablename, policyname, cmd, roles
from pg_policies
where tablename in ('hits_reservas_snapshot', 'hits_snapshot_sync_state')
order by tablename, policyname;
-- Esperado: 1 policy SELECT por tabela, roles {authenticated}.

-- 3) Estado atual do sync e da projeção (após pelo menos um tick do scheduler)
select * from public.hits_snapshot_sync_state;
select count(*) as reservas_no_snapshot,
       min(check_in) as primeiro_check_in,
       max(check_in) as ultimo_check_in,
       count(*) filter (where ciclo_hits = 'hospedada') as hospedadas,
       max(last_seen_at) as ultimo_last_seen
from public.hits_reservas_snapshot;

-- 4) RLS na prática: anon não lê nada; authenticated sem perfil não lê nada.
--    (set role só funciona no SQL Editor com papel postgres; reverter com reset role.)
set role anon;
select count(*) as anon_ve from public.hits_reservas_snapshot;      -- esperado: erro 42501 (permission denied)
reset role;
set role authenticated;
select count(*) as authenticated_sem_perfil_ve from public.hits_reservas_snapshot; -- esperado: 0 (RLS: auth.uid() nulo)
reset role;

-- 5) Simulação de FALHA de sync: o snapshot anterior tem de permanecer intacto.
--    Guarda um retrato antes, marca falha com batch sintético, compara.
create temp table _antes as select * from public.hits_reservas_snapshot;
select public.hits_snapshot_sync_fail('00000000-0000-0000-0000-000000000001'::uuid, 'simulacao_homo: falha de leitura');
select last_status, last_error, last_success_at, last_finished_at from public.hits_snapshot_sync_state;
-- Esperado: last_status='error', last_error='simulacao_homo: ...', last_success_at INALTERADO.
select
  (select count(*) from _antes) as linhas_antes,
  (select count(*) from public.hits_reservas_snapshot) as linhas_depois,
  (select count(*) from (select * from _antes except select * from public.hits_reservas_snapshot) d) as diferentes;
-- Esperado: linhas_antes = linhas_depois e diferentes = 0.
-- Na UI (HOMO), neste momento a barra HITS deve mostrar os dados + aviso
-- "última sincronização com HITS falhou — exibindo dados de HH:MM".
-- O próximo tick do scheduler (≤ 10 min) volta o estado para ok/partial sozinho.

-- 6) Simulação de lote PARCIAL: id com detalhe falho NÃO é removido; id que sumiu é removido.
--    Usa ids sintéticos que nunca existem no HITS. Limpa no final.
select public.hits_snapshot_sync_apply(
  '00000000-0000-0000-0000-000000000002'::uuid,
  '[{"external_reservation_id":"HOMO-TESTE-A","apartamento":"99","hospede_principal":"Teste A","check_in":"2026-09-24","check_out":"2026-09-25","status_reserva":"ativa","ciclo_hits":"confirmada","total_hospedes":1},
    {"external_reservation_id":"HOMO-TESTE-B","apartamento":"98","hospede_principal":"Teste B","check_in":"2026-09-24","check_out":"2026-09-26","status_reserva":"ativa","ciclo_hits":"hospedada","total_hospedes":2,
     "contactPhone":"NAO-DEVE-SER-GRAVADO","docCpfCnpjPassport":"NAO-DEVE-SER-GRAVADO"}]'::jsonb,
  '{}'::text[], 'ok', 'last_page');
-- ATENÇÃO: este apply remove as linhas reais do snapshot (não vieram no lote sintético).
-- O próximo tick do scheduler as recria. Só rodar em HOMO fora de horário de uso.
select external_reservation_id, apartamento, ciclo_hits, batch_id from public.hits_reservas_snapshot order by 1;
-- Esperado: apenas HOMO-TESTE-A e HOMO-TESTE-B; nenhuma coluna de contato/documento existe.

select public.hits_snapshot_sync_apply(
  '00000000-0000-0000-0000-000000000003'::uuid,
  '[{"external_reservation_id":"HOMO-TESTE-A","apartamento":"99","hospede_principal":"Teste A","check_in":"2026-09-24","check_out":"2026-09-25","status_reserva":"ativa","ciclo_hits":"confirmada","total_hospedes":1}]'::jsonb,
  '{HOMO-TESTE-B}'::text[], 'partial', 'last_page');
select external_reservation_id, batch_id from public.hits_reservas_snapshot order by 1;
-- Esperado: A (batch ...0003) e B (batch ...0002, mantida por estar em p_failed_ids).
select last_status, last_failed_count, last_rows_count from public.hits_snapshot_sync_state;
-- Esperado: partial, 1, 1.

select public.hits_snapshot_sync_apply(
  '00000000-0000-0000-0000-000000000004'::uuid,
  '[{"external_reservation_id":"HOMO-TESTE-A","apartamento":"99","hospede_principal":"Teste A","check_in":"2026-09-24","check_out":"2026-09-25","status_reserva":"ativa","ciclo_hits":"confirmada","total_hospedes":1}]'::jsonb,
  '{}'::text[], 'ok', 'last_page');
select external_reservation_id from public.hits_reservas_snapshot order by 1;
-- Esperado: só A (B saiu da janela e não estava em p_failed_ids).

-- Limpeza dos ids sintéticos (o próximo tick reconstrói o snapshot real).
delete from public.hits_reservas_snapshot where external_reservation_id like 'HOMO-TESTE-%';
drop table if exists _antes;
