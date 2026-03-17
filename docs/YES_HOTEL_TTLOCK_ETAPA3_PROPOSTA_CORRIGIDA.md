# Etapa 3 — Proposta corrigida (estados honestos)

## 1. Valores de `status_provisionamento` hoje

**Tipo no banco** (`operacional_item_provisionamento_status`, migration 0006):

- `pendente`
- `provisionando`
- `provisionado`
- `falhou`
- `revogado`

**Uso atual:**  
`revogado` é usado tanto quando o delete remoto teve sucesso quanto quando falhou (com a alteração errada da Etapa 3).  
A regra correta: **`revogado` = apenas quando o delete remoto for confirmado.**

---

## 2. Ajuste mínimo proposto

- **Incluir um único valor novo no enum:** `pendente_limpeza`.
- **Semântica:**
  - **`revogado`** — Delete remoto confirmado. Só nesse caso preencher `revogado_em`.
  - **`pendente_limpeza`** — Conceitualmente “fora de uso” (ex.: checkout feito, senha já expirada), mas delete remoto **ainda não confirmado**. Pode ser “aguardando limpeza” ou “última tentativa falhou”; isso se distingue por `ultimo_erro` (null = ainda não tentamos / aguardando; preenchido = erro na última tentativa).

Distinção desejada, mapeada em estado + campos:

| Conceito desejado | Estado no item | Campos |
|-------------------|----------------|--------|
| 1. Expirado | Derivado (ex.: credencial `valido_ate` &lt; now) | — |
| 2. Pendente de limpeza remota | `pendente_limpeza` | `ultimo_erro` null (ou ainda não tentamos) |
| 3. Erro de limpeza remota | `pendente_limpeza` | `ultimo_erro` preenchido |
| 4. Revogado/removido com sucesso | `revogado` | `revogado_em` preenchido, `ultimo_erro` null |

Ou seja: **um único status novo** (`pendente_limpeza`) cobre “pendente de limpeza” e “erro de limpeza”; a diferença é só se `ultimo_erro` está ou não preenchido.  
**Migração:** uma migration que só adiciona o valor ao enum (ex.: `ALTER TYPE ... ADD VALUE 'pendente_limpeza'`).

---

## 3. Arquivos a corrigir

| Arquivo | Ajuste |
|---------|--------|
| **Nova migration** (ex.: `0014_yes_hotel_item_pendente_limpeza.sql`) | `ALTER TYPE operacional_item_provisionamento_status ADD VALUE 'pendente_limpeza';` |
| **`src/lib/application/yes-hotel/types.ts`** | Incluir `"pendente_limpeza"` em `OperacionalItemProvisionamentoStatus`. |
| **`supabase/functions/yes-hotel-lifecycle/index.ts`** | Em falha do delete: setar `status_provisionamento: "pendente_limpeza"`, `ultimo_erro: msg`, **não** setar `revogado_em`. Em sucesso: manter `status: "revogado"`, `revogado_em: now`, `ultimo_erro: null`. `getItensPendentesLimpeza`: filtrar por `status_provisionamento = 'pendente_limpeza'` e `remote_keyboard_pwd_id` não nulo (em vez de `revogado` + `ultimo_erro`). Itens sem `remote_keyboard_pwd_id` no checkout: continuar podendo marcar como `revogado` + `revogado_em` (não há delete remoto a confirmar). |
| **`src/lib/application/yes-hotel/credential-lifecycle.ts`** | Em falha do delete: setar `status_provisionamento: "pendente_limpeza"`, `ultimo_erro: msg`, **não** setar `revogado_em`. Em sucesso: manter `status: "revogado"`, `revogado_em: now`, `ultimo_erro: null`. |
| **`src/lib/application/yes-hotel/credential-lifecycle-status.ts`** | Tratar `pendente_limpeza`: ex.: novo campo `itensPendentesLimpeza` (count de itens com `status_provisionamento === "pendente_limpeza"`). Manter `itensRevogados` só para `revogado`. |
| **`src/lib/application/yes-hotel/supabase-provisioning-repo.ts`** (e tipos de item onde aplicável) | Garantir que o tipo/interface do item aceita `status_provisionamento: "pendente_limpeza"` (já virá do tipo em `types.ts`). |

Nenhuma alteração de contrato da API (formato request/response) além do que o backend persiste.

---

## 4. Comportamento exato por cenário

- **Sucesso no delete**  
  - `status_provisionamento` = `"revogado"`  
  - `revogado_em` = now  
  - `ultimo_erro` = null  

- **Senha expirada / aguardando limpeza**  
  - Item em `"pendente_limpeza"` (após checkout, quando o delete ainda não foi confirmado).  
  - Se ainda não houve tentativa de delete (ex.: job futuro): `ultimo_erro` = null.  
  - Se já houve tentativa e deu certo depois: item passa para `"revogado"` + `revogado_em` conforme acima.  

- **Falha no delete**  
  - `status_provisionamento` = `"pendente_limpeza"`  
  - `ultimo_erro` = mensagem do erro  
  - **Não** setar `revogado_em`; **não** setar `status_provisionamento` = `"revogado"`.  

- **Item sem `remote_keyboard_pwd_id` (não há delete remoto)**  
  - No checkout/revogação: pode seguir como hoje com `status_provisionamento` = `"revogado"` e `revogado_em` = now (não há “confirmação remota” a esperar).

---

## 5. Impacto em telas e consultas atuais

- **Filtros por `revogado`**  
  - Continuam corretos: só itens com delete remoto **confirmado** ficam em `revogado`.  
  - Itens que antes (com o bug) eram marcados como `revogado` em falha passam a ser `pendente_limpeza`; portanto **deixam de contar como revogados**.  

- **`credential-lifecycle-status.ts`**  
  - `itensRevogados`: apenas `status_provisionamento === "revogado"` — número “honesto” de itens realmente removidos no TTLock.  
  - Novo: `itensPendentesLimpeza` para `status_provisionamento === "pendente_limpeza"`.  
  - Telas que hoje só usam `itensRevogados` continuam funcionando; podem passar a exibir “pendentes de limpeza” quando existir campo/UI para isso.  

- **Resumo / sync (ex.: `getSyncSummary`, `getReservationCredentialSyncSummary`)**  
  - Podem incluir contagem de itens `pendente_limpeza` no resumo (ex.: “X itens pendentes de limpeza remota”) para não quebrar e dar visibilidade.  

- **Edge: `getItensPendentesLimpeza` e retry**  
  - Passam a buscar itens com `status_provisionamento = 'pendente_limpeza'` e `remote_keyboard_pwd_id` não nulo (em vez de `revogado` + `ultimo_erro`).  
  - Comportamento de retry e de `list_pending_cleanup` permanece o mesmo do ponto de vista funcional; só o critério de “pendente” muda para o novo status.  

- **UI (ex.: checkin-operacional-mvp.js)**  
  - Não depende diretamente do enum de itens; usa respostas da API. Se a API passar a expor `itensPendentesLimpeza` e/ou `syncStatus`/resumo que considerem `pendente_limpeza`, a tela pode continuar igual ou ganhar mensagem do tipo “X itens pendentes de limpeza” sem quebrar.  

**Resumo de impacto:**  
- Nenhuma tela precisa quebrar.  
- Contagem de “revogados” fica correta (só delete confirmado).  
- Novo status e novo count (`itensPendentesLimpeza`) permitem distinguir claramente “revogado” de “pendente/erro de limpeza”.
