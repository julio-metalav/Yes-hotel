# First Room Access — transação integral (PR5)

## Fronteira domínio × RPC

| Camada | Responsabilidade |
|---|---|
| Domínio / orquestrador | Correlação, policy de evento, pendências, decisão, payload da mensagem |
| RPC `yes_hotel_process_first_room_access` | Persistência atômica + validações defensivas SQL |

O TypeScript **não** faz múltiplos inserts “como se fossem” transação.

## Contrato

Entrada principal: `p_decision` ∈ `ignored | processed_no_pending | grace_started | already_started`
+ campos do evento, correlação, grace, `p_items` (exatamente 3), `p_outbox_event` sanitizado.

Retorno JSON: `status`, `event_id`, `tolerance_id?`, `suspension_due_at?`, `pending_reasons?`, `ignored_reason?`.

## Atomicidade

Em `grace_started`, numa única transação:

1. insert evento  
2. create tolerância  
3. create 3 itens  
4. insert outbox (`operacional_acesso_outbox`)  
5. mark processed  

Qualquer falha → rollback integral. **Não há fallback multi-insert.**

## Outbox

Tabela nova: `operacional_acesso_outbox` (fila).  
`operacional_comunicacao_envios` permanece histórico de envios — inadequada como fila (sem `idempotency_key` unique / status pending).

Idempotência outbox: `unique(idempotency_key)` — ex. `welcome:{credential_id}:{grace_started_at}`.

Worker/cron de envio: **fora deste PR**.

## 0023

`yes_hotel_create_access_tolerance` fica **obsoleta** para o fluxo completo; mantida por compatibilidade. Preferir a RPC 0025.

## Migrations (não aplicadas)

0022 (tabelas) → 0023 (RPC parcial) → 0024 (FNRH roles) → **0025 (RPC integral + outbox)**.

## Por que não ativar

- Migrations não aplicadas  
- Schema FNRH (0024) não aplicado  
- Sem worker de outbox  
- Sem homologação de suspensão  
- Flag TTLock off  

## Adapter

`SupabaseFirstRoomAccessUnitOfWork.commitFirstRoomAccess` → uma chamada RPC.  
Se a função não existir: erro explícito (não sucesso).
