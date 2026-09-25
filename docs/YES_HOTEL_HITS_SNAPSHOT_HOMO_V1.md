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
`last_failed_count`, `last_success_at`, `last_success_batch_id`, `last_success_rows_count`,
`last_cursor_at` e, desde `20260927090000_hits_snapshot_telemetria.sql`, os contadores por etapa.

**Telemetria do ciclo (semântica inequívoca).** `last_rows_count` **não** é "reservas alteradas": na
incremental a mesma reserva volta em vários ciclos e a linha é reenviada mesmo idêntica.

| campo | significado |
|---|---|
| `last_rows_count` | COMPATIBILIDADE: linhas processadas/submetidas (upsertadas) no ciclo, idênticas incluídas (= `last_upserted_count`) |
| `last_success_rows_count` | COMPATIBILIDADE: mesmo valor no último ciclo ok/partial |
| `last_returned_count` | ids únicos devolvidos pela listagem HITS (após dedupe) = detalhes lidos + falhas |
| `last_detail_count` | GETs de detalhe HITS concluídos com sucesso = linhas candidatas + canceladas explícitas (o status 2 é confirmado **no detalhe**, cada cancelada custou um GET); falhas nunca entram |
| `last_upserted_count` | linhas enviadas/upsertadas no snapshot |
| `last_changed_count` | linhas cujo **conteúdo funcional realmente mudou**: nova, ou `apartamento`/`hospede_principal`/`check_in`/`check_out`/`status_reserva`/`ciclo_hits`/`total_hospedes` diferentes do armazenado (comparação feita pela RPC antes do upsert; `batch_id`/`last_seen_at`/`updated_at` não contam) |
| `last_removed_count` | removidas do snapshot (completa: ausentes do lote e não falhas; incremental: canceladas explícitas) |
| `last_failed_count` | detalhes que falharam no ciclo |

A resposta/log da Edge expõe o mesmo em `snapshot.returned_count`, `detail_count`, `rows_upserted`,
`rows_changed`, `rows_removed`, `failed_count`.

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

## 8b. Cadência e orçamento de tempo do ciclo (branch `fix/hits-read-cadence`)

Por quê: o gateway limita a **60 req/min por IP de origem** (`@fastify/rate-limit`, `services/hits-gateway/src/app.ts`) e toda a Edge sai pelo mesmo egresso do Supabase. Sem cadência, ~75 requisições sequenciais a ~1 s de latência batiam no limite → 429 `rate_limited` em reservas aleatórias, e o retry (Retry-After cortado em 30 s) caía na mesma janela de 60 s → 2º 429 → detalhe marcado como falho.

O que mudou (`src/lib/integrations/hits/hits-gateway-read.ts` + `transport.ts`):

- **Cadência** `HITS_GATEWAY_MIN_INTERVAL_MS = 1 100 ms` entre **inícios** de requisição ao gateway — listagens, detalhes e retries (o transporte chama o fetch cadenciado a cada tentativa). Não é sleep após a resposta: se a chamada anterior demorou ≥ 1 100 ms, a próxima sai na hora; se demorou 900 ms, espera só 200 ms. ≈ 54 req/min, folga de 5/min para outros chamadores.
- **Orçamento** `HITS_READ_TIME_BUDGET_MS = 110 000 ms` medido do início da rodada. Antes de cada listagem/detalhe/retry o orçamento restante é verificado; nenhuma espera (cadência ou backoff) é feita se não couber no prazo (`deadlineMs` no transporte → desiste em vez de dormir além do prazo).
- Ao estourar o orçamento: `stopped_reason = "time_budget"`; ids ainda não lidos entram em `failed` com código `time_budget` → a RPC `apply` os trata como qualquer detalhe falho e **preserva a fotografia anterior**; `last_status = partial`. Nunca vira erro geral.
- Caso raro: orçamento acaba **antes de a listagem terminar** → `listing_complete = false`; o sync **não** chama `apply` (o conjunto de ids é desconhecido e a remoção apagaria reservas válidas) e registra `hits_snapshot_sync_fail` com "listagem incompleta; snapshot anterior preservado".
- Resposta da Edge ganha `listing_complete` e `elapsed_ms`; `count`, `pages_fetched`, `failed`, `stopped_reason` e o snapshot continuam iguais.
- Relógio e sleep injetáveis (`nowMs`, `sleepImpl`) — os testes rodam sem timers reais.

