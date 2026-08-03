# Artefatos pendentes de aplicação

Arquivos neste diretório **não** fazem parte do fluxo automático de migrations e **não** devem ser aplicados nesta etapa.

Antes de usar em homologação/produção:

1. Revisar o SQL com o time.
2. Confirmar secrets no projeto Supabase.
3. Aplicar manualmente (SQL Editor ou `psql`) após deploy da Edge Function correspondente.
4. Validar uma execução idempotente em horário controlado.
