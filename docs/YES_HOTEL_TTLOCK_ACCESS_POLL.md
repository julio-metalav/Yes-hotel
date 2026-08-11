# Polling TTLock — fallback Lock Records (first-room-access)

## Motivo

Callback Lock Records Notify **não entregou** evento físico confirmado no app
e presente em `/v3/lockRecord/list`. Fallback: polling oficial da Open API.

## Fluxo

1. Cron `yes-hotel-ttlock-access-poll` (~1 min) → Edge `ttlock-access-poller`
2. Lista locks candidatos (`yes_hotel_list_ttlock_poll_candidate_locks`)
3. Por lock: `/v3/lockRecord/list` com watermark (`operacional_ttlock_poll_checkpoints`)
4. Records com `lockDate > watermark` → `processFirstRoomAccessEvent` (`source=ttlock_polling`)
5. Mesma `idempotency_key` do Notify; outbox / DigiSac inalterados

## Flags / secrets

| Item | Valor |
|------|--------|
| `YES_HOTEL_TTLOCK_ACCESS_POLL_ENABLED` | `true` |
| `TTLOCK_ACCESS_IDEMPOTENCY_SECRET` | já existente |
| Credenciais TTLock | já existentes (API `api.sciener.com`) |
| Auth cron | `ACCESS_TOLERANCE_PROCESSOR_TOKEN` / vault |

## Checkpoint crítico

Lock `16274746` seed com `last_lock_date_ms = 1786487991000` (evento 18:39:51 CG).
Esse evento **não** é processado.

Locks novos sem checkpoint: bootstrap watermark=`now` (sem histórico).

## Cadência / volume

Só polla apartamentos com reserva `acesso_liberado`, `entrou_no_apto=false`,
credencial APT provisionada na validade — tipicamente poucos locks/min,
não o inventário completo de fechaduras.