Impacto esperado: piso de N × 1,1 s (≈ 83 s para 75 requisições); custo adicional ≈ 0 quando a latência já é ≥ 1,1 s; sem os sonos de 30 s do retry → ciclo ≈ 80–95 s, sempre encerrado antes dos 150 s.

Teste: `npm run test:hits-read-cadence` (15 casos) + suítes existentes.

## 8c. Sincronização incremental — Type=2 (branch `feat/hits-incremental-sync`)

Por quê: a leitura completa custa ~75 requisições a cada 10 min mesmo sem nada ter mudado. O endpoint de listagem aceita `Type=2` = *Search for Reservation Update Date* (contrato §6.1), encaminhado pelo gateway com `Status`, `InitialDate`, `FinalDate`, `Page`, `Size` (`services/hits-gateway/src/query.ts` — allowlist; datas **só** `YYYY-MM-DD`).

Fluxo por ciclo (`runHitsSnapshotSync` com `readState` + `readIncremental`, só quando `HITS_SNAPSHOT_INCREMENTAL_ENABLED=true`):

1. lê `last_cursor_at` (linha única de `hits_snapshot_sync_state`, service_role, só leitura);
2. **modo**: sem cursor (ou ilegível) → **carga completa inicial** (Type=0, igual ao anterior; ao terminar `ok`, `hits_snapshot_sync_set_cursor` fixa o cursor no início do ciclo). Com cursor válido → **incremental, sempre**. **Não há completa periódica automática**; a completa continua disponível como fallback (cursor nulo) ou pela chamada sem a trava;
3. **janela** (dias no calendário; o gateway/HITS só aceitam `YYYY-MM-DD`), no fuso do hotel (UTC−4 fixo, mesma premissa do scheduler): `InitialDate = dia local de (cursor − 60 min)` — na maior parte do dia é o próprio dia do cursor; só na primeira hora após a meia-noite local inclui o dia anterior (virada + margem de fuso). `FinalDate = dia local de agora + 1` — os carimbos do HITS observados vêm em −03:00 (fixture real), 1 h à frente de Campo Grande: à noite o HITS já está no dia seguinte e, sem o +1, alterações entre 23:00 e 24:00 locais só apareceriam após a virada;
4. **listagem**: `Type=2` para Status 1, 2 e 3 (3 requisições mínimas; Blocked fora), paginação e teto iguais; sumário com check-out anterior ao dia operacional não custa detalhe;
5. **detalhes** só dos ids devolvidos (dedupe entre status/páginas). 0 alterações → 0 detalhes;
6. **apply incremental** (`hits_snapshot_sync_apply_incremental`, transação): upsert só das alteradas; **remove só canceladas explícitas** (status 2 no detalhe → `p_cancelled_ids`); **nunca remove por ausência**; detalhe falho → `p_failed_ids` (fotografia anterior preservada, `partial`); **cursor avança só em `ok`** (em `partial` a próxima janela recobre os ids falhos); listagem incompleta por orçamento → só `fail`, nada aplicado, cursor parado.
7. Cadência 1 100 ms, orçamento 110 s, retries, zero escrita no HITS: os mesmos do núcleo de leitura (`runGatewayRead`).

**Custo da granularidade diária (documentado):** a cada ciclo o HITS devolve **todas** as reservas atualizadas nos dias da janela (normalmente só o dia corrente) e cada uma custa 1 detalhe — repetido a cada 10 min enquanto o dia não vira. Teto de detalhes por ciclo = nº de reservas tocadas no dia (na 1ª hora após a meia-noite, também as de ontem). A listagem **não traz `dateUp`** (só o detalhe), então não há como cortar por hora sem o detalhe. Se um processo do HITS tocar todas as reservas de uma vez (ex.: rotina noturna), a incremental relê o mesmo volume da completa naquele dia — observar `calls_detalhe` no journal.

Limitação aceita: reservas que saem da janela sem mudar (check-out natural, `dateUp` inalterado) não são removidas do snapshot pela incremental; a UI já as filtra por período. Uma limpeza dessas linhas fica para uma rodada própria (não há completa automática).

