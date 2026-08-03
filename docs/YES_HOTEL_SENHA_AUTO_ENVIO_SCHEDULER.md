# Scheduler — liberação automática de credenciais (13h)

## Objetivo

Chamar diariamente a Edge Function `senha-auto-envio` após as 13h no fuso `America/Campo_Grande`, para liberar credenciais das reservas com check-in no dia.

## Mecanismo (padrão do projeto)

Mesmo padrão de `pms-hospedin-sync` / `fnrh-auto-reenvio`:

1. Edge Function HTTP invocável
2. Autenticação por token de scheduler / service role
3. Scheduler externo ou Supabase Cron (`pg_cron` + `pg_net`)

Artefato versionado (não aplicado): `supabase/pending/senha-auto-envio-cron.sql`.

## Endpoint

```http
POST {SUPABASE_URL}/functions/v1/senha-auto-envio
Content-Type: application/json
Authorization: Bearer {SUPABASE_SERVICE_ROLE_KEY}
x-senha-scheduler-token: {SENHA_SCHEDULER_TOKEN}

{"mode":"13h"}
```

Modes:

- `13h` — lote do dia a partir das 13h locais
- `retry` — reprocessa falhas (uma tentativa por reserva)

## Secrets / configuração (aplicar no ambiente, não no Git)

| Nome | Uso |
|------|-----|
| `SENHA_SCHEDULER_TOKEN` | Header `x-senha-scheduler-token` (recomendado) |
| `SUPABASE_SERVICE_ROLE_KEY` | Bearer no cron / runtime da function |
| `YES_HOTEL_TIMEZONE` | Default `America/Campo_Grande` |
| `RESEND_API_KEY` / DigiSac | Canais de envio já usados por `send-senha` |

## Idempotência

- Reservas com `senha_enviada_em` são ignoradas no envio automático
- Falha em uma reserva não aborta o lote
- Reexecução do cron no mesmo dia é segura

## Ativação posterior (homologação/produção)

1. Deploy da function `senha-auto-envio`
2. Definir `SENHA_SCHEDULER_TOKEN` no projeto
3. Revisar e aplicar `supabase/pending/senha-auto-envio-cron.sql` (ou criar job equivalente no Dashboard Scheduler)
4. Disparar uma chamada manual com `mode=13h` e validar o resumo JSON
5. Só então deixar o cron ativo

**Esta etapa não aplica o scheduler remoto.**
