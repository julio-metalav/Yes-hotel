# Scheduler — processamento automático de tolerâncias

## Objetivo

Invocar automaticamente a Edge `access-tolerance-processor` em `mode=process`
para vencer tolerâncias (`standard_1h` e `presencial_diferido_09h` via `suspension_due_at`)
e restaurar/cancelar quando o pagamento regularizar.

## Gate importante

| Flag | Necessária para processar? |
|------|----------------------------|
| `YES_HOTEL_ACCESS_TOLERANCE_PROCESSOR_ENABLED` | **Sim** |
| `YES_HOTEL_TTLOCK_SUSPENSION_ENABLED` | **Sim** para efeito físico |
| `YES_HOTEL_TTLOCK_HOMOLOG_LOCK_ID` | **Sim** para efeito físico (fail-closed; só essa lock) |
| `YES_HOTEL_ACCESS_OUTBOX_DISPATCH_ENABLED` | **Não** — dispatch é job separado |

`dry_run=false` no body do cron **não** relaxa o gate de homologação.

## Mecanismo

1. Edge HTTP `access-tolerance-processor` (`verify_jwt=false`, auth própria)
2. Token `ACCESS_TOLERANCE_PROCESSOR_TOKEN` (header `x-access-tolerance-token`)
3. `pg_cron` + `pg_net` → a cada 1 minuto
4. Secrets do cron no **Vault** (não no Git):
   - `access_tolerance_processor_token`
   - `yes_hotel_edge_anon_key`

Migration: `20260814003954_access_tolerance_process_cron.sql`

Job: `yes-hotel-access-tolerance-process`

O job `yes-hotel-access-outbox-dispatch` **não** é alterado.

## Body do cron

```json
{"mode":"process","limit":20,"dry_run":false}
```

Idempotente: claim CAS na tolerância; fila vazia = `process_count=0` sem erro.
Mensagens vão para `operacional_acesso_outbox` e saem pelo cron de dispatch.
