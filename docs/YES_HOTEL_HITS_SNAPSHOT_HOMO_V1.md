# Yes Hotel — Snapshot operacional HITS (V1, HOMO)

Branch: `feat/hits-snapshot-homo` · Base: `cc8b371` (Merge PR #121, origin/main)
Escopo: HOMO (`kzprrnbafamuozhyikgb`). Nada aqui é aplicado em PROD nesta etapa.

## 1. Problema

A área HITS de `ui/checkin-operacional-mvp.html` lia o HITS **ao vivo** a cada abertura:

```
navegador → Edge hits-reservations-preview → gateway HITS → ~79 GETs sequenciais → resposta só no fim
```

Em PROD isso leva 100–160 s. O gateway de funções do Supabase corta em 150 s (504) e o
front convertia qualquer falha em `[]` → "0 reservas". O scheduler (pg_cron, 5 jobs, a
cada 10 min) já fazia a mesma leitura e **descartava** a resposta.

## 2. Fluxo novo

```
HITS → gateway → Edge hits-reservations-preview (chamada do scheduler)
                     └─ RPC hits_snapshot_sync_start / _apply / _fail  (service_role)
                            └─ public.hits_reservas_snapshot + public.hits_snapshot_sync_state
UI (supabase-js, JWT do usuário, RLS por perfil) → 2 SELECTs locais → grade + barra HITS
```

- **Uma rodada HITS por tick** (a mesma de antes). A Edge não faz segunda leitura.
- A UI **não chama mais a Edge nem o gateway**. Abrir a tela N vezes = 0 requisições ao HITS.
- **Nenhuma escrita no HITS.** A única escrita é no nosso Supabase, via RPC.
- Sem a env `HITS_SNAPSHOT_WRITE_ENABLED=true`, a Edge se comporta exatamente como antes
  (rollback do backend = `secrets unset`; rollback do front = voltar o commit).

## 3. Quando a Edge grava o snapshot (`shouldPersistSnapshot`)

Só quando **todas** valem:

1. `HITS_SNAPSHOT_WRITE_ENABLED` = `true` (exato) no ambiente da Edge;
2. a chamada **não tem** `ids`, `date_from`, `date_to`, `page`, `size` (forma do scheduler:
   janela default, mesma de sempre);
3. o Bearer **não é** uma sessão de usuário (`role=authenticated`). O scheduler usa a anon
   key (`role=anon`); uma chave publishable (não-JWT) também passa. Uma página antiga ainda
   aberta com JWT de usuário nunca grava.

A resposta da Edge ganha o campo `snapshot` (`persisted`, `batch_id`, `status`,
`rows_upserted`, `rows_removed` ou `reason`/`stage`/`error`). Os demais campos são os mesmos.

## 4. Banco (migration `20260924180000_hits_reservas_snapshot.sql`)

### `public.hits_reservas_snapshot` (PK `external_reservation_id`)

| coluna | origem | uso na tela |
|---|---|---|
| `external_reservation_id` | `idReservation` | id sintético `hits-preview:<id>`, busca |
| `apartamento` | `rooms[0].code` normalizado | coluna Apto |
| `hospede_principal` | hóspede principal (só o nome) | coluna Hóspede |
| `check_in`, `check_out` (date) | `rooms[0].checkIn/checkOut` | período, filtros Hoje/7 dias/Este mês, Chegadas |
| `status_reserva` (`ativa`/`cancelada`) | status HITS 2 = cancelada | grade lista só ativas |
| `ciclo_hits` (`confirmada`/`hospedada`) | listagem Status=1 / Status=3 | `entrouNoApto` |
| `total_hospedes` | `rooms[0].pax` ou nº de guests | coluna Hóspedes |
| `source`='hits', `batch_id`, `first_seen_at`, `last_seen_at`, `updated_at` | controle | — |

**Fora, por construção:** documento, telefone, e-mail, valores, pagamento, payload bruto
(allowlist no módulo `toSnapshotRows` e de novo no SQL da RPC).

### `public.hits_snapshot_sync_state` (linha única)

`last_started_at`, `last_started_batch_id`, `last_finished_at`, `last_status`
(`running|ok|partial|error`), `last_error`, `last_stopped_reason`, `last_rows_count`,
`last_failed_count`, `last_success_at`, `last_success_batch_id`, `last_success_rows_count`.

### RPCs (SECURITY DEFINER, `search_path=''`, EXECUTE **só** `service_role`)

- `hits_snapshot_sync_start(batch)` — marca `running`. Não toca linhas.
- `hits_snapshot_sync_apply(batch, rows jsonb, failed_ids text[], status, stopped_reason)` —
  **uma transação**: upsert das linhas do lote; `delete` do que **não veio** neste lote **e não
  está** em `failed_ids`; atualiza o estado (`last_success_at` em `ok` e `partial`).
- `hits_snapshot_sync_fail(batch, erro)` — só registra `error`. **Nunca apaga** a fotografia anterior.

### RLS

- RLS ligado nas duas tabelas; `revoke all ... from public, anon`; `grant select` a `authenticated`.
- Policy SELECT: `is_yes_hotel_ops_reader() or is_yes_hotel_hits_consulta_reader()` — os mesmos
  gates já usados pela tela (admin/recepção e hits_consulta). Sem policy de escrita.
- Escrita só por `service_role` (Edge) através das RPCs.

## 5. UI (`ui/yes-hits-sandbox-preview.js` v5)

- `requestCycle()` faz `from("hits_reservas_snapshot").select(<8 colunas>)` +
  `from("hits_snapshot_sync_state").select(...).maybeSingle()`. Sem `fetch`, sem Edge.
- Mesma API para `checkin-operacional-mvp.js` (`fetchReservasOperacionais`, `onCycle`,
  `loadCycle`, `toReservaOperacional`, `isReadOnlyId`) → grade, filtros, abas, badges e
  guards de somente leitura ficam como estavam.
- Barra HITS (`describeSync`):
  - snapshot recente e ok → badge + "N reservas · sincronizado HH:MM";
  - último ciclo `partial` → idem + "K reserva(s) sem detalhe";
  - último ciclo `error` com fotografia anterior → dados + aviso âmbar
    "última sincronização com HITS falhou — exibindo dados de HH:MM";
  - último sucesso há mais de 30 min → dados + "dados desatualizados — última sincronização HH:MM";
  - nunca sincronizado → "HITS — dados ainda não sincronizados" (vermelho), lista vazia.
  - erro de SELECT (RLS/rede) → "leitura indisponível" (vermelho).
- Botão **Atualizar** da listagem: relê o banco e reaproveita o último ciclo (nenhum SELECT extra);
  troca de período / pós-ação: relê o snapshot (SELECT local). Nunca o HITS.
- `HITS_RECONCILIAR_CANCELADAS_AO_VIVO = false`: a reconciliação de canceladas pelo detalhe HITS
  (que abria GETs no gateway a partir do navegador) fica desligada. Código mantido para rollback.
  Quando voltar, deve rodar no scheduler.

## 6. Aplicar em HOMO (operador, via `!` — a política do repo nega `supabase`/`curl` ao agente)

Pré-requisitos já existentes em HOMO: migration do scheduler aplicada (ticks a cada 10 min),
`HITS_GATEWAY_URL` = gateway HOMO, `HITS_GATEWAY_READ_ENABLED=true`.

```bash
# 1) Migration — só HOMO
npx supabase db push --project-ref kzprrnbafamuozhyikgb --include-all --dry-run   # conferir que só 20260924180000 é nova
npx supabase db push --project-ref kzprrnbafamuozhyikgb

# 2) Edge — só HOMO (mesma função, código novo; sem a env continua igual ao anterior)
npx supabase functions deploy hits-reservations-preview --project-ref kzprrnbafamuozhyikgb

# 3) Trava de escrita do snapshot — só HOMO
npx supabase secrets set --project-ref kzprrnbafamuozhyikgb HITS_SNAPSHOT_WRITE_ENABLED=true

# 4) Esperar o próximo tick (*/10 11-23 UTC) e conferir
#    - Logs da Edge: "[HITS_RESERVATIONS_PREVIEW] ok { ..., snapshot: { persisted: true, ... } }"
#    - SQL Editor HOMO: scripts/sql/hits-snapshot-homo-verificacao.sql (blocos 1–4)

# 5) Front — Vercel Preview da branch (nunca Production). Push da branch pelo operador:
git push -u origin feat/hits-snapshot-homo
#    O preview usa YES_HOTEL_SUPABASE_URL/ANON_KEY de HOMO (scripts/generate-yes-supabase-config.mjs falha fechado se apontar a PROD).
```

Rollback HOMO: `npx supabase secrets unset --project-ref kzprrnbafamuozhyikgb HITS_SNAPSHOT_WRITE_ENABLED`
(a Edge volta ao comportamento anterior; tabelas podem ficar). Front: usar a Production atual (main).

## 7. Teste manual em HOMO (desktop e celular)

1. Abrir o Preview da branch → login recepção/admin → Operação.
2. DevTools → Network: filtrar `hits-reservations-preview` → **0 requisições**; filtrar `rest/v1/hits_` →
   2 requisições (`hits_reservas_snapshot`, `hits_snapshot_sync_state`), cada uma < 500 ms.
3. Barra HITS: badge "Conectado", "N reservas · sincronizado HH:MM".
4. Período "Este mês" / "Hoje" / "7 dias" e Status "Todos": linhas "HITS · leitura" aparecem conforme `check_in`.
5. "Ver diagnóstico": tabela com idReservation/Apto/Hóspede/Entrada/Saída/Status/Hóspedes.
6. Clicar **Atualizar** 5×: Network não mostra nenhuma chamada nova à Edge; no máximo o SELECT de `operacional_reservas`.
7. Recarregar a página 5×: idem — journal do gateway HOMO não recebe nenhuma requisição fora dos ticks.
8. Perfil `hits_consulta`: mesmas linhas "HITS · leitura", sem financeiro/contatos; diagnóstico removido.
9. Falha simulada (bloco 5 do SQL): recarregar → dados continuam + aviso âmbar "última sincronização com HITS falhou — exibindo dados de HH:MM". Após o próximo tick, volta a "sincronizado".
10. Celular (390 px): barra HITS quebra em duas linhas sem esconder o aviso; grade em cards.

## 8. Testes automatizados

```
npm run test:hits-snapshot-sync          # módulo puro: decisão, allowlist, start→apply|fail (14 casos)
npm run test:hits-snapshot-migration     # SQL/Edge/UI: RLS, grants, allowlist, sem Edge na UI, cron intacto (17 casos)
npm run test:hits-sandbox-operacional-ui # UI lê snapshot, 0 fetch, saúde, guards (47 casos)
npm run test:hits-gateway-read           # leitura pelo gateway inalterada (41 casos)
tsx scripts/test-hits-reservations-preview-scheduler-cron.ts
tsx scripts/test-hits-edge-deno-imports.ts
```

## 9. Riscos restantes / follow-ups

- Reconciliação de canceladas (banco × HITS) fica desligada na tela; em PROD não havia reservas
  materializadas do HITS, então sem efeito hoje. Follow-up: mover para o scheduler.
- Janela do snapshot = janela default da Edge em UTC (hoje UTC −30 … +30 dias; Status=3 até +1 dia).
  Depois das 20:00 em Campo Grande, o "hoje" UTC já é amanhã: reservas com check-out hoje somem
  do snapshot à noite (comportamento igual ao do cron atual). A grade filtra por período local.
- Teto de 50 reservas por status/leitura (`HITS_LIST_MAX_RESERVATIONS`): acima disso o snapshot
  fica truncado (`last_stopped_reason = max_reservations`), igual à leitura ao vivo.
- Tick > 150 s ainda pode ser morto pelo runtime antes do `apply` → estado fica `running` e o
  snapshot anterior permanece (a UI mostra "desatualizado" após 30 min). Mitigação futura: orçamento
  de tempo na Edge.
