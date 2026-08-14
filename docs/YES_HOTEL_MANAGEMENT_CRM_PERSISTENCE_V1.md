# Persistência Gestão + CRM V1 (proposta)

Arquivo SQL (não aplicar): `docs/sql/management_crm_persistence_v1_proposal.sql`.

Fora de `supabase/migrations/`. Sem trigger em `operacional_*`. Sem FK operacional.

## Ajustes do migration review

- `service_role`: `GRANT SELECT, INSERT, UPDATE, DELETE` nas tabelas `crm_*` e `management_*`. `authenticated` permanece só SELECT (RLS).
- Canal em `management_reservations`: `channel_code = booking_engine` ⇒ `channel_kind = booking_engine`; `channel_code = booking` ⇒ `channel_kind = ota`. Booking Engine ≠ Booking OTA.
- HITS: `CHECK (source_system <> 'hits' OR source_reservation_id IS NOT NULL)`. Manual pode sem ID.
- Estadia: `nights = scheduled_checkout_date - scheduled_checkin_date` e checkout > checkin. Sem trigger.
- RLS: `management_crm_staff_can_read()` é `SECURITY INVOKER`, `search_path = public`, revoke de PUBLIC; admin/recepção ativos.

## Job de snapshot (desenho, não implementar)

- Frequência MVP: 1× ao dia, slot `eod`.
- Horário sugerido: 23:30 America/Campo_Grande.
- Idempotência: unique `(as_of_date, stay_date, as_of_slot)`.
- Fail-closed: se fonte HITS/sync indisponível, **não gravar** snapshot do dia; alertar. Não inventar OTB.
- Não `UPDATE` de `as_of` histórico; novo slot (`midday`/`manual`) se precisar de segunda foto.
- Horizonte a materializar: stay_date de D0 até D+90 (cobre OTB 7/14/30/60/90).

## Materialização

| Persistir | Derivar em query | Materializar depois |
|---|---|---|
| reservas, estadias, hóspedes, empresas, snapshots, inventory, eventos, receivables, custos conhecidos | ADR/RevPAR/ocupação/aging/pickup/LTV | dashboards pesados / YoY |

## Inventário

Tabela diária incluída (não hardcodar 40 para sempre). Seed futuro: 40 vendáveis por dia até haver bloqueios.
