# Etapa 3 — Checagem final de sanidade

## 1. retryCredentialSync

**Como busca os itens elegíveis**
- Primeiro carrega a credencial com `repo.getCredencial(credencialId)`.
- **Se** `credencial.status === "revogada"**: chama `repo.getItensPendentesLimpeza(credencialId)`, que no Supabase filtra por `status_provisionamento = 'pendente_limpeza'` e `remote_keyboard_pwd_id` não nulo. Itera só sobre esses itens e tenta `deleteKeyboardPassword` em cada um.
- **Se** a credencial não está revogada: usa `repo.getItensProvisionados(credencialId)` e tenta `changeKeyboardPassword` (alteração de validade), não delete.

**Confirmação**
- Sim: quando a credencial está revogada, ele opera **apenas** sobre itens em `pendente_limpeza` (via `getItensPendentesLimpeza`).

**Dependência do status "revogada"**
- A dependência é **intencional**: retry para credencial revogada = “concluir delete remoto dos itens que ficaram pendente_limpeza”. Para credencial ativa, o retry é de “atualizar validade” (outro fluxo). Não há ambiguidade semântica.
- **Ajuste:** Nenhum necessário.

---

## 2. Cobertura do status pendente_limpeza

**Busca por usos de status_provisionamento**

| Arquivo | Uso | Cobertura pendente_limpeza |
|---------|-----|----------------------------|
| `src/lib/application/yes-hotel/credential-lifecycle-status.ts` | Filtros por status; contagens; resumo | Sim: `pendentesLimpeza`, `itensPendentesLimpeza`, resumo com "X pendente(s) limpeza". |
| `src/lib/application/yes-hotel/supabase-provisioning-repo.ts` | Select/update; getItensPendentes, getItensProvisionados, getItensPendentesLimpeza | Sim: query explícita por `pendente_limpeza`. |
| `src/lib/application/yes-hotel/provisioning-executor.ts` | Tipos; updateItem com status | Tipo inclui `pendente_limpeza`; nenhum switch que exclua. |
| `src/lib/application/yes-hotel/credential-lifecycle.ts` | revokeCredential, handleRoomChange, retryCredentialSync; filtros provisionado/revogado/pendente_limpeza | Room change: só processa provisionado/falhou (correto). Retry: usa getItensPendentesLimpeza. |
| `supabase/functions/yes-hotel-lifecycle/index.ts` | getItensPendentes, getItensProvisionados, getItensPendentesLimpeza; revokeCredencial; getSyncSummary; provision | getItensPendentesLimpeza por `pendente_limpeza`. getSyncSummary **antes** não incluía "pendente(s) limpeza" no resumo. |
| `supabase/migrations/0006_yes_hotel_operacional_credenciais_provisionamento.sql` | Enum e coluna | Enum atualizado na 0014 com `pendente_limpeza`. |
| `supabase/migrations/0001_yes_hotel_schema_inicial.sql` | Tabela antiga acessos_provisionamentos (check) | Schema antigo; operacional usa 0006. |

**Ponto cego encontrado e correção**
- **Edge `getSyncSummary`:** o resumo não mencionava itens em `pendente_limpeza`, ao contrário do app (`getReservationCredentialSyncSummary`). A UI que chama `sync_summary` (Edge) podia não mostrar “pendentes de limpeza”.
- **Patch aplicado:** em `getSyncSummary` (Edge) foi adicionada a contagem de itens com `status_provisionamento === "pendente_limpeza"` e, quando > 0, a linha `resumo += " | X pendente(s) limpeza"`.

**Arquivos verificados**
- `src/lib/application/yes-hotel/credential-lifecycle-status.ts`
- `src/lib/application/yes-hotel/supabase-provisioning-repo.ts`
- `src/lib/application/yes-hotel/provisioning-executor.ts`
- `src/lib/application/yes-hotel/credential-lifecycle.ts`
- `supabase/functions/yes-hotel-lifecycle/index.ts`
- `supabase/migrations/0006_yes_hotel_operacional_credenciais_provisionamento.sql`
- UI: `ui/checkin-operacional-mvp.js` — não há switch/label por valor de `status_provisionamento`; usa apenas `data.resumo` e badge de sync. Nenhuma quebra.

---

## 3. Item sem remote_keyboard_pwd_id

**Cenários reais no fluxo Yes Hotel**
- **App:** `getItensProvisionados` no repo Supabase usa `.not("remote_keyboard_pwd_id", "is", null)`. Na revogação/retry o app **nunca** recebe item provisionado com `remote_keyboard_pwd_id` nulo.
- **Edge:** `getItensProvisionados` **não** filtra por `remote_keyboard_pwd_id`. Por isso, na Edge pode aparecer item com `status_provisionamento = "provisionado"` e `remote_keyboard_pwd_id` nulo em cenários de inconsistência (ex.: provisionamento que falhou ao persistir o id, dado legado ou edição manual).

**Fluxo esperado ou exceção**
- Exceção / inconsistência. No fluxo normal, após add TTLock bem-sucedido o item é atualizado com `remote_keyboard_pwd_id`; portanto “provisionado” com id nulo indica bug de persistência ou dado fora do fluxo normal.

**Mascaramento de bug**
- Não estamos mascarando: tratamos explicitamente como “encerramento apenas local” (revogado + revogado_em), sem afirmar delete remoto. O risco é **não** tentar delete remoto se o id foi perdido por bug (passcode continuaria ativo na fechadura).

**Salvaguarda aplicada**
- Na Edge, ao entrar no ramo “item.remote_keyboard_pwd_id == null” dentro do loop sobre `getItensProvisionados`, foi adicionado um **log de alerta**: `console.warn("[lifecycle] Item provisionado sem remote_keyboard_pwd_id (credencial_id=... item_id=...). Encerramento apenas local; possível inconsistência de persistência.")`. Assim, qualquer ocorrência fica visível nos logs sem mudar comportamento.

---

## 4. Parecer final

**Podemos seguir para consolidar as etapas 1 a 5.**

- retryCredentialSync está correto e sem ambiguidade; depende de “revogada” por desenho.
- pendente_limpeza está coberto nos filtros, contagens e resumos; o único ponto cego (resumo da Edge) foi corrigido.
- Item sem `remote_keyboard_pwd_id` está documentado e tratado como exceção, com alerta em log na Edge; não há refatoração além do mínimo.

Nenhuma alteração de comportamento desnecessária; apenas checagem e dois patches mínimos (resumo Edge + log de alerta).

---

## 5. Comandos de validação recomendados

**1. Migration**
```bash
cd "D:\Automação_Yes_Hotel"
npx supabase db push
```

**2. Conferir enum no banco**
```sql
SELECT enumlabel FROM pg_enum e
JOIN pg_type t ON e.enumtypid = t.oid
WHERE t.typname = 'operacional_item_provisionamento_status'
ORDER BY enumsortorder;
```
Esperado: `pendente`, `provisionando`, `provisionado`, `falhou`, `revogado`, `pendente_limpeza`.

**3. Fluxo mínimo (manual ou teste E2E)**
- Provisionar uma reserva (Edge ou app) e fazer checkout com sucesso → itens devem ir para `revogado` com `revogado_em` e `ultimo_erro` null.
- Simular falha no delete (ex.: timeout/mock) no checkout → item deve ficar `pendente_limpeza` com `ultimo_erro` preenchido e **sem** `revogado_em`.
- Chamar retry_sync (botão “Reprocessar sincronização” ou action `retry_sync`) → itens `pendente_limpeza` devem ser tentados de novo; em sucesso → `revogado` + `revogado_em` + `ultimo_erro` null.
- Na tela do check-in operacional, abrir uma reserva com credencial e ver o bloco TTLock: o resumo deve poder mostrar “X pendente(s) limpeza” quando houver itens nesse status (após sync_summary).

**4. Log de alerta (opcional)**
- Se existir cenário de teste ou dado com item `provisionado` e `remote_keyboard_pwd_id` nulo, ao fazer checkout pela Edge os logs devem mostrar o warning `[lifecycle] Item provisionado sem remote_keyboard_pwd_id...`.
