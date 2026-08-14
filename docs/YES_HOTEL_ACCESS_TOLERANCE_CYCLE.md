# Ciclo operacional — tolerância / suspensão / comunicações

## Escopo deste PR (local)

Fecha o ciclo pós-primeiro acesso: processar tolerâncias vencidas, revalidar pendências, suspender/restaurar a **mesma** senha via `changeKeyboardPassword` (sem `newKeyboardPwd`), consumir `operacional_acesso_outbox`, exibir só problemas na tela operacional.

## O que é real / o que não é

| Capacidade | Estado neste PR |
|------------|-----------------|
| Processador de tolerâncias | Código pronto; cron `yes-hotel-access-tolerance-process` (`mode=process`) |
| Efeito TTLock (suspender/restaurar) | Só com flag TTLock + lock homologado + dry-run efetivo false **no servidor** |
| Dry-run | **Default**; cliente não força execução real com `dry_run=false` |
| DigiSac WhatsApp | Adapter real existe; **default desligado**; exige flag + `DIGISAC_USE_MOCK=false` + credenciais |
| Resend e-mail | Adapter real existe; **default desligado**; exige flag + `RESEND_API_KEY` + from |
| Mock de envio | **Somente injeção explícita em testes** — nunca fallback silencioso |
| Ações manuais na UI/Edge | **Removidas** (501) até existir auditoria append-only dedicada |
| HITS pagamento | **Não chamada**; port `ReservationPendingStatePort` (pagamento desconhecido **não suspende**) |
| Cron process | `yes-hotel-access-tolerance-process` a cada 1 min (`mode=process`) |
| Cron dispatch | `yes-hotel-access-outbox-dispatch` a cada 1 min (`mode=dispatch`) — job separado |

## Feature flags (default `false`)

| Variável | Efeito |
|----------|--------|
| `YES_HOTEL_ACCESS_TOLERANCE_PROCESSOR_ENABLED` | Processa due/restore |
| `YES_HOTEL_TTLOCK_SUSPENSION_ENABLED` | Permite efeito TTLock real (ainda exige homolog lock) |
| `YES_HOTEL_ACCESS_OUTBOX_DISPATCH_ENABLED` | Consome outbox |
| `YES_HOTEL_ACCESS_DIGISAC_REAL_ENABLED` | WhatsApp real (ainda exige `DIGISAC_USE_MOCK=false` + config) |
| `YES_HOTEL_ACCESS_EMAIL_REAL_ENABLED` | E-mail real (exige `RESEND_API_KEY` + from) |
| `YES_HOTEL_TTLOCK_HOMOLOG_LOCK_ID` | **Obrigatório** para execução TTLock real (fail-closed se ausente) |
| `YES_HOTEL_DIGISAC_INTERNAL_NUMBER` | Número interno DigiSac (recepção) |

Ver `.env.example`. **Não ativar em produção sem gate humano.**

## Regras de pagamento (enquanto HITS não estiver disponível)

- `pago` → regular
- `pendente` / `parcial` / `emergencial` → pendência (pode suspender após tolerância)
- `desconhecido` / erro / indisponibilidade → **não suspende**; alerta interno idempotente; senha permanece ativa

## Gatilho

Edge Function: `supabase/functions/access-tolerance-processor`

- Auth batch: `Bearer <service_role>` ou `x-access-tolerance-token` (comparação constant-time)
- `mode=manual`: desabilitado (`manual_actions_disabled`) — sem tabela de auditoria TTLock compatível
- Cron process: `yes-hotel-access-tolerance-process` → `mode=process` (migration `20260814003954_access_tolerance_process_cron.sql`)
- Cron dispatch permanece separado: `yes-hotel-access-outbox-dispatch` → `mode=dispatch`
- Efeito TTLock real continua fail-closed: flag TTLock + `YES_HOTEL_TTLOCK_HOMOLOG_LOCK_ID` + dry-run efetivo false

## Dívida técnica registrada

1. **FNRH:** processador usa política formal. Cálculo legado de envio inicial de senha **não** unificado neste PR.
2. **RLS:** risco legado em `operacional_credenciais_acesso` — PR separado.
3. **Pagamento:** port atual; HITS real continua desligada.
4. **Ações manuais:** dependem de migration/tabela append-only futura (não criada neste PR).
5. **Reclaim:** usa `updated_at` / `available_at` como lease implícito (sem migration).

## Migrations

- `20260811220053_access_outbox_dispatch_cron.sql` — dispatch (não processa tolerâncias)
- `20260814003954_access_tolerance_process_cron.sql` — process (não despacha outbox)
