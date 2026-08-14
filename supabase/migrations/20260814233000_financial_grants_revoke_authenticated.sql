-- Hardening financeiro: default privileges do Supabase concedem ALL a authenticated
-- em tabelas novas. A foundation V1 fez GRANT SELECT, mas não revogou INSERT/UPDATE/DELETE
-- herdados. Este arquivo versiona a correção já aplicada manualmente no HOMO.
-- Não edita 20260814220000_financial_foundation_v1.sql.
-- NÃO aplicar em produção nesta rodada sem gate explícito.
-- Tabelas financial_* futuras devem revogar INSERT/UPDATE/DELETE de authenticated
-- na mesma migration que as cria (default privileges do Supabase reaparecem).

revoke insert, update, delete, truncate on public.financial_accounts from authenticated;
revoke insert, update, delete, truncate on public.financial_imports from authenticated;
revoke insert, update, delete, truncate on public.financial_import_row_errors from authenticated;
revoke insert, update, delete, truncate on public.financial_entries from authenticated;
revoke insert, update, delete, truncate on public.financial_reconciliation_groups from authenticated;
revoke insert, update, delete, truncate on public.financial_reconciliation_legs from authenticated;
revoke insert, update, delete, truncate on public.financial_audit_findings from authenticated;
revoke insert, update, delete, truncate on public.financial_ai_analyses from authenticated;

grant select on public.financial_accounts to authenticated;
grant select on public.financial_imports to authenticated;
grant select on public.financial_import_row_errors to authenticated;
grant select on public.financial_entries to authenticated;
grant select on public.financial_reconciliation_groups to authenticated;
grant select on public.financial_reconciliation_legs to authenticated;
grant select on public.financial_audit_findings to authenticated;
grant select on public.financial_ai_analyses to authenticated;

grant select, insert, update, delete on public.financial_accounts to service_role;
grant select, insert, update, delete on public.financial_imports to service_role;
grant select, insert, update, delete on public.financial_import_row_errors to service_role;
grant select, insert, update, delete on public.financial_entries to service_role;
grant select, insert, update, delete on public.financial_reconciliation_groups to service_role;
grant select, insert, update, delete on public.financial_reconciliation_legs to service_role;
grant select, insert, update, delete on public.financial_audit_findings to service_role;
grant select, insert, update, delete on public.financial_ai_analyses to service_role;