Migration `20260925090000_hits_snapshot_incremental.sql` (mínima): coluna `last_cursor_at`; RPCs `hits_snapshot_sync_set_cursor(batch, cursor)` e `hits_snapshot_sync_apply_incremental(...)` (service_role). A RPC completa fica intocada. Sem a env, o comportamento é o anterior (rollback = `secrets unset HITS_SNAPSHOT_INCREMENTAL_ENABLED`).

Teste: `npm run test:hits-incremental-sync` (19 casos).

## 8d. Universo operacional = snapshot HITS (branch `fix/hits-universo-operacional`)

Regra: **o HITS decide quais reservas existem operacionalmente; o Yes só enriquece.** Implementada na UI (`ui/checkin-operacional-mvp.js`), sem migration:

- `carregarUniversoHits(base, options)`: lê o último ciclo do snapshot (nunca o HITS ao vivo). `gate=true` quando o ciclo está `ok` e já houve sincronização; `gate=false` (snapshot indisponível / nunca sincronizado) → fail-open: a tela mantém o banco e a barra HITS avisa.
- `aplicarUniversoHits(base, universo)`: com gate, linha local só entra se `external_reservation_id` está no snapshot (fantasmas HOMO e linhas sem id ficam só no banco); apto e datas vêm do HITS; reserva só no snapshot entra como "HITS · leitura". É o único merge — Reservas, Exceções, KPIs e contadores derivam de `reservas`.
- `aplicarUniversoHitsChegadas(items, universo)`: a aba Chegadas passa a usar o mesmo universo (antes lia só `operacional_reservas`), inclusive no perfil `hits_consulta`.
- Canceladas: a incremental remove a linha do snapshot → some da operação sem reconciliação nova. Nada é apagado do banco.
- Financeiro (`hits-reserva-materializar`): `pagamento_status`, `reservation_balance_due`, `reservation_total_amount` e `classificacao_comissionamento` passam a ser gravados a partir do detalhe HITS normalizado (regra do domínio: saldo ≤ 0 → pago). Reserva materializada antes disso recebe o financeiro **uma vez** (backfill guardado por saldo nulo) na próxima chamada da Edge para o seu id.

## 8e. Materialização automática (sem envio) e Café sob o universo HITS (branch `fix/hits-auto-materializacao-cafe-universo`)

**Materialização automática — MATERIALIZAR ≠ ENVIAR.**
- Helper compartilhado `src/lib/integrations/hits/hits-materializar.ts` (`materializarReservaSincronizada`): a escrita que já existia em `hits-reserva-materializar` (reserva por `(origem_externa, external_reservation_id)`, hóspedes por `(reserva_id, pms_external_guest_id)`, posições sem PAX, financeiro no insert + backfill único). Sem rede, sem HITS, sem envio. A Edge sob demanda continua existindo e usa o mesmo helper.
- Edge `hits-reservations-preview`, trava `HITS_AUTO_MATERIALIZAR_ENABLED=true` (**desligada por padrão**): ao fim de um ciclo que gravou o snapshot, para cada reserva **ativa** lida no ciclo cujo id **não** existe em `operacional_reservas`, chama o helper com o detalhe **já lido** (`onDetail` do leitor → zero GET extra ao HITS). Teto de 20 por ciclo; erros contados, não derrubam o tick; incremental/cadência/orçamento intactos.
- UI: linha só-snapshot é **sempre** estado transitório — "Sincronizando com o HITS", sem CTA (o vínculo nasce no próximo ciclo). "Preparar FNRH" deixa de ser o caminho normal; `acaoPrepararFnrhHits` e o roteador `preparar_fnrh` permanecem só como contingência interna. Sem feature flag na UI.
- **Preflight (ver `Claude outputs/hits-auto-materializacao-cafe-rodada1-entrega.md`)**: inserir reserva/hóspede não dispara comunicação por trigger, webhook do repo ou Edge; o único caminho automático de envio ligado a *existir uma reserva com check-in hoje* seria `senha-auto-envio` (modo 13h). **Confirmado em PROD (2026-09-26): `cron.job` não tem nenhum job de senha/`senha-auto`/`send-senha` (0 linhas)** — a trava pode ser ligada após merge/deploy/bootstrap.

