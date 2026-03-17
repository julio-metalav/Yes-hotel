# Limpeza em massa de senhas TTLock vencidas — Diagnóstico (sem implementação)

## 1. Identificação segura dos elegíveis

### Tabelas envolvidas

- **`public.operacional_credencial_itens`** (itens por fechadura):
  - `id`, `credencial_id`, `lock_id_ttlock`, `codigo_logico_destino`, `status_provisionamento`, `remote_keyboard_pwd_id`, `revogado_em`, `ultimo_erro`, `provisionado_em`
- **`public.operacional_credenciais_acesso`** (credencial por reserva):
  - `id`, `reserva_id`, `status`, `valido_de`, `valido_ate`, `revogado_em`, `motivo_revogacao`

A data/hora final de validade da senha está na **credencial**: `operacional_credenciais_acesso.valido_ate` (ex.: dia do checkout às 11h). Não existe `valido_ate` no item; o item herda a janela da credencial.

### Critérios seguros

| Critério | Onde | Regra |
|----------|------|--------|
| `remote_keyboard_pwd_id` preenchido | `operacional_credencial_itens` | `remote_keyboard_pwd_id IS NOT NULL` |
| `status_provisionamento` | `operacional_credencial_itens` | `IN ('provisionado', 'pendente_limpeza')` — **exclui** `revogado` |
| Data/hora final de validade | `operacional_credenciais_acesso.valido_ate` | `valido_ate < (now() - interval '2 hours')` (janela conservadora 2h) |
| Já revogados | `operacional_credencial_itens` | `status_provisionamento = 'revogado'` → **não** elegíveis |
| Pendente de limpeza | `operacional_credencial_itens` | `status_provisionamento = 'pendente_limpeza'` → elegíveis se `valido_ate` passou há 2h |
| Futuras (não tocar) | `operacional_credenciais_acesso` | `valido_ate >= now() - interval '2 hours'` → **excluídas** pelo filtro em `valido_ate` |

Segurança: quem entra na lista são **apenas** itens com passcode remoto, em estado `provisionado` ou `pendente_limpeza`, cuja credencial tem `valido_ate` há pelo menos 2 horas no passado. Itens já `revogado` e credenciais ainda “futuras” ficam de fora.

### Confirmação de timezone (premissa na comparação)

- **Schema:** Em `supabase/migrations/0006_yes_hotel_operacional_credenciais_provisionamento.sql`, a coluna `operacional_credenciais_acesso.valido_ate` é definida como **`timestamptz not null`**.
- **Premissa usada na comparação:** No PostgreSQL, `timestamptz` é armazenado em UTC; `now()` no servidor retorna valor em UTC (ou convertido de acordo com o timezone da sessão). O script usa um cutoff em UTC: `now - 2 horas` calculado em JavaScript (`new Date(Date.now() - 2*60*60*1000).toISOString()`), enviado ao Supabase como filtro `.lt('valido_ate', cutoffIso)`. Assim, a comparação é feita em UTC de forma consistente: só entram credenciais cujo `valido_ate` (fim da validade/checkout) já passou há pelo menos 2 horas em relação ao instante atual (UTC).
- **Documentação no script:** O cabeçalho de `scripts/cleanup-ttlock-expired.ts` documenta explicitamente essa premissa; o script imprime no início a mensagem e o cutoff usado.

---

## 2. SELECT de dry-run

Query de conferência que lista **somente** itens elegíveis para limpeza em massa:

```sql
SELECT
  i.id,
  i.credencial_id,
  i.codigo_logico_destino,
  i.remote_keyboard_pwd_id,
  i.status_provisionamento,
  c.valido_ate AS valido_ate_credencial,
  i.revogado_em,
  i.ultimo_erro
FROM public.operacional_credencial_itens i
JOIN public.operacional_credenciais_acesso c
  ON c.id = i.credencial_id
WHERE i.remote_keyboard_pwd_id IS NOT NULL
  AND i.status_provisionamento IN ('provisionado', 'pendente_limpeza')
  AND c.valido_ate < (now() - interval '2 hours')
ORDER BY c.valido_ate ASC, i.credencial_id, i.codigo_logico_destino;
```

Colunas entregues:

- `id` — PK do item
- `credencial_id` — credencial do item
- `codigo_logico_destino` — ex.: APT-01, GATE-1947-EXTERNAL
- `remote_keyboard_pwd_id` — id do passcode na TTLock
- `status_provisionamento` — provisionado ou pendente_limpeza
- `valido_ate_credencial` — data/hora final de validade da senha (e de checkout)
- `revogado_em` — nulo para elegíveis (revogados já estão fora pelo filtro)
- `ultimo_erro` — preenchido quando status = pendente_limpeza

---

## 3. Estratégia mínima e segura de execução

