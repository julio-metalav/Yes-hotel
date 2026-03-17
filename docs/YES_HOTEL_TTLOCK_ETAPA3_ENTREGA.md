# Etapa 3 corrigida — Entrega

## 1. Implementação

- **Enum:** Adicionado valor `pendente_limpeza` em `operacional_item_provisionamento_status` (migration 0014).
- **Regra aplicada:**
  - **Sucesso no delete remoto:** `status_provisionamento = "revogado"`, `revogado_em = now()`, `ultimo_erro = null`.
  - **Falha no delete remoto:** `status_provisionamento = "pendente_limpeza"`, `ultimo_erro = mensagem`; **não** preencher `revogado_em`.
  - **Item sem `remote_keyboard_pwd_id`:** encerramento apenas local → `revogado` + `revogado_em` (comentário no código e regra no contrato).
- **getItensPendentesLimpeza:** filtra por `status_provisionamento = 'pendente_limpeza'` e `remote_keyboard_pwd_id` não nulo (Edge e app).
- **Contagens:** `itensRevogados` = só `revogado`; novo `itensPendentesLimpeza` = `pendente_limpeza`. Resumo de sync inclui "X pendente(s) limpeza" quando houver.
- **retry_sync (app):** passa a usar `getItensPendentesLimpeza` para credencial revogada; em falha mantém `pendente_limpeza` + `ultimo_erro`.
- **Room change:** em falha do delete remoto → `pendente_limpeza` + `ultimo_erro` (não mais `revogado` fake).

---

## 2. Arquivos alterados (lista)

| Arquivo | Alteração |
|---------|-----------|
| `supabase/migrations/0014_yes_hotel_item_pendente_limpeza.sql` | **Novo.** ADD VALUE `pendente_limpeza` + COMMENT no tipo. |
| `src/lib/application/yes-hotel/types.ts` | Inclusão de `"pendente_limpeza"` em `OperacionalItemProvisionamentoStatus`. |
| `supabase/functions/yes-hotel-lifecycle/index.ts` | getItensPendentesLimpeza por `pendente_limpeza`; em falha do delete → `pendente_limpeza` + `ultimo_erro`; comentários para item sem passcode remoto e TTLock indisponível; retry de pendentes com update para `revogado` + `revogado_em` em sucesso. |
| `src/lib/application/yes-hotel/credential-lifecycle.ts` | Em falha do delete → `pendente_limpeza` + `ultimo_erro` (sem `revogado_em`); comentários item sem passcode / TTLock indisponível; room change em falha → `pendente_limpeza`; retryCredentialSync usa getItensPendentesLimpeza e em falha seta `pendente_limpeza` + `ultimo_erro`. |
| `src/lib/application/yes-hotel/provisioning-executor.ts` | Interface `ProvisioningRepository`: novo método `getItensPendentesLimpeza(credencialId)`. |
| `src/lib/application/yes-hotel/supabase-provisioning-repo.ts` | Implementação de `getItensPendentesLimpeza` (filtro `pendente_limpeza` + `remote_keyboard_pwd_id` not null). |
| `src/lib/application/yes-hotel/credential-lifecycle-status.ts` | `CredentialLifecycleStatus`: novo campo `itensPendentesLimpeza`; contagem por `pendente_limpeza`; `getReservationCredentialSyncSummary`: resumo com "X pendente(s) limpeza" quando > 0. |
| `docs/YES_HOTEL_TTLOCK_CONTRATO_API.md` | Regras de `revogado` vs `pendente_limpeza` e seção "Item sem passcode remoto". |

---

## 3. Migration completa

**Arquivo:** `supabase/migrations/0014_yes_hotel_item_pendente_limpeza.sql`

```sql
-- Etapa 3 corrigida: estado honesto para delete remoto não confirmado.
-- revogado/revogado_em = apenas quando delete remoto for confirmado.
-- pendente_limpeza = encerramento local (ex.: checkout) feito, delete remoto pendente ou falhou.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'operacional_item_provisionamento_status' AND e.enumlabel = 'pendente_limpeza'
  ) THEN
    ALTER TYPE public.operacional_item_provisionamento_status ADD VALUE 'pendente_limpeza';
  END IF;
END
$$;

COMMENT ON TYPE public.operacional_item_provisionamento_status IS
  'pendente, provisionando, provisionado, falhou, revogado (delete remoto confirmado), pendente_limpeza (delete remoto pendente ou falhou)';
```

---

## 4. Impacto nas consultas/telas

| Onde | Impacto |
|------|---------|
| **Filtro por `revogado`** | Continua igual; só itens com delete remoto **confirmado** entram. Itens em falha de delete deixam de ser `revogado` e passam a `pendente_limpeza`. |
| **getCredentialLifecycleStatus** | Novo campo `itensPendentesLimpeza`; `itensRevogados` conta só `revogado`. Quem consome o tipo precisa aceitar o novo campo (aditivo). |
| **getReservationCredentialSyncSummary** | Resumo pode incluir "X pendente(s) limpeza"; compatível com quem só exibe a string. |
| **Edge getItensPendentesLimpeza** | Critério alterado de `revogado` + `ultimo_erro` para `pendente_limpeza`; retry e list_pending_cleanup passam a considerar só esse status. |
| **retryCredentialSync (app)** | Passa a buscar itens com `getItensPendentesLimpeza` em vez de `getItensProvisionados` para credencial revogada; retry de fato processa itens pendentes de limpeza. |
| **UI (checkin-operacional-mvp.js etc.)** | Nenhuma mudança obrigatória; se consumir sync summary/resumo, passa a poder mostrar pendentes de limpeza quando o backend incluir no resumo. |

---

## 5. Comando de validação

1. **Rodar a migration:**
   ```bash
   cd "D:\Automação_Yes_Hotel"
   npx supabase db push
   ```
   ou, se usar migrações locais:
   ```bash
   npx supabase migration up
   ```

2. **Checar tipo no banco:**
   ```sql
   SELECT enumlabel FROM pg_enum e
   JOIN pg_type t ON e.enumtypid = t.oid
   WHERE t.typname = 'operacional_item_provisionamento_status'
   ORDER BY enumsortorder;
   ```
   Deve listar: `pendente`, `provisionando`, `provisionado`, `falhou`, `revogado`, `pendente_limpeza`.

3. **Fluxo funcional (manual ou teste):**
   - Provisionar uma reserva com TTLock.
   - Fazer checkout: itens com passcode remoto devem ir para `revogado` + `revogado_em` + `ultimo_erro` null.
   - Simular falha no delete (ex.: timeout/mock): item deve ficar `pendente_limpeza` + `ultimo_erro`; `revogado_em` não preenchido.
   - Chamar retry_sync (Edge ou app): itens `pendente_limpeza` devem ser tentados de novo; em sucesso → `revogado` + `revogado_em` + `ultimo_erro` null.

---

## 6. Commit sugerido

```
fix(yes-hotel): etapa 3 corrigida — revogado só com delete remoto confirmado

- Adicionar status pendente_limpeza ao enum (migration 0014)
- Sucesso delete: revogado + revogado_em + ultimo_erro null
- Falha delete: pendente_limpeza + ultimo_erro (não revogado_em)
- getItensPendentesLimpeza por pendente_limpeza e remote_keyboard_pwd_id not null
- Contagens separadas: itensRevogados vs itensPendentesLimpeza
- Item sem remote_keyboard_pwd_id: encerramento apenas local (doc + comentários)
- retry_sync (app) usa getItensPendentesLimpeza para credencial revogada
```
