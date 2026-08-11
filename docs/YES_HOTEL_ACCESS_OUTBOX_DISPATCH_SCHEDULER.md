# Scheduler — despacho da outbox de acesso

## Objetivo

Invocar automaticamente a Edge `access-tolerance-processor` em `mode=dispatch`
para enviar itens pendentes de `operacional_acesso_outbox` (ex.: `internal_first_access`
→ DigiSac número interno), sem ação humana após o primeiro acesso TTLock.

## Gate importante

| Flag | Necessária para despachar outbox? |
|------|-----------------------------------|
| `YES_HOTEL_ACCESS_OUTBOX_DISPATCH_ENABLED` | **Sim** |
| `YES_HOTEL_ACCESS_DIGISAC_REAL_ENABLED` + `DIGISAC_USE_MOCK=false` | **Sim** (WhatsApp) |
| `YES_HOTEL_DIGISAC_INTERNAL_NUMBER` | **Sim** (destino interno) |
| `YES_HOTEL_ACCESS_TOLERANCE_PROCESSOR_ENABLED` | **Não** — só processa tolerâncias/suspensão |

## Mecanismo

1. Edge HTTP `access-tolerance-processor` (`verify_jwt=false`, auth própria)
2. Token `ACCESS_TOLERANCE_PROCESSOR_TOKEN` (header `x-access-tolerance-token`)
3. `pg_cron` + `pg_net` → a cada 1 minuto
4. Secrets do cron no **Vault** (não no Git):
   - `access_tolerance_processor_token`
   - `yes_hotel_edge_anon_key`

Migration: `20260811220053_access_outbox_dispatch_cron.sql`

## Body do cron

```json
{"mode":"dispatch","limit":20}
```

Idempotente: claim na outbox; fila vazia = `dispatch_count=0` sem erro.