- **Abordagem:** script em `scripts/` (Node/tsx), que usa a mesma lógica de delete já usada no app (TtlockClient + repositório Supabase). Sem delete cego e sem só atualizar banco: chama a API TTLock de delete e, em seguida, atualiza o item no banco.
- **Reuso:** `TtlockClient.deleteKeyboardPassword` (form-urlencoded, retry já existente) e `ProvisioningRepository.updateItem` (ou Supabase direto com service role). **Não** chamar `revokeCredencial`/`revokeCredential` para não alterar status da credencial nem fluxo de checkout; apenas “limpar” o passcode remoto e marcar o item como revogado.
- **Modos:**
  - **Dry-run:** executa apenas a query acima (ou equivalente via Supabase no script), lista os itens e o total; não chama TTLock nem atualiza banco.
  - **Execute:** para cada linha elegível, chama `client.deleteKeyboardPassword({ lockId, keyboardPwdId })` e, em sucesso, `updateItem(id, { status_provisionamento: 'revogado', revogado_em: now(), ultimo_erro: null })`; em falha, `updateItem(..., { status_provisionamento: 'pendente_limpeza', ultimo_erro: msg })`.
- **Ordem:** processar por credencial (agrupar itens por `credencial_id`) ou por item; por item é mais simples e igualmente seguro. Opção mínima: iterar por item (evita lógica extra de agrupamento).

---

## 4. Escopo técnico

- **Arquivos a tocar:**
  - **Novo:** `scripts/cleanup-ttlock-expired.ts` (ou nome análogo): lê elegíveis (query acima via Supabase), dry-run ou execução por item usando `getTtlockClient()` e repositório Supabase (ou client Supabase direto para o SELECT e para `updateItem`).
  - **Possível reuso de helper de log:** `scripts/_ttlock-log.ts` (apenas se já existir formato útil; senão, log simples no próprio script).
- **Função real reaproveitada:** `TtlockClient.deleteKeyboardPassword` em `src/lib/integrations/ttlock/client.ts` (já com form-urlencoded e retry). Nenhuma alteração nela; o script só a chama.
- **Operação:** por **item**: para cada linha retornada pelo SELECT, uma chamada `deleteKeyboardPassword` e um `updateItem`. Alternativa: agrupar por `credencial_id` e chamar algo que processe vários itens por credencial — mas a lógica “real” hoje é por item (revokeCredencial percorre itens); manter por item mantém patch mínimo.
- **Comando no terminal (previsto):**
  - Dry-run: `npx tsx scripts/cleanup-ttlock-expired.ts --dry-run` (ou `npm run cleanup:ttlock-expired -- --dry-run`).
  - Execute: `npx tsx scripts/cleanup-ttlock-expired.ts` (ou com `--execute` explícito).

---

## 5. Segurança operacional

- **Futuras não entram:** filtro `c.valido_ate < (now() - interval '2 hours')` exclui qualquer credencial cuja validade ainda não tenha passado há pelo menos 2 horas. Senhas “futuras” (valido_ate no futuro) ficam fora.
- **Itens já revogados não entram:** filtro `i.status_provisionamento IN ('provisionado', 'pendente_limpeza')` exclui explicitamente `revogado`. Nenhum item já limpo entra na lista.
- **Só entram itens realmente vencidos:** a combinação `valido_ate < (now() - interval '2 hours')` + `status_provisionamento IN ('provisionado', 'pendente_limpeza')` + `remote_keyboard_pwd_id IS NOT NULL` garante que só entram itens com passcode remoto e validade já expirada há 2h.
- **Dry-run antes do execute:** o script deve exigir flag explícita para executar (ex.: `--execute`). Sem essa flag, só roda a query e imprime os elegíveis (e contagem), sem chamar TTLock nem atualizar banco. Documentar no próprio script e no README/package.json: “sempre rodar primeiro com --dry-run”.

---

## 6. Entrega final do diagnóstico

### Query dry-run (conferência)

```sql
SELECT
  i.id,
  i.credencial_id,
  i.codigo_logico_destino,
  i.remote_keyboard_pwd_id,
  i.status_provisionamento,
  c.valido_ate AS valido_ate_credencial,
  i.revogado_em,
  i.ultimo_erro
FROM public.operacional_credencial_itens i
JOIN public.operacional_credenciais_acesso c
  ON c.id = i.credencial_id
WHERE i.remote_keyboard_pwd_id IS NOT NULL
  AND i.status_provisionamento IN ('provisionado', 'pendente_limpeza')
  AND c.valido_ate < (now() - interval '2 hours')
ORDER BY c.valido_ate ASC, i.credencial_id, i.codigo_logico_destino;
```

### Estratégia escolhida

