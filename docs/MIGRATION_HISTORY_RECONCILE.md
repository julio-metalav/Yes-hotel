# Reconciliação de histórico de migrations — Yes Hotel

Projeto remoto: `minmmecajnmjqlgacfoz`  
Commit base da aplicação: `998ba5e3f8dd9e460c81659236c4a1b9e174a18d`

Este documento explica por que os drafts locais `0022`–`0025` foram substituídos
por arquivos **timestampados** que espelham o SQL efetivamente aplicado no banco.

## Por que timestampados

As migrations foram aplicadas com o MCP `apply_migration`, que registra
`version` no formato timestamp (ex.: `20260804000955`), não `0025`.

Para alinhar o repositório ao histórico remoto **sem reaplicar**:

1. o SQL exato foi lido de `supabase_migrations.schema_migrations.statements`;
2. gravado em `supabase/migrations/<version>_<name>.sql`;
3. os drafts `0022`–`0025` foram movidos para
   `docs/migrations-archive/drafts-0022-0025/` (fora do diretório ativo de migrations).

Os arquivos timestampados começam com um header de comentário
(`Recovered from remote… / DO NOT re-apply`). O corpo SQL (após o header)
corresponde ao `statements[1]` remoto.

## Mapeamento

| Version remota | Nome remoto | Draft arquivado | Arquivo ativo (não reaplicar) |
|---|---|---|---|
| `20260803205229` | `fix_credencial_validity_campo_grande` | *(não havia draft versionado)* | `supabase/migrations/20260803205229_fix_credencial_validity_campo_grande.sql` |
| `20260803233625` | `operacional_primeiro_acesso_tolerancia` | `docs/migrations-archive/drafts-0022-0025/0022_…sql` | `supabase/migrations/20260803233625_…sql` |
| `20260803233650` | `first_room_access_create_tolerance_rpc` | `…/0023_…sql` | `supabase/migrations/20260803233650_…sql` |
| `20260803233835` | `operacional_hospedes_fnrh_roles` | `…/0024_…sql` | `supabase/migrations/20260803233835_…sql` |
| `20260804000955` | `first_room_access_transactional_rpc` | `…/0025_…sql` | `supabase/migrations/20260804000955_…sql` |

## Equivalência drafts × remoto

- **0022 / 0024 / 0025:** lógica equivalente ao remoto (diferenças de `begin`/`commit`
  e comentários; corpo funcional alinhado ao que foi aplicado).
- **0023:** o remoto aplicado inclui `REVOKE … FROM anon` e `FROM authenticated`
  além de `public` (hardening). O draft arquivado só revogava `public`.
  O arquivo timestampado `20260803233650_…` é a fonte da verdade.

## Migration `fix_credencial_validity_campo_grande`

- **Recuperada com SQL exato** do remoto (`statements[1]`).
- Arquivo: `20260803205229_fix_credencial_validity_campo_grande.sql`
- Conteúdo: `CREATE OR REPLACE` da função
  `operacional_criar_credencial_ao_liberar_acesso` usando timezone
  `America/Campo_Grande`.
- Não inventada. Necessária para o funcionamento atual de liberação de acesso
  (já aplicada remotamente antes desta reconciliação).

## Homologação manual do adapter

Script: `scripts/homologate-first-room-access-adapter.ts`

```bash
# Pré-requisitos (não versionar secrets):
#   SUPABASE_URL
#   SUPABASE_SERVICE_ROLE_KEY

npm run homologate:yes:first-room-access-adapter
```

### Pré-requisitos

- Projeto `minmmecajnmjqlgacfoz` com RPC `yes_hotel_process_first_room_access` aplicada.
- Credenciais **somente** em variáveis de ambiente locais.
- Nunca usar `anon` como fallback.

### O que o script faz

1. Cria dados sintéticos com marker `HOMOLOG-FRA-ADAPTER-20260803`.
2. Chama **somente** `SupabaseFirstRoomAccessUnitOfWork` (adapter real).
3. Valida `grace_started`, idempotência, `already_started` e erro de validação.
4. Limpa tudo em `finally` e falha se restar residual.

### Riscos

- Usa `service_role` (poder total no schema exposto). Executar só em sessão controlada.
- Não executar em CI nem em produção automatizada.
- Não altera senhas TTLock; não envia mensagens; não ativa feature flag.

### Limpeza

O script remove outbox, tolerâncias, eventos, FNRH, hóspedes, credenciais e reserva
do marker. Se a limpeza falhar, encerra com erro e lista IDs sintéticos (sem PII sensível).

## Proibições

- Não reaplicar os arquivos timestampados nem os drafts arquivados.
- Não automatizar o script de homologação em CI.
- Não versionar `homologacao/` (evidências locais).
