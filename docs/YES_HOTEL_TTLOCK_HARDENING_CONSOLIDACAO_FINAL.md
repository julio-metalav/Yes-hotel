# Yes Hotel — Hardening TTLock (Etapas 1–5) — Consolidação final

## 1. Lista final dos arquivos alterados

### Código e migration

| Arquivo | Etapas |
|---------|--------|
| `supabase/migrations/0014_yes_hotel_item_pendente_limpeza.sql` | 3 (novo enum `pendente_limpeza`) |
| `supabase/functions/yes-hotel-lifecycle/index.ts` | 1, 2, 3, 4, 5 + checagem (logs, retry delete, pendente_limpeza, getItensPendentesLimpeza, list_pending_cleanup, resumo + alerta) |
| `src/lib/integrations/ttlock/lifecycle-log.ts` | 1 (novo) |
| `src/lib/integrations/ttlock/client.ts` | 1, 2, 4 (logs, retry delete, comentário contrato) |
| `src/lib/integrations/ttlock/index.ts` | 1 (export lifecycle-log) |
| `src/lib/application/yes-hotel/types.ts` | 3 (`pendente_limpeza` no tipo) |
| `src/lib/application/yes-hotel/credential-lifecycle.ts` | 1, 3 (logs revoke; pendente_limpeza em falha; room change; retryCredentialSync com getItensPendentesLimpeza) |
| `src/lib/application/yes-hotel/provisioning-executor.ts` | 1, 3 (logs provision; interface getItensPendentesLimpeza) |
| `src/lib/application/yes-hotel/supabase-provisioning-repo.ts` | 3 (getItensPendentesLimpeza) |
| `src/lib/application/yes-hotel/credential-lifecycle-status.ts` | 3 (itensPendentesLimpeza; resumo "pendente(s) limpeza") |
| `docs/YES_HOTEL_TTLOCK_CONTRATO_API.md` | 4, 3 (contrato + item sem passcode remoto) |

### Apenas documentação (sem impacto em runtime)

| Arquivo | Conteúdo |
|---------|----------|
| `docs/YES_HOTEL_TTLOCK_HARDENING_DIAGNOSTICO.md` | Diagnóstico inicial |
| `docs/YES_HOTEL_TTLOCK_HARDENING_ENTREGA.md` | Entrega por etapa |
| `docs/YES_HOTEL_TTLOCK_ETAPA3_PROPOSTA_CORRIGIDA.md` | Proposta Etapa 3 |
| `docs/YES_HOTEL_TTLOCK_ETAPA3_ENTREGA.md` | Entrega Etapa 3 |
| `docs/YES_HOTEL_TTLOCK_ETAPA3_CHECAGEM_SANIDADE.md` | Checagem sanidade |
| `docs/YES_HOTEL_TTLOCK_HARDENING_CONSOLIDACAO_FINAL.md` | Este arquivo |

---

## 2. Commits sugeridos (ordem ideal)

Executar na ordem abaixo, um commit por linha:

```
feat(yes-hotel): add structured ttlock lifecycle logs (etapa 1)
```

```
feat(yes-hotel): add retry for ttlock delete (etapa 2)
```

```
fix(yes-hotel): etapa 3 — revogado só com delete remoto confirmado; add pendente_limpeza
```

```
docs(yes-hotel): unify ttlock contract and cleanup rules (etapa 4)
```

```
feat(yes-hotel): prepare delayed cleanup for expired ttlock passwords (etapa 5)
```

**Nota:** As alterações de código estão misturadas em poucos arquivos (Edge e client têm 1+2+4+5; app tem 1+3). Se preferir um único commit de hardening, use:

```
feat(yes-hotel): hardening ttlock — logs, retry delete, pendente_limpeza, contrato, list_pending_cleanup
```

---

## 3. Comandos exatos

### Revisar diff

