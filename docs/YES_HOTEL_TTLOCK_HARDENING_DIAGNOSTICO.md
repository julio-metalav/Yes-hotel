# Yes Hotel — Hardening TTLock — Diagnóstico Inicial

## 1. Arquivos que serão alterados

| Etapa | Arquivo | Alteração |
|-------|---------|-----------|
| 1 | `supabase/functions/yes-hotel-lifecycle/index.ts` | Log estruturado em provision + revoke/delete |
| 1 | `src/lib/integrations/ttlock/client.ts` | Log estruturado em delete (e add se desejado) |
| 1 | `src/lib/application/yes-hotel/credential-lifecycle.ts` | Log estruturado ao chamar delete |
| 1 | `src/lib/application/yes-hotel/provisioning-executor.ts` | Log estruturado ao provisionar |
| 2 | `supabase/functions/yes-hotel-lifecycle/index.ts` | Retry em `ttlockDeleteKeyboardPassword` |
| 2 | `src/lib/integrations/ttlock/client.ts` | Retry em `deleteKeyboardPassword` |
| 3 | Ambos fluxos (Edge + app) | Garantir estado explícito: revogado + ultimo_erro = pendente limpeza / falha limpeza |
| 4 | Documentação + possível helper mínimo | Unificar contrato TTLock (form-urlencoded, retry) |
| 5 | Função/query + script ou job futuro | Itens elegíveis para cleanup (janela 2h pós-checkout) |

## 2. Funções que fazem provisionamento e delete

- **Provisionamento**
  - **Edge:** `handleLifecycleProvision` → `ttlockAddKeyboardPassword` (por item).
  - **App:** `processarCredencialDeAcesso` (provisioning-executor.ts) → `client.createKeyboardPassword` (por item).

- **Delete / revoke**
  - **Edge:** `revokeCredencial` → `ttlockDeleteKeyboardPassword` (por item).
  - **App:** `revokeCredential` (credential-lifecycle.ts) → `client.deleteKeyboardPassword` (por item).
  - Também: room change e `retryCredentialSync` usam `client.deleteKeyboardPassword`.

## 3. Onde estão os logs hoje

- **Edge:** `console.log` com prefixos `[lifecycle]`, `[TTLOCK ...]`, `### DELETE TTLOCK V2 EXECUTANDO ###` em token, add, delete e action.
- **App/client:** Nenhum log específico TTLock no client; credential-lifecycle e provisioning-executor não logam operações TTLock de forma estruturada.
- **Não existe** logger central no projeto; usar prefixo único + objeto estruturado (sem secrets).

## 4. Como `status_provisionamento` está sendo usado

- **Enum (DB):** `pendente` | `provisionando` | `provisionado` | `falhou` | `revogado`.
- **Uso:** Filtros (itens pendentes, provisionados), atualização após provision/revoke. Após revoke: item fica `revogado`; se delete remoto falhar, hoje o item continua com `ultimo_erro` preenchido (e em alguns caminhos do app o status pode não ser atualizado para revogado no mesmo fluxo — credential-lifecycle atualiza para revogado e seta ultimo_erro em falha).
- **Conclusão:** Não é necessário novo enum. `revogado` + `ultimo_erro` não nulo = falha de limpeza / pendente de retry. Basta garantir que sempre setamos `revogado_em` e `ultimo_erro` de forma consistente e que a credencial tenha `sync_status` refletindo pendência.

## 5. Job / cron no projeto

- Existe tabela `jobs_automacao` (migration 0001), mas **não** há pg_cron nem scheduler ativo configurado.
- Script `debug-ttlock-retry-pending.ts` reprocessa credenciais com pendência de sync.
- Para Etapa 5: preparar base (query/função “itens elegíveis para cleanup”) e opcionalmente script ou job futuro, sem scheduler complexo.

## 6. Estratégia mínima segura para Etapa 4 (unificação)

- **Opção A** (um único client canônico): inviável sem refatoração cross-runtime (Edge = Deno, app = Node).
- **Opção B:** Manter duas implementações (Edge + client.ts) e garantir consistência por:
  1. **Documentação de contrato** em um único lugar (ex.: comentário em `client.ts` + doc) com: content-type `application/x-www-form-urlencoded`, uso de `URLSearchParams`, política de retry no delete (1 + 2 retries, delay curto).
  2. **Espelhar** o comportamento no Edge (já está form-urlencoded; adicionar retry na Etapa 2).
  3. **Não** criar shared package; não alterar assinaturas públicas desnecessariamente.
- **Escolha:** Opção B — documentar contrato e manter dois pontos alinhados manualmente (patch mínimo, sem cross-runtime).