- Script Node/tsx em `scripts/` que:
  1. Usa Supabase (service role) para executar a lógica da query acima (SELECT em `operacional_credencial_itens` + join com `operacional_credenciais_acesso`).
  2. Dry-run: apenas lista os itens e o total; não chama TTLock nem atualiza banco.
  3. Execute: para cada item elegível, chama `TtlockClient.deleteKeyboardPassword` e em seguida atualiza o item (`revogado` + `revogado_em` em sucesso; `pendente_limpeza` + `ultimo_erro` em falha). Processamento por item.
  4. Reaproveita apenas `getTtlockClient()` e repositório Supabase (ou client Supabase para SELECT + update); não altera fluxo de revogação da credencial.

### Arquivos que seriam alterados/criados

- **Criar:** `scripts/cleanup-ttlock-expired.ts` (script novo).
- **Opcional:** `package.json` — adicionar script `"cleanup:ttlock-expired": "tsx scripts/cleanup-ttlock-expired.ts"` para facilitar o comando.
- **Não alterar:** `src/lib/integrations/ttlock/client.ts`, Edge Function, credential-lifecycle; apenas uso da API e do banco no script.

### Comandos exatos

- **Dry-run geral**
  ```bash
  cd "D:\Automação_Yes_Hotel"
  npx tsx scripts/cleanup-ttlock-expired.ts --dry-run
  ```
  ou: `npm run cleanup:ttlock-expired -- --dry-run`

- **Dry-run com limit**
  ```bash
  npx tsx scripts/cleanup-ttlock-expired.ts --dry-run --limit 5
  ```

- **Dry-run por credencial (teste pontual)**
  ```bash
  npx tsx scripts/cleanup-ttlock-expired.ts --dry-run --credencial-id <uuid>
  ```

- **Execute com limit**
  ```bash
  npx tsx scripts/cleanup-ttlock-expired.ts --execute --limit 10
  ```

- **Execute geral**
  ```bash
  npx tsx scripts/cleanup-ttlock-expired.ts --execute
  ```
  Sem `--execute`, o script roda em dry-run por padrão.

### Principais riscos antes de implementar

1. **Fuso horário:** `now()` no banco é do servidor (geralmente UTC). Garantir que o ambiente de execução (e o Supabase) usem o mesmo fuso ou que “2 hours ago” seja interpretado de forma consistente (ex.: usar UTC em todo o fluxo).
2. **Volume:** muitas linhas elegíveis podem gerar muitas chamadas à API TTLock; considerar limite por execução (ex.: processar no máximo N itens ou N credenciais) ou throttle entre chamadas para evitar rate limit.
3. **Idempotência:** chamar delete para um passcode já removido na TTLock pode retornar erro; o script deve tratar erro de “já inexistente” como sucesso (marcar item como revogado) se a API permitir, ou documentar que itens em `pendente_limpeza` podem ser reprocessados.
4. **Credencial não revogada:** o script não altera `operacional_credenciais_acesso.status` nem `revogado_em` da credencial; itens passam a `revogado` mas a credencial pode continuar “provisionada”. Isso é intencional (só limpeza de senhas vencidas). Se no futuro for necessário alinhar status da credencial, isso pode ser um segundo passo.
5. **Ambiente:** o script precisa de `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e variáveis TTLock; documentar e validar no dry-run (ex.: checar TTLock configurado antes de executar).

---

## 7. Implementação e segurança antes da primeira execução real

**Implementado em:** `scripts/cleanup-ttlock-expired.ts`, com flags `--dry-run`, `--execute`, `--limit N` e `--credencial-id <id>`, e resumo final (total elegíveis, processados, sucesso, falha, ignorados, duração).

### Observações de segurança antes da primeira execução real

1. **Sempre rodar dry-run antes:** Executar primeiro `--dry-run` (e, se quiser, `--dry-run --limit 5`) e conferir que a lista contém apenas itens realmente vencidos (valido_ate antigo, não reservas ativas).
2. **Validar timezone:** Verificar no output do script o “Cutoff usado” (UTC). Se o Supabase estiver em outro fuso, a comparação continua correta porque `valido_ate` é timestamptz (armazenado em UTC).
3. **Testar com --limit e --credencial-id:** Na primeira vez, usar `--execute --limit 1` ou `--execute --credencial-id <uuid>` para validar em um item só antes de rodar execute geral.
4. **Envs:** Confirmar `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e TTLock (`TTLOCK_CLIENT_ID`, `TTLOCK_CLIENT_SECRET`, `TTLOCK_USERNAME`, `TTLOCK_PASSWORD`) no ambiente onde o script será executado.
5. **Resumo final:** Após o execute, conferir o resumo (sucesso vs falha); itens em falha ficam em `pendente_limpeza` e podem ser reprocessados depois (ex.: pelo script de retry existente ou nova execução deste script).
