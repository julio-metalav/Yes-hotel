# Estratégia final de commit — Hardening TTLock (Etapas 1–5)

## 1. As alterações estão limpas para commits separados por etapa?

**Não.** Os mesmos arquivos concentram mudanças de várias etapas:
- `supabase/functions/yes-hotel-lifecycle/index.ts`: etapas 1, 2, 3, 5 + checagem
- `src/lib/integrations/ttlock/client.ts`: etapas 1, 2, 4
- `src/lib/application/yes-hotel/credential-lifecycle.ts`: etapas 1, 3

Separar por etapa exigiria `git add -p` ou edição manual por trecho, gerando histórico artificial e risco de erro.

---

## 2. Estratégia adotada

- **1 commit consolidado** para código + migration do bloco hardening (histórico honesto, um bloco = um commit).
- **1 commit opcional** só para documentação nova do TTLock (facilita revisão e possível revert só de docs).

---

## 3. Estratégia final recomendada (estado real do git)

O `git status` / `git diff --stat` mostram **muitos outros arquivos modificados** (docs PLANO/HITS/COMUNICACAO, scripts, migrations 0004–0008, ui, etc.) que **não** fazem parte do bloco hardening TTLock.

Recomendação:

1. **Não** fazer `git add .` nem `git commit -a`.
2. Fazer **apenas** `git add` dos arquivos listados abaixo (código + migration do hardening).
3. Um **commit único** com mensagem consolidada.
4. Opcionalmente, em seguida, **um segundo commit** só com os docs novos do TTLock (paths listados abaixo).
5. Os demais arquivos modificados/untracked ficam **fora** dos commits do hardening (você pode commitá-los depois em outros commits ou manter locais).

Arquivos que **entram** no commit do hardening (código + migration):

- `supabase/migrations/0014_yes_hotel_item_pendente_limpeza.sql`
- `supabase/functions/yes-hotel-lifecycle/index.ts`
- `src/lib/integrations/ttlock/lifecycle-log.ts`
- `src/lib/integrations/ttlock/client.ts`
- `src/lib/integrations/ttlock/index.ts`
- `src/lib/application/yes-hotel/types.ts`
- `src/lib/application/yes-hotel/credential-lifecycle.ts`
- `src/lib/application/yes-hotel/provisioning-executor.ts`
- `src/lib/application/yes-hotel/supabase-provisioning-repo.ts`
- `src/lib/application/yes-hotel/credential-lifecycle-status.ts`
- `src/lib/application/yes-hotel/index.ts`

Arquivos que **entram** no commit opcional de docs:

- `docs/YES_HOTEL_TTLOCK_CONTRATO_API.md`
- `docs/YES_HOTEL_TTLOCK_ETAPA3_CHECAGEM_SANIDADE.md`
- `docs/YES_HOTEL_TTLOCK_ETAPA3_ENTREGA.md`
- `docs/YES_HOTEL_TTLOCK_ETAPA3_PROPOSTA_CORRIGIDA.md`
- `docs/YES_HOTEL_TTLOCK_HARDENING_CONSOLIDACAO_FINAL.md`
- `docs/YES_HOTEL_TTLOCK_HARDENING_DIAGNOSTICO.md`
- `docs/YES_HOTEL_TTLOCK_HARDENING_ENTREGA.md`
- `docs/YES_HOTEL_TTLOCK_HARDENING_ESTRATEGIA_COMMIT.md`

---

## 4. Comandos exatos

### Ver estado e diff

```bash
cd "D:\Automação_Yes_Hotel"
git status
git diff --stat
```

### Commit 1 — Código + migration (hardening)

```bash
cd "D:\Automação_Yes_Hotel"

git add supabase/migrations/0014_yes_hotel_item_pendente_limpeza.sql
git add supabase/functions/yes-hotel-lifecycle/index.ts
git add src/lib/integrations/ttlock/lifecycle-log.ts
git add src/lib/integrations/ttlock/client.ts
git add src/lib/integrations/ttlock/index.ts
git add src/lib/application/yes-hotel/types.ts
git add src/lib/application/yes-hotel/credential-lifecycle.ts
git add src/lib/application/yes-hotel/provisioning-executor.ts
git add src/lib/application/yes-hotel/supabase-provisioning-repo.ts
git add src/lib/application/yes-hotel/credential-lifecycle-status.ts
git add src/lib/application/yes-hotel/index.ts

git status
git commit -m "feat(yes-hotel): hardening ttlock — logs, retry delete, pendente_limpeza, contrato, list_pending_cleanup"
```

### Commit 2 (opcional) — Docs

```bash
cd "D:\Automação_Yes_Hotel"

git add docs/YES_HOTEL_TTLOCK_CONTRATO_API.md
git add docs/YES_HOTEL_TTLOCK_ETAPA3_CHECAGEM_SANIDADE.md
git add docs/YES_HOTEL_TTLOCK_ETAPA3_ENTREGA.md
git add docs/YES_HOTEL_TTLOCK_ETAPA3_PROPOSTA_CORRIGIDA.md
git add docs/YES_HOTEL_TTLOCK_HARDENING_CONSOLIDACAO_FINAL.md
git add docs/YES_HOTEL_TTLOCK_HARDENING_DIAGNOSTICO.md
git add docs/YES_HOTEL_TTLOCK_HARDENING_ENTREGA.md
git add docs/YES_HOTEL_TTLOCK_HARDENING_ESTRATEGIA_COMMIT.md

git commit -m "docs(yes-hotel): ttlock hardening — contrato, etapa 3, consolidação e estratégia de commit"
```

### Push

```bash
cd "D:\Automação_Yes_Hotel"
git push
```

Se fizer só o Commit 1 e pular o Commit 2, o push é o mesmo: `git push`.

---

## 5. Resumo

- **Um commit** para todo o código e a migration do hardening (histórico honesto, sem separar etapas já misturadas).
- **Um commit opcional** para a documentação do bloco.
- **Nenhum** outro arquivo do repositório é adicionado nesses comandos; o resto do working tree permanece como está para você tratar depois.
