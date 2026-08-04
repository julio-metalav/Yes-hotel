# Drafts numéricos 0022–0025 (arquivados)

Estes arquivos são **drafts de desenvolvimento** com prefixo `0022`–`0025`.

Eles **não** são a fonte da verdade do banco remoto.

## Por que foram arquivados

No projeto Supabase `minmmecajnmjqlgacfoz`, o SQL equivalente foi aplicado via MCP
`apply_migration`, gerando versões **timestampadas**:

| Draft | Version remota / arquivo em `supabase/migrations/` |
|---|---|
| 0022 | `20260803233625_operacional_primeiro_acesso_tolerancia.sql` |
| 0023 | `20260803233650_first_room_access_create_tolerance_rpc.sql` |
| 0024 | `20260803233835_operacional_hospedes_fnrh_roles.sql` |
| 0025 | `20260804000955_first_room_access_transactional_rpc.sql` |

Manter os drafts em `supabase/migrations/` com prefixo numérico distinto das
versões remotas provocaria risco de **reaplicação** ou drift de histórico na CLI.

## Regras

- **NÃO** reaplicar estes arquivos.
- **NÃO** copiá-los de volta para `supabase/migrations/` sem decisão explícita.
- Esta pasta fica em `docs/migrations-archive/` (fora de `supabase/migrations/`)
  para que nenhuma ferramenta trate estes SQL como migrations ativas.

Ver também: `docs/MIGRATION_HISTORY_RECONCILE.md`.
