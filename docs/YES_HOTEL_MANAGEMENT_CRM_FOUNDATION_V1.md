# Yes Hotel — Fundação Gestão + CRM v1

## Decisão

HITS permanece PMS. Gestão/CRM usam **modelo canônico Yes** (`CanonicalReservationInput`). Payload HITS só entra por mapper futuro. Sem migration nesta fase. Sem alteração operacional.

## Camadas

```
src/lib/management/   domínio BI (temporal, canal, métricas, forecast, alertas)
src/lib/crm/          identidade, recorrência, LTV, empresa B2B
adapter opcional      SyncedReservation (Yes) → canônico  — NÃO é mapper HITS
```

## Datas

Separar: criação da reserva (`bookedAt`) ≠ check-in ≠ checkout ≠ noite de estadia ≠ pagamento ≠ competência. Pickup exige **snapshot as-of × stayDate**.

## Identidade

CPF (BR) ou passaporte (estrangeiro). E-mail/telefone não são chave. Compatível com FNRH `documento_tipo` cpf|passport.

Jornadas distintas: OTA→direto vs B2B→direto. Booking Engine é direto, nunca OTA.

## Inventário

40 apartamentos vendáveis; bloqueios futuros reduzem o denominador de ocupação/RevPAR.

## Gaps HITS (não inventar)

criação da reserva, comissão/custo de canal, catálogo estável de channel id, no-show vs cancel, competência financeira, empresa com ID estável, série histórica de OTB.
