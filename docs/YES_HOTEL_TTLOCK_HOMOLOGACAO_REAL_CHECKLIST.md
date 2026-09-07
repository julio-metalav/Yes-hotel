# Yes Hotel — Checklist de homologação real TTLock

Checklist executável para validar o ciclo de vida TTLock com **ambiente real** (fechaduras, gateway, Supabase e painel). Use este documento durante os testes e preencha com dados reais (anonimizados se necessário).

---

## Pré-requisitos gerais

- [ ] Migration 0008 e 0009 aplicadas no Supabase.
- [ ] Variáveis TTLock configuradas (TTLOCK_CLIENT_ID, TTLOCK_CLIENT_SECRET, TTLOCK_USERNAME, TTLOCK_PASSWORD) no ambiente que executa o lifecycle (Edge Function ou script).
- [ ] Gateway TTLock operacional e fechaduras com passcode V4.
- [ ] Pelo menos uma reserva no banco com credencial provisionada (acesso liberado e provisionamento concluído).

---

## Cenário 1 — Cancelamento

### Pré-condições

- Reserva com credencial ativa (status = ativa, itens provisionados no TTLock).
- Anotar: **reserva_id** = _________________ | **credencial_id** = _________________ | **apartamento** = _____.

### Comando / como executar

**Via painel (Fase 3.2):** Abrir o detalhe da reserva → botão "Revogar acesso TTLock (exceção — não cancela no PMS)" → confirmar.

**Via script (homologação sem painel):**

```bash
npm run debug:ttlock-lifecycle -- cancellation <reserva_id>
```

Substituir `<reserva_id>` pelo UUID da reserva.

### O que esperar no banco

- `operacional_credenciais_acesso`: `status` = `revogada`, `revogado_em` preenchido, `motivo_revogacao` = `cancelamento`.
- `operacional_credenciais_itens`: todos os itens da credencial com `status_provisionamento` = `revogado`, `revogado_em` preenchido.
- Se houve sucesso remoto total: `sync_status` = `ok`. Se TTLock indisponível: `sync_status` = `pending`. Se falha em algum item: `sync_status` = `partial` ou `failed`, `last_sync_error` preenchido.

### O que esperar no TTLock remoto

- Passcode da reserva **removido** da(s) fechadura(s). Conferir no app TTLock ou via API se o passcode não aparece mais para o lock.

### O que esperar em sync_status

| Situação              | sync_status |
|-----------------------|------------|
| Todos os itens revogados no TTLock | `ok`       |
| TTLock indisponível   | `pending`  |
| Alguns itens falharam | `partial`  |
| Todos falharam        | `failed`   |

### Se der pending / partial / failed

1. Verificar `last_sync_error` na credencial (painel ou consulta direta).
2. Executar retry manual:  
   `npm run debug:ttlock-retry-pending -- <credencial_id>`  
   ou pelo painel: botão "Reprocessar sincronização" no detalhe da reserva.
3. Conferir gateway e conectividade TTLock; corrigir e rodar retry novamente.

### Resultado da sua homologação (preencher)

- [ ] Executado em: _______________
- [ ] Reserva/credencial usada: _______________
- [ ] Itens afetados: _____ | Revogados no remoto: _____ | Falhas: _____
- [ ] sync_status final: _______________
- [ ] Precisou retry? Sim / Não. Se sim, resultado após retry: _______________
- [ ] Observações: _______________

---

## Cenário 2 — Checkout

### Pré-condições

- Reserva com credencial ativa (hóspede com acesso liberado).
- Anotar: **reserva_id** = _________________ | **credencial_id** = _________________.

### Comando / como executar

**Via painel:** Detalhe da reserva → "Checkout (revogar acesso TTLock)" → confirmar.

**Via script:**

```bash
npm run debug:ttlock-lifecycle -- checkout <reserva_id>
```

### O que esperar no banco