```bash
cd "D:\Automação_Yes_Hotel"
git status
git diff --stat
git diff supabase/
git diff src/lib/
git diff docs/YES_HOTEL_TTLOCK_CONTRATO_API.md docs/YES_HOTEL_TTLOCK_HARDENING*.md docs/YES_HOTEL_TTLOCK_ETAPA3*.md
```

### Aplicar migration

```bash
cd "D:\Automação_Yes_Hotel"
npx supabase db push
```

Ou, em ambiente local com migrações aplicadas uma a uma:

```bash
npx supabase migration up
```

### Validação

**1) Enum no banco**

```sql
SELECT enumlabel FROM pg_enum e
JOIN pg_type t ON e.enumtypid = t.oid
WHERE t.typname = 'operacional_item_provisionamento_status'
ORDER BY enumsortorder;
```

Esperado: `pendente`, `provisionando`, `provisionado`, `falhou`, `revogado`, `pendente_limpeza`.

**2) Build/typecheck (se houver)**

```bash
cd "D:\Automação_Yes_Hotel"
npm run build
```

**3) Fluxo manual**

- Provisionar reserva → checkout com sucesso → itens `revogado` + `revogado_em` + `ultimo_erro` null.
- Checkout com falha simulada no delete → item `pendente_limpeza` + `ultimo_erro`; sem `revogado_em`.
- Botão “Reprocessar sincronização” → retry nos itens `pendente_limpeza`; sucesso → `revogado` + `revogado_em`.
- Resumo TTLock na UI deve poder mostrar “X pendente(s) limpeza” quando houver.

---

## 4. Ajustes pendentes antes de commit/push

**Nenhum ajuste de código pendente** para consolidar as etapas 1–5.  
O que foi combinado já está implementado (incluindo resumo Edge com pendente_limpeza e log de alerta para item sem `remote_keyboard_pwd_id`).

Antes de commit/push, é recomendável:

- Rodar `git status` e `git diff` para revisar apenas os arquivos listados no item 1.
- Garantir que a migration 0014 foi aplicada no ambiente alvo antes (ou junto) do deploy da Edge Function e do app.
- Não commitar arquivos de documentação que não queira versionar (se for o caso); a lista do item 1 separa código/migration de docs.

---

## 5. Resumo do comportamento após a consolidação

- **Provisionamento:** Continua igual; logs estruturados `[TTLOCK_LIFECYCLE]` em provision (Edge e app).
- **Checkout/revogação:** Delete remoto com retry (1 + 2 tentativas) e form-urlencoded. **Sucesso** → item `revogado` + `revogado_em` + `ultimo_erro` null. **Falha** → item `pendente_limpeza` + `ultimo_erro`; **não** se preenche `revogado_em`. Item sem `remote_keyboard_pwd_id` → encerramento apenas local (`revogado` + `revogado_em`) + log de alerta na Edge.
- **Senha às 11h:** Regra inalterada; validade por horário.
- **Retry / limpeza posterior:** Credencial revogada com itens `pendente_limpeza` é tratada pelo retry (Edge e app); ação `list_pending_cleanup` lista credenciais com itens pendentes; janela de até ~2h pós-checkout documentada.
- **Visibilidade:** Contagens separadas (revogado vs pendente_limpeza); resumo da Edge e do app incluem “X pendente(s) limpeza” quando houver; falhas continuam em `ultimo_erro` e em logs.
- **Contrato:** Um único documento (`YES_HOTEL_TTLOCK_CONTRATO_API.md`) descreve form-urlencoded, retry no delete e regra para item sem passcode remoto; Edge e client alinhados a ele.

---

## Próximo passo (após consolidar)

Preparar a **rotina segura de limpeza em massa** das senhas TTLock antigas já vencidas, sem afetar senhas futuras. Isso pode usar a base já existente: itens `pendente_limpeza` com `remote_keyboard_pwd_id` e (opcional) filtro por data de expiração/checkout, mais a ação `list_pending_cleanup` e o retry por credencial.
