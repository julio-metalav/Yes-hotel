# Yes Hotel — Sync HITS simulado + Chegadas + Card hospedados

Documento de implementação local. **HITS real continua desligada. Produção não usa este sync ainda.**

## O que existe no código

- Domínio de sync: `SyncedReservation`, `ReservationSourcePort`, diff/eventos
- Adapter mock: `HitsMockReservationSource` (sem rede)
- Serviço: `syncReservationsFromSource` (idempotente, página a página)
- Repositório em memória: testes + dry-run
- Repositório Supabase: `SupabaseReservationSyncRepository` (código pronto, **bloqueado por flags**)
- Edge: `supabase/functions/hits-reservation-sync`
- UI: aba Chegadas + card hospedados em `ui/checkin-operacional-mvp.*`
- Policy browser: `ui/yes-arrivals-policy.js` (testada via `node:vm`)

## Dry-run (default)

- `dry_run` default = true
- **Zero escrita** em `pms_*` / `operacional_*` / sync runs / eventos
- Resposta usa `wouldCreate` / `wouldUpdate` / `wouldCancel` / `wouldCreateEvents`
- `persistence: "dry_run_no_writes"`

## Persistência Supabase

Existe no código, mas **só executa** quando **todas** forem verdadeiras:

```
HITS_RESERVATION_SYNC_ENABLED=true
HITS_RESERVATION_SYNC_PERSISTENCE_ENABLED=true
HITS_RESERVATION_SCHEMA_READY=true
dry_run=false
```

Defaults: todas `false`.

Sem esses gates, a Edge responde 409:

- `reservation_sync_schema_not_ready`
- `reservation_sync_persistence_disabled`

A flag `HITS_RESERVATION_SCHEMA_READY` é gate humano: só ligar após aplicar a migration.

## Migration

Arquivo: `supabase/migrations/20260806163903_operacional_reservas_hits_sync_chegadas.sql`

- Amplia `pagamento_status` / `payment_mapped`: `pago|pendente|parcial|desconhecido`
- Adiciona `status_reserva` (`ativa|cancelada`, default `ativa`)
- Adiciona `synced_at`
- Índices para chegadas/hospedados

**Não aplicada neste PR.** Sem essa migration, não ligar `HITS_RESERVATION_SCHEMA_READY`.

## Flags

```
HITS_RESERVATION_SYNC_ENABLED=false
HITS_RESERVATION_SYNC_MODE=mock
HITS_RESERVATION_SYNC_BATCH_SIZE=100
HITS_RESERVATION_SYNC_INTERVAL_SECONDS=120
HITS_RESERVATION_SYNC_PERSISTENCE_ENABLED=false
HITS_RESERVATION_SCHEMA_READY=false
```

Sem cron. Intervalo é só preparação. Sem `NEXT_PUBLIC_*`.

## Aba Chegadas / Card

- Lê `operacional_reservas` / `operacional_hospedes` (consulta em lote, sem N+1)
- “Todas as futuras”: paginação **client-side** dentro do lote de até 500
- Se o lote atingir 500, a UI mostra aviso discreto (não é paginação completa do banco)
- Cancelamento recente em “Só com problemas”: evento `hits_reserva_cancelada` nas últimas 24h (não usa check-in como proxy)

## Pagamento desconhecido

| Valor | payment_pending | payment_unknown | Inicia tolerância sozinho | Suspende |
|-------|-----------------|-----------------|---------------------------|----------|
| pago | false | false | não | não |
| pendente | true | false | sim | sim (fluxo existente) |
| parcial | true | false | sim | sim |
| desconhecido | false | true | **não** | **não** |

`desconhecido + FNRH pendente` → tolerância pode iniciar **pela FNRH**.

## Conflito HITS × Hospedin

Sem reconciliação automática. Cada origem mantém sua chave. Migração definitiva exige decisão posterior.

## Workflow de ativação futuro (gate humano)

1. Auditoria + aprovação
2. Aplicar migration
3. Ligar `HITS_RESERVATION_SCHEMA_READY=true` no ambiente alvo
4. Homologar dry-run da Edge
5. Ligar `HITS_RESERVATION_SYNC_PERSISTENCE_ENABLED=true` + `HITS_RESERVATION_SYNC_ENABLED=true` só em homolog
6. Nunca ligar modo real enquanto `HITS_INTEGRATION_ENABLED=false`

## Testes

```bash
npm run test:ui-static-js
npm run test:hits-reservation-sync-chegadas
npm run test:yes:reservation-pending-state
npm run test:hits:integration-prep
npm run test:hits-mock:normal
npm run test:hits-mock:cancel
npm run test:hits-mock:room-change
npm run test:yes:access-tolerance-processor
npm run build
```