- Credencial: `status` = `revogada`, `motivo_revogacao` = `checkout`, `revogado_em` preenchido.
- Itens: `status_provisionamento` = `revogado`.
- `sync_status` conforme tabela do cenário 1.

### O que esperar no TTLock remoto

- Passcode removido da(s) fechadura(s).

### Se der pending / partial / failed

- Mesmo procedimento do cenário 1: ver `last_sync_error`, executar retry manual (script ou painel).

### Resultado da sua homologação (preencher)

- [ ] Executado em: _______________
- [ ] Reserva/credencial: _______________
- [ ] sync_status final: _______________
- [ ] Precisou retry? _______________
- [ ] Observações: _______________

---

## Cenário 3 — Late check-out (estender validade)

### Pré-condições

- Reserva com credencial ativa.
- Anotar: **credencial_id** = _________________ | **novo_valido_ate** (ISO) = _________________.

### Comando

```bash
npm run debug:ttlock-lifecycle -- late-checkout <credencial_id> <novo_valido_ate_ISO>
```

Exemplo: `npm run debug:ttlock-lifecycle -- late-checkout <uuid> 2025-03-23T14:00:00Z`

### O que esperar no banco

- Credencial e itens com `valido_ate` atualizado.
- `sync_status` = `ok` se TTLock aceitou em todos os itens; caso contrário `partial`/`failed` e `last_sync_error` preenchido.

### O que esperar no TTLock remoto

- Passcode com nova data de fim de validade.

### Se der pending / partial / failed

- Retry: `npm run debug:ttlock-retry-pending -- <credencial_id>`.

### Resultado da sua homologação (preencher)

- [ ] Executado em: _______________
- [ ] sync_status final: _______________
- [ ] Observações: _______________

---

## Cenário 4 — Room change (troca de apartamento)

### Pré-condições

- Reserva com credencial ativa em um apartamento.
- Definir **novo apartamento** (ex.: 12).
- Anotar: **reserva_id** = _________________ | **apartamento_atual** = _____ | **novo_apartamento** = _____.

### Comando

```bash
npm run debug:ttlock-lifecycle -- room-change <reserva_id> <novo_apartamento>
```

Exemplo: `npm run debug:ttlock-lifecycle -- room-change <uuid> 12`

### O que esperar no banco

- Itens do apartamento antigo: `status_provisionamento` = `revogado`.
- Novos itens criados para o novo apartamento e provisionados (mesmo passcode).
- Credencial continua ativa; validade mantida.

### O que esperar no TTLock remoto

- Passcode removido do(s) lock(s) do apartamento antigo.
- Passcode ativo no(s) lock(s) do novo apartamento (e portões do bloco, se aplicável).

### Se der falhas

- Ver erros no retorno do script; reprocessar pendências com `npm run debug:ttlock-retry-pending -- <credencial_id>` se houver sync pendente.

### Resultado da sua homologação (preencher)

- [ ] Executado em: _______________
- [ ] Revogados: _____ | Provisionados: _____ | Falhas: _____
- [ ] Observações: _______________

---

## Comandos rápidos de retry

```bash
# Todas as credenciais com pendência
npm run debug:ttlock-retry-pending

# Uma credencial específica
npm run debug:ttlock-retry-pending -- <credencial_id>
```

---

## Evidências sugeridas para documentar

Para cada cenário (principalmente cancelamento e checkout), registrar:

1. Reserva/credencial usada (ID anonimizado se necessário).
2. Itens afetados e resposta do TTLock (sucesso/erro por item).
3. Estado final no banco (status da credencial, sync_status, last_sync_error).
4. Se foi necessário retry e resultado após retry.
5. Qualquer limitação real encontrada (ex.: gateway lento, timeout, mensagem de erro específica).

Essas evidências podem ser coladas neste doc ou em um anexo (ex.: `docs/YES_HOTEL_TTLOCK_HOMOLOGACAO_EVIDENCIAS.md`).