**Café da manhã — o HITS decide quem está hospedado** (migration `20260926090000_cafe_universo_hits.sql`, só `CREATE OR REPLACE` de `operacional_cafe_listar_hospedagens`):
- população = `hits_reservas_snapshot` (ativas) com `check_in < D <= check_out` (datas e apartamento do HITS), `LEFT JOIN operacional_reservas` para enriquecer (id operacional, `meal_plan_desc`, pagamento/PPD). Fantasma local fora do snapshot não aparece; reserva HITS ainda não materializada aparece com `reservation_id` NULL (a UI usa id sintético `hits:<id>` e não grava atendimento até a materialização).
- snapshot sem sucesso há mais de 6 h (ou nunca) → a RPC **erra** com mensagem explícita; a tela mostra o erro e nenhuma população antiga.
- Direito ao café (`resolveCafeBreakfastEntitlementFromHits`, `mealPlanDesc`, `cafe_kind`, `quantidade_direito`, KPI "Cafés previstos") **intocado**.

**Posição técnica adotada pelo PAX HITS (correção 3407).** Quando a reserva foi materializada antes de o HITS ter a entidade do hóspede, o passo 4 criou uma posição técnica ("Novo hóspede", sem `pms_external_guest_id`). Ao PAX aparecer no HITS, o passo 3 procura a **posição técnica segura** da reserva (`encontrarPosicaoTecnicaSegura`: sem idEntity, nome/origem/status técnicos, não principal, não removida, sem contato, ficha `fnrh_hospedes` — apenas **lida** — em `pendente` sem lifecycle iniciado). **Exatamente 1** candidata → `UPDATE` de identificação na **mesma** linha (ficha/`link_token` preservados); 0 → insere como antes; >1 → ambíguo: não escolhe, não adota, **não insere** hóspede novo, não altera as candidatas; reporta `ocupacao.posicoes_ambiguas` e `intervencao_manual = true` (exige intervenção manual; o ciclo segue). Pessoa real sem idEntity ou ficha tocada nunca é fundida. Não reconcilia retroativamente linhas já duplicadas (decisão do operador). **FNRH concluída no HITS: não existe no contrato atualmente disponível sinal confiável** — nenhuma heurística (`status=3`, `rooms[].status`, "check-in realizado") foi implementada (teste D). Relatório: `Claude outputs/hits-3407-posicao-tecnica-rodada2-entrega.md`.

Testes: `npm run test:hits-auto-materializacao` (18) · `npm run test:cafe-universo-hits` (10).

## 8f. Contato do hóspede pelo celular oficial (branch `fix/hits-contato-celular-oficial`)

O detalhe da reserva (`ReservationDetailGuestDto`) **não** expõe celular — só `contactPhone`/`contactMail`. O celular é `contactCellPhone`, exclusivo do `GuestRevenueDto` (`GET /v1/guests?EntityId=…`, contrato §8.4.1). Por isso o ciclo enriquece o contato pelo **guest master**, de forma direcionada:

- **quem consulta**: reserva nova que será materializada agora; e hóspede já materializado que pode melhorar (WhatsApp vazio, WhatsApp que não é celular, ou e-mail vazio) **e** com ficha FNRH ainda intocada. Quem já tem celular + e-mail, ou já preencheu a FNRH, não gera consulta;
- **quanto custa**: ids deduplicados, teto `HITS_GUEST_LOOKUP_MAX_POR_CICLO` (10) por ciclo, orçamento próprio de 20 s com prazo absoluto de 130 s desde o início do tick, mesma cadência de 1 100 ms — nunca N+1 sobre o universo. O que não coube volta no ciclo seguinte;
- **prioridade**: WhatsApp = `contactCellPhone` → `contactPhone` → `contactPhone` do detalhe; e-mail = `contactMail` do guest master → do detalhe;
- **reserva já materializada**: caminho dedicado (`reconciliarContatosDaReserva`) que escreve **somente** `operacional_hospedes.whatsapp`/`email`. Celular oficial substitui fixo; celular nunca é rebaixado; e-mail só preenche vazio; ficha FNRH tocada bloqueia qualquer escrita;
- a classificação de número brasileiro (DDD + 9 dígitos) deixou de ser fonte: serve só como proteção do dado local.

Testes: `npm run test:hits-contato-preferencia` (23).

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
