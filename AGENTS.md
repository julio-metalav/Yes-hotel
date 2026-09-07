# AGENTS.md — Yes Hotel

Regras de trabalho para agentes de IA (Claude Code, Cursor, Codex) neste repositorio.
Em conflito entre este arquivo e qualquer regra local, **prevalece este arquivo**.

---

## 1. O que este sistema controla

O Yes Hotel automatiza a operacao de um hotel real, em funcionamento. Diferente de um
CRUD comum, boa parte do codigo aqui produz **efeito fisico ou financeiro imediato**:

| Modulo | Efeito no mundo real |
|---|---|
| **TTLock** | Abre, tranca, provisiona e revoga **fechadura de apartamento**. Hospede dentro. |
| **HITS / Hospedin (PMS)** | Reserva, check-in, check-out, troca de apartamento |
| **Pagar.me** | Cobranca de hospede |
| **DigiSac / WhatsApp** | Mensagem no celular do hospede |
| **Financeiro (OFX, Omie, Sicredi)** | Conciliacao bancaria e contas a pagar/receber |
| **FNRH** | Ficha Nacional de Registro de Hospedes — dado pessoal sob LGPD |

**Consequencia pratica:** um erro aqui nao gera um bug, gera um hospede trancado do
lado de fora as 23h, uma cobranca indevida ou uma mensagem constrangedora enviada a um
cliente. Trate cada mudanca com esse peso.

---

## 2. Autoridade e limites

1. **Nunca faca commit, push, merge ou PR sem ordem explicita do Julio.** "Pode continuar"
   nao e ordem de push. Se houver duvida, pergunte.
2. **Nunca execute acao real de TTLock, Pagar.me, DigiSac, HITS ou Supabase de producao.**
   Esses comandos estao bloqueados nos perfis do Claude (`.claude/profiles/README.md`) e
   o bloqueio nao deve ser contornado. Se um teste exige um deles, **descreva o comando e
   entregue para o Julio rodar** — nao rode.
3. **Nunca leia `.env`, chaves ou `.docx`.** Se precisar saber quais variaveis existem,
   liste **nomes**, nunca valores.
4. **Escopo e literal.** Se o pedido e "corrija a funcao X", nao reformate o arquivo,
   nao renomeie nada em volta, nao "aproveite para" arrumar outra coisa.
5. **Nao crie clone paralelo, repositorio novo por modulo, pasta `v0-*` permanente nem
   copia independente para homologacao.** Regra definitiva: **1 projeto = 1 repositorio**.
   Repositorio oficial: `julio-metalav/Yes-hotel`.
6. **Material historico fica fora do repo ativo**, em `C:\Projetos\_ARQUIVO_PERMANENTE`.

---

## 3. Banco de dados (Supabase)

- Ha **dois projetos**: PROD e HOMO. Confundi-los ja custou caro.
- **Nunca use `--linked`** em comando de migration: a CLI local esta apontada para
  **PROD**. Use sempre `--project-ref <ref>` explicito.
- `migration repair` mexe apenas no **ledger** (`supabase_migrations.schema_migrations`),
  nao executa SQL — mas isso nao o torna inofensivo: um ledger errado faz o proximo
  `db push` rodar ou pular o SQL errado.
- Migration ja aplicada em producao e **imutavel**. Corrigiu-se algo? Nova migration.
- O estado reconciliado esta documentado em `docs/DB_SCHEMA_CANONICO.md`. Ele abre com
  um aviso de **nao reaplicar**. Leia antes de propor qualquer coisa de schema.

---

## 4. TTLock — o modulo mais perigoso

- Os scripts `debug:ttlock-provision`, `debug:ttlock-revoke`, `debug:ttlock-update-validity`,
  `debug:ttlock-reprovision`, `debug:ttlock-lifecycle`, `debug:ttlock-retry-pending`,
  `cleanup:ttlock-expired` e `diagnose:yes:ttlock-change-400` **mutam fechadura real**.
- `debug:ttlock-auth` e os `test:yes:ttlock-*` sao de leitura/teste, mas **falam com a
  API real da TTLock** — consomem cota e podem disparar rate limit.
- Revogar acesso no TTLock **nao cancela a reserva no PMS**. Sao sistemas separados. Nunca
  descreva um como se implicasse o outro (ver `docs/YES_HOTEL_TTLOCK_HOMOLOGACAO_REAL_CHECKLIST.md`).
- Ao mexer em codigo de provisionamento, preserve os invariantes de **idempotencia**
  (`idempotency_key`) e de **retry**. Sao a unica protecao contra provisionar duas vezes.

---

## 5. Dados pessoais

Reservas, FNRH e fixtures contem nome, CPF, passaporte, e-mail e telefone de pessoas reais.

- **Nunca versione dado real.** Fixtures vao anonimizadas (`fixtures/mock-hospedin.json`
  e a referencia).
- **Nunca imprima PII no transcript** — nem "so para conferir".
- Script local com PII nao entra no repo: vai para `_ARQUIVO_PERMANENTE`.

---

## 6. Antes de mexer no codigo

1. Leia o arquivo inteiro antes de editar um trecho dele.
2. Verifique se o comportamento ja esta coberto por um `test:yes:*` ou `test:hits:*`.
3. `ui/*.js` sao arquivos servidos direto ao browser, sem build. Nao use sintaxe que o
   `node --check` de `npm run test:ui-static-js` rejeite.
4. `supabase/functions/**` roda em **Deno**, nao em Node. Imports precisam de extensao.

---

## 7. Verificacao — o minimo antes de entregar

```
npm run typecheck
npm run test:ui-static-js
```

Mais os testes especificos da area tocada. **Nunca declare "testado" o que nao rodou.**
Se um teste nao pode rodar (exige credencial, exige rede, exige fechadura), diga isso
explicitamente em vez de omitir.

---

## 8. Padrao de entrega

Toda entrega termina com:

1. **Diagnostico** — o que estava errado e por que
2. **Arquivos alterados** — caminho e o que mudou em cada um
3. **O que foi preservado** — comportamento que voce checou que nao quebrou
4. **Como testar** — comandos exatos
5. **Riscos e o que ficou de fora**
6. **Comando de commit sugerido** — sugerido, nao executado

Relate o resultado como ele foi. Teste que falhou, falhou. Etapa pulada, pulada.
Nao arredonde para cima.
