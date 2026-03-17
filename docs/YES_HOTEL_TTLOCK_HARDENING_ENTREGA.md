# Yes Hotel — Hardening TTLock — Entrega

## 1. Diagnóstico inicial (resumo)

- **Arquivos alterados:** `supabase/functions/yes-hotel-lifecycle/index.ts`, `src/lib/integrations/ttlock/client.ts`, `src/lib/integrations/ttlock/lifecycle-log.ts`, `src/lib/application/yes-hotel/credential-lifecycle.ts`, `src/lib/application/yes-hotel/provisioning-executor.ts`, `src/lib/integrations/ttlock/index.ts`; docs e diagnóstico.
- **Provision/delete:** Edge: `handleLifecycleProvision` → `ttlockAddKeyboardPassword`; `revokeCredencial` → `ttlockDeleteKeyboardPassword`. App: `processarCredencialDeAcesso` → `client.createKeyboardPassword`; `revokeCredential` → `client.deleteKeyboardPassword`.
- **Logs antes:** Edge com `console.log` esparsos; app sem log estruturado TTLock.
- **status_provisionamento:** `pendente` | `provisionando` | `provisionado` | `falhou` | `revogado`. Passamos a setar `revogado` + `revogado_em` + `ultimo_erro` quando o delete falha (estado explícito de falha de limpeza).
- **Job/cron:** Não há pg_cron; existe script `debug-ttlock-retry-pending`. Base preparada com `list_pending_cleanup` e retry de itens pendentes dentro de `revokeCredencial`.
- **Etapa 4:** Opção B — contrato em `docs/YES_HOTEL_TTLOCK_CONTRATO_API.md`; Edge e client mantidos alinhados manualmente (sem shared package).

---

## 2. Implementação por etapa

### Etapa 1 — Log estruturado

- **Alterado:** Helper `logTtlockLifecycle` na Edge (inline) e em `src/lib/integrations/ttlock/lifecycle-log.ts` (app). Logs com prefixo `[TTLOCK_LIFECYCLE]` e objeto JSON: `action`, `source`, `reserva_id`, `credencial_id`, `credencial_item_id`, `codigo_logico_destino`, `remote_keyboard_pwd_id`, `lock_id`, `status` (start|success|error), `error_message`, `timestamp`. Sem secrets.
- **Onde:** Edge: `ttlockDeleteKeyboardPassword`, `ttlockAddKeyboardPassword` (start/success/error). App: `client.deleteKeyboardPassword`, `client.createKeyboardPassword`; `credential-lifecycle.revokeCredential` (revoke por item); `provisioning-executor` (provision por item).
- **Risco:** Baixo; apenas adição de log.
- **Validar:** Fazer provision e checkout e checar logs (Edge e app) por `[TTLOCK_LIFECYCLE]`.

### Etapa 2 — Retry no delete

- **Alterado:** Edge: `ttlockDeleteKeyboardPassword` com loop 1 + 2 retries, delay 800 ms, retry só para erros transitórios (5xx, 429, códigos token/rede). App: `client.deleteKeyboardPassword` com a mesma política.
- **Risco:** Baixo; formato (form-urlencoded) e semântica mantidos; apenas mais tentativas antes de falhar.
- **Validar:** Simular falha transitória (ex.: timeout) e ver no log tentativa 1, retry 1, retry 2 e depois falha final ou sucesso.

### Etapa 3 — Estado visível falha limpeza

- **Alterado:** Quando o delete remoto falha, o item passa a ser atualizado para `status_provisionamento: "revogado"`, `revogado_em: now`, `ultimo_erro: msg` (antes só `ultimo_erro`). Edge e app.
- **Risco:** Baixo; consultas que filtram por `revogado` continuam corretas; itens com erro ficam explícitos como revogado + `ultimo_erro`.
- **Validar:** Forçar falha no delete e conferir no banco item `revogado` com `ultimo_erro` preenchido.

### Etapa 4 — Unificação

- **Alterado:** Criado `docs/YES_HOTEL_TTLOCK_CONTRATO_API.md` (content-type, URLSearchParams, retry delete). Comentário na Edge e no `client.ts` referenciando o doc.
- **Risco:** Nenhum; só documentação e referência.
- **Validar:** Ler o doc e confirmar que Edge e client seguem o descrito.

### Etapa 5 — Limpeza posterior (até 2h)

- **Alterado:** Edge: `getItensPendentesLimpeza(credencialId)` (itens `revogado` + `ultimo_erro` + `remote_keyboard_pwd_id`). `revokeCredencial` também processa esses itens (retry do delete). Nova action `list_pending_cleanup` que devolve credenciais com quantidade de itens pendentes de limpeza. Contrato atualizado com a regra da janela.
- **Risco:** Baixo; `retry_sync` passa a efetivamente tentar de novo o delete nos itens pendentes.
- **Validar:** Checkout com falha no delete; chamar `retry_sync`; verificar que o delete é tentado de novo e que `list_pending_cleanup` lista a credencial até limpar.

---

## 3. Commits sugeridos

Um commit por etapa:

```
feat(yes-hotel): add structured ttlock lifecycle logs
feat(yes-hotel): add retry for ttlock delete
feat(yes-hotel): track expired credentials pending remote cleanup
refactor(yes-hotel): unify ttlock request behavior
feat(yes-hotel): prepare delayed cleanup for expired ttlock passwords
```

---

## 4. Arquivos alterados (lista)

- `supabase/functions/yes-hotel-lifecycle/index.ts` — logs, retry delete, getItensPendentesLimpeza, revokeCredencial processa pendentes, list_pending_cleanup.
- `src/lib/integrations/ttlock/lifecycle-log.ts` — novo; helper de log.
- `src/lib/integrations/ttlock/client.ts` — logs, retry delete, comentário contrato.
- `src/lib/integrations/ttlock/index.ts` — export de lifecycle-log.
- `src/lib/application/yes-hotel/credential-lifecycle.ts` — logs revoke; em falha de delete setar revogado + revogado_em + ultimo_erro.
- `src/lib/application/yes-hotel/provisioning-executor.ts` — logs provision.
- `docs/YES_HOTEL_TTLOCK_HARDENING_DIAGNOSTICO.md` — novo; diagnóstico.
- `docs/YES_HOTEL_TTLOCK_CONTRATO_API.md` — novo; contrato e limpeza.
- `docs/YES_HOTEL_TTLOCK_HARDENING_ENTREGA.md` — este arquivo.

---

## 5. Validação final

1. **Provisionamento:** Provisionar uma reserva (Edge ou app); conferir passcode e itens `provisionado`; logs `[TTLOCK_LIFECYCLE]` com action=provision e status=success.
2. **Checkout:** Fazer checkout; itens devem ir para `revogado` e `ultimo_erro` null; logs com action=delete/revoke e status=success.
3. **Senha às 11h:** Validade da credencial até 11h do dia de checkout; não alterada.
4. **Delete posterior:** Se o delete falhar no checkout, item fica `revogado` com `ultimo_erro`. Chamar `retry_sync` (ou acionar de novo a revogação); o delete deve ser tentado de novo para itens pendentes; em sucesso, `ultimo_erro` é limpo. `list_pending_cleanup` deve listar credenciais com itens pendentes até serem limpos.
5. **Erro TTLock:** Falhas continuam em `ultimo_erro` e em logs com status=error e error_message; sync_status da credencial reflete partial/failed quando houver falhas.
